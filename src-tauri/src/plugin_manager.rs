use chrono::{DateTime, Duration, Utc};
use parking_lot::Mutex;
use sandbox_engine::{
    Database, EngineError, InstalledPlugin, PluginInstallState, PluginRevocation, Workflow,
    WorkflowNode,
};
use sandbox_plugin_runtime::{
    permission_diff, permission_summary, validate_schema_instance, CapabilityBroker,
    CredentialOperationBroker, ExecutionContext, Manifest, NetworkTransport, PackageTrustStore,
    PluginError, PluginRuntime, PluginStorage, ReqwestTransport, RevocationList, RuntimeLimits,
    SandboxDiagnostic, StorageScope, VerifiedPackage, HOST_VERSION,
};
use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeSet, HashMap},
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Arc},
    time::Duration as StdDuration,
};
use uuid::Uuid;

const INSPECTION_LIFETIME_MINUTES: i64 = 10;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageTrustMetadata {
    pub publisher_id: String,
    pub key_id: String,
    pub publisher_public_key_pem: String,
    pub owner_type: String,
    pub owner_id: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPackageInspection {
    pub inspection_id: String,
    pub manifest: Manifest,
    pub requested_permissions: Vec<String>,
    pub permission_expansion: Vec<String>,
    pub expires_at: DateTime<Utc>,
    pub development: bool,
    pub signed_and_verified: bool,
}

#[derive(Debug, Clone)]
pub struct PluginExecutionResult {
    pub output: Value,
    pub diagnostics: Vec<SandboxDiagnostic>,
}

struct PendingInspection {
    bytes: Vec<u8>,
    trust: PackageTrustMetadata,
    manifest: Manifest,
    requested_permissions: Vec<String>,
    permission_expansion: Vec<String>,
    expires_at: DateTime<Utc>,
}

#[derive(Clone)]
pub struct PluginManager {
    database: Database,
    package_directory: PathBuf,
    pending: Arc<Mutex<HashMap<String, PendingInspection>>>,
    broker: Arc<CapabilityBroker>,
}

impl PluginManager {
    pub fn new(database: Database, package_directory: PathBuf) -> Result<Self, EngineError> {
        let network = Arc::new(ReqwestTransport::new().map_err(plugin)?);
        Self::with_host_services(
            database,
            package_directory,
            network,
            Arc::new(UnavailableCredentialOperations),
        )
    }

    pub fn with_host_services(
        database: Database,
        package_directory: PathBuf,
        network: Arc<dyn NetworkTransport>,
        credentials: Arc<dyn CredentialOperationBroker>,
    ) -> Result<Self, EngineError> {
        std::fs::create_dir_all(&package_directory).map_err(storage)?;
        let storage = Arc::new(DatabasePluginStorage {
            database: database.clone(),
        });
        Ok(Self {
            database,
            package_directory,
            pending: Arc::new(Mutex::new(HashMap::new())),
            broker: Arc::new(CapabilityBroker::new(network, credentials, storage)),
        })
    }

    pub fn inspect_path(
        &self,
        package_path: &Path,
        trust: PackageTrustMetadata,
    ) -> Result<PluginPackageInspection, EngineError> {
        let bytes = std::fs::read(package_path).map_err(storage)?;
        self.inspect_bytes(bytes, trust)
    }

    /// Installs a package compiled into the signed desktop distribution. The
    /// package still goes through the normal digest, Ed25519, manifest, and
    /// revocation checks; only the permission approval is automatic because
    /// these exact bytes are part of the host release.
    pub fn install_bundled(
        &self,
        bytes: &'static [u8],
        publisher_id: &str,
        key_id: &str,
        publisher_public_key_pem: &str,
    ) -> Result<InstalledPlugin, EngineError> {
        let inspection = self.inspect_bytes(
            bytes.to_vec(),
            PackageTrustMetadata {
                publisher_id: publisher_id.to_string(),
                key_id: key_id.to_string(),
                publisher_public_key_pem: publisher_public_key_pem.to_string(),
                owner_type: "personal".into(),
                owner_id: "local".into(),
                source: "private".into(),
            },
        )?;
        let installed = self.install_inspected(&inspection.inspection_id)?;
        let approved = self.database.approve_plugin_permissions(
            &installed.plugin_id,
            &installed.version,
            &installed.package_integrity,
            &installed.owner_type,
            &installed.owner_id,
        )?;
        self.database.set_plugin_enabled(
            &approved.plugin_id,
            &approved.version,
            &approved.package_integrity,
            &approved.owner_type,
            &approved.owner_id,
            true,
        )
    }

    pub fn inspect_bytes(
        &self,
        bytes: Vec<u8>,
        trust: PackageTrustMetadata,
    ) -> Result<PluginPackageInspection, EngineError> {
        validate_trust_metadata(&trust)?;
        let verified = self.verify(&bytes, &trust)?;
        let requested_permissions = permission_summary(&verified.manifest);
        let prior = self
            .database
            .list_installed_plugins(&trust.owner_type, &trust.owner_id)?
            .into_iter()
            .filter(|plugin| plugin.plugin_id == verified.manifest.plugin_id)
            .max_by_key(|plugin| plugin.installed_at);
        if let Some(prior) = &prior {
            if prior.version == verified.manifest.version.to_string()
                && prior.package_integrity != verified.digest
            {
                return Err(EngineError::Validation(format!(
                    "{} {} is already installed with a different immutable package digest.",
                    verified.manifest.plugin_id, verified.manifest.version
                )));
            }
        }
        let permission_expansion = prior
            .and_then(|plugin| serde_json::from_value::<Manifest>(plugin.manifest).ok())
            .map(|manifest| permission_diff(&manifest, &verified.manifest))
            .unwrap_or_else(|| requested_permissions.clone());
        let inspection_id = Uuid::new_v4().to_string();
        let expires_at = Utc::now() + Duration::minutes(INSPECTION_LIFETIME_MINUTES);
        let development = trust.source == "development";
        self.pending.lock().insert(
            inspection_id.clone(),
            PendingInspection {
                bytes,
                trust,
                manifest: verified.manifest.clone(),
                requested_permissions: requested_permissions.clone(),
                permission_expansion: permission_expansion.clone(),
                expires_at,
            },
        );
        Ok(PluginPackageInspection {
            inspection_id,
            manifest: verified.manifest,
            requested_permissions,
            permission_expansion,
            expires_at,
            development,
            signed_and_verified: true,
        })
    }

    pub fn install_inspected(&self, inspection_id: &str) -> Result<InstalledPlugin, EngineError> {
        let pending = self.pending.lock().remove(inspection_id).ok_or_else(|| {
            EngineError::Validation("The plugin inspection expired or was already used.".into())
        })?;
        if pending.expires_at < Utc::now() {
            return Err(EngineError::Validation(
                "The plugin inspection expired. Inspect the package again before installing."
                    .into(),
            ));
        }
        // Re-run every trust, integrity, compatibility, and revocation check at
        // installation time. The bytes are the exact in-memory bytes inspected.
        let verified = self.verify(&pending.bytes, &pending.trust)?;
        if verified.manifest != pending.manifest {
            return Err(EngineError::Validation(
                "The verified manifest changed between inspection and installation.".into(),
            ));
        }
        if let Some(existing) = self.database.get_installed_plugin(
            &verified.manifest.plugin_id,
            &verified.manifest.version.to_string(),
            &verified.digest,
            &pending.trust.owner_type,
            &pending.trust.owner_id,
        )? {
            return Ok(existing);
        }

        let destination = self.package_destination(&verified.manifest, &verified.digest);
        write_immutable(&destination, &pending.bytes)?;
        let now = Utc::now();
        let installed = InstalledPlugin {
            plugin_id: verified.manifest.plugin_id.clone(),
            version: verified.manifest.version.to_string(),
            package_integrity: verified.digest,
            publisher_id: verified.manifest.publisher_id.clone(),
            publisher_key_id: verified.manifest.signature.key_id.clone(),
            publisher_public_key_pem: Some(pending.trust.publisher_public_key_pem),
            owner_type: pending.trust.owner_type,
            owner_id: pending.trust.owner_id,
            source: pending.trust.source.clone(),
            development: pending.trust.source == "development",
            state: PluginInstallState::Disabled,
            manifest: serde_json::to_value(&verified.manifest).map_err(storage)?,
            requested_permissions: pending.requested_permissions,
            approved_permissions: vec![],
            update_requires_review: !pending.permission_expansion.is_empty(),
            package_path: destination.to_string_lossy().to_string(),
            installed_at: now,
            updated_at: now,
        };
        self.database.save_installed_plugin(&installed)?;
        Ok(installed)
    }

    pub fn apply_revocation(&self, revocation: PluginRevocation) -> Result<(), EngineError> {
        self.database.save_plugin_revocation(&revocation)
    }

    pub fn execute_node(
        &self,
        workflow: &Workflow,
        node: &WorkflowNode,
        execution_id: &str,
        input: Value,
        cancellation: Arc<AtomicBool>,
    ) -> Result<PluginExecutionResult, EngineError> {
        let pin = node.plugin.as_ref().ok_or_else(|| {
            EngineError::Node("The workflow node has no exact plugin package pin.".into())
        })?;
        let installed = self
            .database
            .get_installed_plugin(
                &pin.plugin_id,
                &pin.plugin_version,
                &pin.package_integrity,
                &workflow.owner.owner_type,
                &workflow.owner.owner_id,
            )?
            .ok_or_else(|| {
                EngineError::Node(format!(
                    "The pinned plugin {} {} is not installed for this workflow owner.",
                    pin.plugin_id, pin.plugin_version
                ))
            })?;
        if installed.state != PluginInstallState::Enabled {
            return Err(EngineError::Permission(format!(
                "Plugin {} {} is not enabled for this workflow owner.",
                installed.plugin_id, installed.version
            )));
        }
        if installed.requested_permissions != installed.approved_permissions
            || installed.update_requires_review
        {
            return Err(EngineError::Permission(
                "The exact plugin version has permissions awaiting review.".into(),
            ));
        }
        let public_key = installed.publisher_public_key_pem.as_deref().ok_or_else(|| {
            EngineError::Permission(
                "The installed package has no retained publisher trust key; reinstall it before execution."
                    .into(),
            )
        })?;
        let package_bytes = std::fs::read(&installed.package_path).map_err(storage)?;
        let verified = self
            .verify(
                &package_bytes,
                &PackageTrustMetadata {
                    publisher_id: installed.publisher_id.clone(),
                    key_id: installed.publisher_key_id.clone(),
                    publisher_public_key_pem: public_key.to_string(),
                    owner_type: installed.owner_type.clone(),
                    owner_id: installed.owner_id.clone(),
                    source: installed.source.clone(),
                },
            )
            .map_err(|error| EngineError::Permission(error.to_string()))?;
        if verified.digest != pin.package_integrity
            || verified.manifest.plugin_id != pin.plugin_id
            || verified.manifest.version.to_string() != pin.plugin_version
            || verified.manifest.publisher_id != pin.publisher_id
        {
            return Err(EngineError::Permission(
                "The verified package does not match the workflow's exact plugin pin.".into(),
            ));
        }
        let definition = verified
            .manifest
            .node(&node.node_type, node.version)
            .ok_or_else(|| {
                EngineError::Node(format!(
                    "Plugin {} {} does not declare node {} version {}.",
                    pin.plugin_id, pin.plugin_version, node.node_type, node.version
                ))
            })?
            .clone();
        if !matches!(
            definition.external_effect,
            None | Some(sandbox_plugin_runtime::ExternalEffect::Read)
        ) && !workflow.settings.permissions.external_data_write_permitted
        {
            return Err(EngineError::Permission(format!(
                "{} requires external data write approval before it can run.",
                node.name
            )));
        }
        if definition
            .capabilities
            .iter()
            .any(|capability| capability == "external_communication")
            && !workflow
                .settings
                .permissions
                .external_communication_permitted
        {
            return Err(EngineError::Permission(format!(
                "{} requires external communication approval before it can run.",
                node.name
            )));
        }
        validate_schema_instance(
            &definition.configuration_schema,
            &node.configuration,
            "Plugin configuration",
        )
        .map_err(plugin_execution)?;
        validate_schema_instance(&definition.input_schema, &input, "Plugin input")
            .map_err(plugin_execution)?;
        let entrypoint = verified
            .manifest
            .entrypoints
            .iter()
            .find(|entrypoint| entrypoint.id == definition.execution_entrypoint)
            .ok_or_else(|| EngineError::Node("The plugin execution entrypoint is missing.".into()))?
            .clone();
        let wasm = verified
            .entrypoint(&definition.execution_entrypoint)
            .map_err(plugin_execution)?;
        let idempotency_key = format!("{execution_id}-{}", node.id);
        let mut guest_input = input.as_object().cloned().unwrap_or_default();
        guest_input.insert("kind".into(), Value::String("action".into()));
        guest_input.insert("nodeType".into(), Value::String(node.node_type.clone()));
        guest_input.insert("configuration".into(), node.configuration.clone());
        guest_input.insert("input".into(), input);
        guest_input.insert(
            "idempotencyKey".into(),
            Value::String(idempotency_key.clone()),
        );
        guest_input.insert(
            "connectionReferences".into(),
            serde_json::json!(&pin.credential_references),
        );
        guest_input.insert(
            "execution".into(),
            serde_json::json!({
                "executionId": execution_id,
                "workflowId": workflow.id,
                "nodeId": node.id,
                "idempotencyKey": idempotency_key,
            }),
        );
        let file_grants = definition
            .file_inputs
            .iter()
            .filter_map(|definition| {
                node.configuration
                    .get(&definition.key)
                    .and_then(Value::as_str)
                    .map(|value| Value::String(value.to_string()))
            })
            .collect();
        guest_input.insert("fileGrants".into(), Value::Array(file_grants));
        let guest_input = Value::Object(guest_input);
        let storage_execution_id = format!("{execution_id}:{}", node.id);
        let mut context = ExecutionContext::from_manifest(
            &verified.manifest,
            storage_execution_id.clone(),
            &node.id,
        );
        context.owner_id = workflow.owner.owner_id.clone();
        context.workspace_id =
            (workflow.owner.owner_type == "workspace").then(|| workflow.owner.owner_id.clone());
        context.plugin_major_version = if verified
            .manifest
            .storage_requirements
            .isolate_by_major_version
        {
            verified.manifest.version.major
        } else {
            0
        };
        context.approved_capabilities = definition
            .capabilities
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>();
        context.approved_credential_references = pin.credential_references.clone();
        context.cancellation = cancellation;
        let runtime = PluginRuntime::new(RuntimeLimits {
            timeout: StdDuration::from_millis(definition.timeout_ms),
            ..RuntimeLimits::default()
        })
        .map_err(plugin_execution)?;
        let execution = runtime.execute(
            wasm,
            &entrypoint.export,
            &guest_input,
            self.broker.clone(),
            context,
        );
        let cleanup = self
            .database
            .clear_temporary_plugin_storage(&storage_execution_id);
        let (envelope, diagnostics) = execution.map_err(plugin_execution)?;
        cleanup?;
        if envelope.get("ok").and_then(Value::as_bool) == Some(false) {
            let message = envelope
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("The plugin returned a structured execution error.");
            return Err(EngineError::Node(message.chars().take(4096).collect()));
        }
        let output = if envelope.get("ok").and_then(Value::as_bool) == Some(true) {
            envelope.get("output").cloned().ok_or_else(|| {
                EngineError::Node("The plugin returned no typed output value.".into())
            })?
        } else {
            envelope
        };
        validate_schema_instance(&definition.output_schema, &output, "Plugin output")
            .map_err(plugin_execution)?;
        Ok(PluginExecutionResult {
            output,
            diagnostics,
        })
    }

    fn verify(
        &self,
        bytes: &[u8],
        trust: &PackageTrustMetadata,
    ) -> Result<VerifiedPackage, EngineError> {
        let mut trust_store = PackageTrustStore::default();
        trust_store
            .insert_public_key_pem(
                &trust.publisher_id,
                &trust.key_id,
                &trust.publisher_public_key_pem,
            )
            .map_err(plugin)?;
        let mut revocations = RevocationList::default();
        for item in self.database.list_plugin_revocations()? {
            if let Some(version) = item.version {
                if let Ok(version) = Version::parse(&version) {
                    revocations.revoke_version(item.plugin_id.clone(), version);
                }
            }
            if let Some(integrity) = item.package_integrity {
                revocations.revoke_integrity(integrity);
            }
        }
        let host_version = Version::parse(HOST_VERSION).map_err(storage)?;
        VerifiedPackage::from_bytes(bytes, &trust_store, &revocations, &host_version)
            .map_err(plugin)
    }

    fn package_destination(&self, manifest: &Manifest, integrity: &str) -> PathBuf {
        let digest = integrity.trim_start_matches("sha256:");
        self.package_directory
            .join(&manifest.plugin_id)
            .join(manifest.version.to_string())
            .join(format!("{digest}.sandbox-plugin"))
    }
}

struct UnavailableCredentialOperations;

impl CredentialOperationBroker for UnavailableCredentialOperations {
    fn execute(
        &self,
        _credential_id: &str,
        credential_type: &str,
        operation: &str,
        _input: &Value,
    ) -> Result<Value, PluginError> {
        Err(PluginError::Host(format!(
            "No host adapter is registered for credential operation {credential_type}.{operation}."
        )))
    }
}

struct DatabasePluginStorage {
    database: Database,
}

impl PluginStorage for DatabasePluginStorage {
    fn get(&self, scope: &StorageScope, key: &str) -> Result<Option<Vec<u8>>, PluginError> {
        let (workspace, major, temporary) = normalized_scope(scope);
        self.database
            .plugin_storage_get(
                &scope.plugin_id,
                &scope.publisher_id,
                &scope.owner_id,
                workspace,
                major,
                temporary,
                key,
            )
            .map_err(plugin_storage)
    }

    fn put(
        &self,
        scope: &StorageScope,
        key: &str,
        value: &[u8],
        quota: u64,
    ) -> Result<(), PluginError> {
        let (workspace, major, temporary) = normalized_scope(scope);
        self.database
            .plugin_storage_put(
                &scope.plugin_id,
                &scope.publisher_id,
                &scope.owner_id,
                workspace,
                major,
                temporary,
                key,
                value,
                quota,
            )
            .map_err(plugin_storage)
    }

    fn delete(&self, scope: &StorageScope, key: &str) -> Result<(), PluginError> {
        let (workspace, major, temporary) = normalized_scope(scope);
        self.database
            .plugin_storage_delete(
                &scope.plugin_id,
                &scope.publisher_id,
                &scope.owner_id,
                workspace,
                major,
                temporary,
                key,
            )
            .map_err(plugin_storage)
    }

    fn used_bytes(&self, scope: &StorageScope) -> Result<u64, PluginError> {
        let (workspace, major, temporary) = normalized_scope(scope);
        self.database
            .plugin_storage_used_bytes(
                &scope.plugin_id,
                &scope.publisher_id,
                &scope.owner_id,
                workspace,
                major,
                temporary,
            )
            .map_err(plugin_storage)
    }
}

fn normalized_scope(scope: &StorageScope) -> (&str, u64, &str) {
    (
        scope.workspace_id.as_deref().unwrap_or(""),
        scope.major_version.unwrap_or(0),
        scope.temporary_execution_id.as_deref().unwrap_or(""),
    )
}

fn plugin_storage(error: impl std::fmt::Display) -> PluginError {
    PluginError::Storage(error.to_string())
}

fn validate_trust_metadata(trust: &PackageTrustMetadata) -> Result<(), EngineError> {
    if !matches!(trust.owner_type.as_str(), "personal" | "workspace") {
        return Err(EngineError::Validation(
            "Plugin owner type must be personal or workspace.".into(),
        ));
    }
    if trust.owner_id.trim().is_empty() {
        return Err(EngineError::Validation(
            "Plugin owner ID is required.".into(),
        ));
    }
    if !matches!(
        trust.source.as_str(),
        "marketplace" | "private" | "development"
    ) {
        return Err(EngineError::Validation(
            "Plugin source must be marketplace, private, or development.".into(),
        ));
    }
    Ok(())
}

fn write_immutable(path: &Path, bytes: &[u8]) -> Result<(), EngineError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(storage)?;
    }
    if path.exists() {
        let existing = std::fs::read(path).map_err(storage)?;
        if existing == bytes {
            return Ok(());
        }
        return Err(EngineError::Validation(
            "An immutable package path already contains different bytes.".into(),
        ));
    }
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    std::fs::write(&temporary, bytes).map_err(storage)?;
    std::fs::rename(&temporary, path).map_err(storage)?;
    Ok(())
}

fn plugin(error: impl std::fmt::Display) -> EngineError {
    EngineError::Validation(error.to_string())
}

fn plugin_execution(error: PluginError) -> EngineError {
    match error {
        PluginError::Permission(message) | PluginError::Package(message) => {
            EngineError::Permission(message)
        }
        PluginError::Cancelled => EngineError::Cancelled,
        other => EngineError::Node(other.to_string()),
    }
}

fn storage(error: impl std::fmt::Display) -> EngineError {
    EngineError::Storage(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
    use ed25519_dalek::{
        pkcs8::{spki::der::pem::LineEnding, EncodePublicKey},
        Signer, SigningKey,
    };
    use sandbox_engine::{
        PluginNodePin, Position, Workflow, WorkflowNode, WorkflowSettings, CURRENT_SCHEMA_VERSION,
    };
    use sandbox_plugin_runtime::{
        package_digest, CredentialOperationBroker, HttpRequest, HttpResponse, NetworkTransport,
        PluginError,
    };
    use std::{collections::BTreeMap, io::Write};
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

    fn signed_weather_package(signing: &SigningKey, version: &str, expanded: bool) -> Vec<u8> {
        let mut manifest: Manifest = serde_json::from_str(include_str!(
            "../../examples/plugins/weather-data/manifest.json"
        ))
        .unwrap();
        manifest.version = Version::parse(version).unwrap();
        manifest.signature.key_id = "test-key".into();
        if expanded {
            manifest
                .network_domains
                .push(sandbox_plugin_runtime::NetworkDomain {
                    domain: "api.example.com".into(),
                    methods: vec![sandbox_plugin_runtime::HttpMethod::Post],
                    allow_subdomains: false,
                    allow_redirects: false,
                });
        }
        let mut files = BTreeMap::from([
            (
                "components/main.wasm".into(),
                include_bytes!("../../examples/plugins/weather-data/components/main.wasm").to_vec(),
            ),
            (
                "assets/icon.svg".into(),
                include_bytes!("../../examples/plugins/weather-data/assets/icon.svg").to_vec(),
            ),
            (
                "docs/current-weather.md".into(),
                include_bytes!("../../examples/plugins/weather-data/docs/current-weather.md")
                    .to_vec(),
            ),
        ]);
        let digest = package_digest(&manifest, &files).unwrap();
        manifest.package_integrity = format!("sha256:{}", hex(&digest));
        manifest.signature.value = BASE64.encode(signing.sign(&digest).to_bytes());
        files.insert(
            "manifest.json".into(),
            serde_json::to_vec(&manifest).unwrap(),
        );
        let mut writer = ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        for (name, contents) in files {
            writer.start_file(name, options).unwrap();
            writer.write_all(&contents).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    fn trust(signing: &SigningKey) -> PackageTrustMetadata {
        PackageTrustMetadata {
            publisher_id: "com.sandbox.examples".into(),
            key_id: "test-key".into(),
            publisher_public_key_pem: signing
                .verifying_key()
                .to_public_key_pem(LineEnding::LF)
                .unwrap(),
            owner_type: "personal".into(),
            owner_id: "local".into(),
            source: "development".into(),
        }
    }

    fn workflow(plugin: &InstalledPlugin) -> Workflow {
        let now = Utc::now();
        Workflow {
            id: "plugin-workflow".into(),
            schema_version: CURRENT_SCHEMA_VERSION,
            owner: Default::default(),
            name: "Plugin workflow".into(),
            description: String::new(),
            enabled: true,
            trigger_node_id: "weather".into(),
            nodes: vec![WorkflowNode {
                id: "weather".into(),
                node_type: "weather.current".into(),
                version: 1,
                name: "Weather".into(),
                position: Position { x: 0.0, y: 0.0 },
                configuration: serde_json::json!({}),
                disabled: false,
                input_bindings: Default::default(),
                plugin: Some(PluginNodePin {
                    plugin_id: plugin.plugin_id.clone(),
                    plugin_version: plugin.version.clone(),
                    package_integrity: plugin.package_integrity.clone(),
                    publisher_id: plugin.publisher_id.clone(),
                    input: serde_json::json!({}),
                    credential_references: BTreeMap::new(),
                }),
                customization: None,
                error_policy: None,
            }],
            edges: vec![],
            settings: WorkflowSettings::default(),
            created_at: now,
            updated_at: now,
        }
    }

    struct WeatherNetwork;

    impl NetworkTransport for WeatherNetwork {
        fn send(&self, request: &HttpRequest) -> Result<HttpResponse, PluginError> {
            assert!(request.url.starts_with("https://api.open-meteo.com/"));
            Ok(HttpResponse {
                status: 200,
                headers: BTreeMap::new(),
                body: serde_json::to_vec(&serde_json::json!({
                    "current_weather": {
                        "temperature": 12.5,
                        "windspeed": 4.0,
                        "weathercode": 1
                    }
                }))
                .unwrap(),
            })
        }
    }

    struct NoCredentials;

    impl CredentialOperationBroker for NoCredentials {
        fn execute(
            &self,
            _credential_id: &str,
            _credential_type: &str,
            _operation: &str,
            _input: &Value,
        ) -> Result<Value, PluginError> {
            panic!("weather plugin must not request credential operations")
        }
    }

    #[test]
    fn installs_disabled_then_requires_approval_and_preserves_pins_on_expansion() {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::in_memory().unwrap();
        let manager =
            PluginManager::new(database.clone(), directory.path().join("packages")).unwrap();
        let signing = SigningKey::from_bytes(&[42; 32]);

        let inspected = manager
            .inspect_bytes(
                signed_weather_package(&signing, "1.0.0", false),
                trust(&signing),
            )
            .unwrap();
        assert!(inspected.signed_and_verified);
        let installed = manager.install_inspected(&inspected.inspection_id).unwrap();
        assert_eq!(installed.state, PluginInstallState::Disabled);
        assert!(Path::new(&installed.package_path).exists());
        assert!(database
            .set_plugin_enabled(
                &installed.plugin_id,
                &installed.version,
                &installed.package_integrity,
                "personal",
                "local",
                true,
            )
            .unwrap_err()
            .to_string()
            .contains("approve"));
        database
            .approve_plugin_permissions(
                &installed.plugin_id,
                &installed.version,
                &installed.package_integrity,
                "personal",
                "local",
            )
            .unwrap();
        let enabled = database
            .set_plugin_enabled(
                &installed.plugin_id,
                &installed.version,
                &installed.package_integrity,
                "personal",
                "local",
                true,
            )
            .unwrap();
        database
            .verify_workflow_plugin_pins(&workflow(&enabled))
            .unwrap();

        let update = manager
            .inspect_bytes(
                signed_weather_package(&signing, "2.0.0", true),
                trust(&signing),
            )
            .unwrap();
        assert!(update
            .permission_expansion
            .iter()
            .any(|item| item.contains("api.example.com")));
        let update = manager.install_inspected(&update.inspection_id).unwrap();
        assert_eq!(update.state, PluginInstallState::Disabled);
        assert!(update.update_requires_review);
        assert_eq!(
            database
                .get_installed_plugin(
                    &enabled.plugin_id,
                    &enabled.version,
                    &enabled.package_integrity,
                    "personal",
                    "local"
                )
                .unwrap()
                .unwrap()
                .state,
            PluginInstallState::Enabled
        );
    }

    #[test]
    fn revocation_blocks_installation_and_exact_workflow_pin() {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::in_memory().unwrap();
        let manager =
            PluginManager::new(database.clone(), directory.path().join("packages")).unwrap();
        let signing = SigningKey::from_bytes(&[24; 32]);
        let inspected = manager
            .inspect_bytes(
                signed_weather_package(&signing, "1.0.0", false),
                trust(&signing),
            )
            .unwrap();
        let installed = manager.install_inspected(&inspected.inspection_id).unwrap();
        database
            .approve_plugin_permissions(
                &installed.plugin_id,
                &installed.version,
                &installed.package_integrity,
                "personal",
                "local",
            )
            .unwrap();
        let enabled = database
            .set_plugin_enabled(
                &installed.plugin_id,
                &installed.version,
                &installed.package_integrity,
                "personal",
                "local",
                true,
            )
            .unwrap();
        manager
            .apply_revocation(PluginRevocation {
                plugin_id: enabled.plugin_id.clone(),
                version: None,
                package_integrity: Some(enabled.package_integrity.clone()),
                reason: "Security test".into(),
                security_notice_url: Some("https://example.com/security/test".into()),
                revoked_at: Utc::now(),
            })
            .unwrap();
        assert!(database
            .verify_workflow_plugin_pins(&workflow(&enabled))
            .unwrap_err()
            .to_string()
            .contains("revoked"));
        assert!(manager
            .inspect_bytes(
                signed_weather_package(&signing, "1.0.0", false),
                trust(&signing)
            )
            .unwrap_err()
            .to_string()
            .contains("revoked"));
    }

    #[test]
    fn executes_exact_installed_package_and_rejects_tampering() {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::in_memory().unwrap();
        let manager = PluginManager::with_host_services(
            database.clone(),
            directory.path().join("packages"),
            Arc::new(WeatherNetwork),
            Arc::new(NoCredentials),
        )
        .unwrap();
        let signing = SigningKey::from_bytes(&[17; 32]);
        let inspected = manager
            .inspect_bytes(
                signed_weather_package(&signing, "1.0.0", false),
                trust(&signing),
            )
            .unwrap();
        let installed = manager.install_inspected(&inspected.inspection_id).unwrap();
        assert!(installed.publisher_public_key_pem.is_some());
        database
            .approve_plugin_permissions(
                &installed.plugin_id,
                &installed.version,
                &installed.package_integrity,
                "personal",
                "local",
            )
            .unwrap();
        let enabled = database
            .set_plugin_enabled(
                &installed.plugin_id,
                &installed.version,
                &installed.package_integrity,
                "personal",
                "local",
                true,
            )
            .unwrap();
        let mut workflow = workflow(&enabled);
        workflow.nodes[0].configuration =
            serde_json::json!({"latitude":51.5,"longitude":-0.12,"units":"celsius"});
        let result = manager
            .execute_node(
                &workflow,
                &workflow.nodes[0],
                "run-weather",
                serde_json::json!({}),
                Arc::new(AtomicBool::new(false)),
            )
            .unwrap();
        assert_eq!(result.output["temperature"], 12.5);

        let mut tampered = std::fs::read(&enabled.package_path).unwrap();
        tampered[0] ^= 0xff;
        std::fs::write(&enabled.package_path, tampered).unwrap();
        assert!(manager
            .execute_node(
                &workflow,
                &workflow.nodes[0],
                "run-tampered",
                serde_json::json!({}),
                Arc::new(AtomicBool::new(false)),
            )
            .unwrap_err()
            .to_string()
            .contains("package"));
    }

    fn hex(value: &[u8]) -> String {
        value.iter().map(|byte| format!("{byte:02x}")).collect()
    }
}
