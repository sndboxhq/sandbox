use crate::{schema::validate_declared_schema, PluginError, MANIFEST_VERSION};
use regex::Regex;
use semver::{BuildMetadata, Prerelease, Version, VersionReq};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use url::Url;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Signature {
    pub algorithm: String,
    pub key_id: String,
    pub value: String,
}

impl Default for Signature {
    fn default() -> Self {
        Self {
            algorithm: "ed25519".into(),
            key_id: String::new(),
            value: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HttpMethod {
    Get,
    Post,
    Put,
    Patch,
    Delete,
    Head,
}

impl HttpMethod {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
            Self::Put => "PUT",
            Self::Patch => "PATCH",
            Self::Delete => "DELETE",
            Self::Head => "HEAD",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkDomain {
    pub domain: String,
    pub methods: Vec<HttpMethod>,
    #[serde(default)]
    pub allow_subdomains: bool,
    #[serde(default)]
    pub allow_redirects: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Capability {
    WorkflowInput,
    StructuredLogging,
    Time,
    RandomIdentifiers,
    Cryptography {
        operations: Vec<String>,
    },
    Network,
    CredentialOperations {
        credential_type: String,
        operations: Vec<String>,
    },
    TemporaryStorage {
        max_bytes: u64,
    },
    PersistentStorage {
        max_bytes: u64,
    },
    ExternalCommunication,
    FilePickerRead {
        max_bytes: u64,
    },
}

impl Capability {
    pub fn key(&self) -> String {
        match self {
            Self::WorkflowInput => "workflow_input".into(),
            Self::StructuredLogging => "structured_logging".into(),
            Self::Time => "time".into(),
            Self::RandomIdentifiers => "random_identifiers".into(),
            Self::Cryptography { .. } => "cryptography".into(),
            Self::Network => "network".into(),
            Self::CredentialOperations {
                credential_type, ..
            } => {
                format!("credential_operations:{credential_type}")
            }
            Self::TemporaryStorage { .. } => "temporary_storage".into(),
            Self::PersistentStorage { .. } => "persistent_storage".into(),
            Self::ExternalCommunication => "external_communication".into(),
            Self::FilePickerRead { .. } => "file_picker_read".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CredentialDefinition {
    pub credential_type: String,
    pub display_name: String,
    pub operations: Vec<String>,
    #[serde(default)]
    pub scopes: Vec<String>,
    pub configuration_schema: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    Action,
    PollingTrigger,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NodePlacement {
    Desktop,
    SelfHosted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExternalEffect {
    Read,
    ExternalWrite,
    DestructiveOrHighImpact,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NodePort {
    pub key: String,
    pub label: String,
    #[serde(rename = "type")]
    pub value_type: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub sensitive: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionRequirement {
    pub reference: String,
    pub provider: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub permissions: Vec<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileInputDefinition {
    pub key: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maximum_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub accepted_mime_types: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NodeDefinition {
    pub node_type: String,
    pub node_version: u32,
    pub display_name: String,
    pub description: String,
    pub category: String,
    pub risk_level: String,
    pub input_schema: Value,
    pub output_schema: Value,
    pub configuration_schema: Value,
    #[serde(default)]
    pub credential_requirements: Vec<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    pub timeout_ms: u64,
    pub retry_behavior: String,
    pub idempotency_support: String,
    pub documentation: String,
    #[serde(default)]
    pub migration_handlers: Vec<String>,
    pub execution_entrypoint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<NodeKind>,
    #[serde(default)]
    pub input_ports: Vec<NodePort>,
    #[serde(default)]
    pub output_ports: Vec<NodePort>,
    #[serde(default)]
    pub connection_requirements: Vec<ConnectionRequirement>,
    #[serde(default)]
    pub file_inputs: Vec<FileInputDefinition>,
    #[serde(default)]
    pub placements: Vec<NodePlacement>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_effect: Option<ExternalEffect>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MigrationDefinition {
    pub id: String,
    pub from_node_version: u32,
    pub to_node_version: u32,
    pub entrypoint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Entrypoint {
    pub id: String,
    pub path: String,
    pub export: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct StorageRequirements {
    #[serde(default)]
    pub temporary_bytes: u64,
    #[serde(default)]
    pub persistent_bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retention_days: Option<u32>,
    #[serde(default)]
    pub isolate_by_major_version: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "model", rename_all = "snake_case")]
pub enum Pricing {
    Free,
    OneTime {
        currency: String,
        amount_minor: u64,
    },
    Subscription {
        currency: String,
        amount_minor: u64,
        interval: String,
    },
    WorkspacePerUser {
        currency: String,
        amount_minor: u64,
        interval: String,
    },
    Organisation {
        currency: String,
        amount_minor: u64,
        interval: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub manifest_version: u32,
    pub plugin_id: String,
    pub name: String,
    pub description: String,
    pub version: Version,
    pub publisher_id: String,
    pub minimum_host_version: VersionReq,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maximum_host_version: Option<VersionReq>,
    pub homepage: String,
    pub documentation: String,
    pub support_url: String,
    pub licence: String,
    #[serde(default)]
    pub categories: Vec<String>,
    #[serde(default)]
    pub keywords: Vec<String>,
    pub icon: String,
    pub nodes: Vec<NodeDefinition>,
    #[serde(default)]
    pub credentials: Vec<CredentialDefinition>,
    pub capabilities: Vec<Capability>,
    #[serde(default)]
    pub network_domains: Vec<NetworkDomain>,
    pub storage_requirements: StorageRequirements,
    #[serde(default)]
    pub migrations: Vec<MigrationDefinition>,
    pub entrypoints: Vec<Entrypoint>,
    pub package_integrity: String,
    pub signature: Signature,
    pub pricing: Pricing,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub privacy_policy: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManifestValidation {
    pub valid: bool,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

impl Manifest {
    pub fn validate(&self, host_version: &Version, require_signature: bool) -> ManifestValidation {
        let mut errors = Vec::new();
        let mut warnings = Vec::new();
        let id = Regex::new(r"^[a-z0-9]+(?:[.-][a-z0-9]+)+$").expect("static regex");
        let node_id = Regex::new(r"^[a-z][a-z0-9_.-]{2,127}$").expect("static regex");
        if !(1..=MANIFEST_VERSION).contains(&self.manifest_version) {
            errors.push(format!(
                "Unsupported manifestVersion {}.",
                self.manifest_version
            ));
        }
        if !id.is_match(&self.plugin_id) {
            errors.push("pluginId must be a lowercase reverse-domain identifier.".into());
        }
        if !id.is_match(&self.publisher_id) {
            errors.push("publisherId must be a lowercase reverse-domain identifier.".into());
        }
        for (label, value) in [
            ("homepage", &self.homepage),
            ("documentation", &self.documentation),
            ("supportUrl", &self.support_url),
        ] {
            if !is_https_url(value) {
                errors.push(format!("{label} must be an HTTPS URL."));
            }
        }
        if !matches_host_version(&self.minimum_host_version, host_version) {
            errors.push(format!(
                "Host {host_version} does not satisfy minimumHostVersion."
            ));
        }
        if self
            .maximum_host_version
            .as_ref()
            .is_some_and(|value| !matches_host_version(value, host_version))
        {
            errors.push(format!(
                "Host {host_version} does not satisfy maximumHostVersion."
            ));
        }
        if self.nodes.is_empty() {
            errors.push("At least one node is required.".into());
        }
        let entrypoints: BTreeSet<_> = self
            .entrypoints
            .iter()
            .map(|item| item.id.as_str())
            .collect();
        if entrypoints.len() != self.entrypoints.len() {
            errors.push("Entrypoint IDs must be unique.".into());
        }
        for entrypoint in &self.entrypoints {
            if !safe_relative_path(&entrypoint.path) || !entrypoint.path.ends_with(".wasm") {
                errors.push(format!(
                    "Entrypoint '{}' must reference a safe .wasm path.",
                    entrypoint.id
                ));
            }
            if entrypoint.export.trim().is_empty() {
                errors.push(format!("Entrypoint '{}' has no export.", entrypoint.id));
            }
        }
        let mut nodes = BTreeSet::new();
        let capability_keys: BTreeSet<_> = self.capabilities.iter().map(Capability::key).collect();
        let credential_types: BTreeSet<_> = self
            .credentials
            .iter()
            .map(|item| item.credential_type.as_str())
            .collect();
        for node in &self.nodes {
            if !node_id.is_match(&node.node_type)
                || !nodes.insert((node.node_type.as_str(), node.node_version))
            {
                errors.push(format!(
                    "Node '{}@{}' is invalid or duplicated.",
                    node.node_type, node.node_version
                ));
            }
            if node.node_version == 0 {
                errors.push(format!(
                    "Node '{}' must use a positive nodeVersion.",
                    node.node_type
                ));
            }
            if !entrypoints.contains(node.execution_entrypoint.as_str()) {
                errors.push(format!(
                    "Node '{}' references an undeclared entrypoint.",
                    node.node_type
                ));
            }
            for capability in &node.capabilities {
                if !capability_keys.contains(capability) {
                    errors.push(format!(
                        "Node '{}' references undeclared capability '{capability}'.",
                        node.node_type
                    ));
                }
            }
            for credential in &node.credential_requirements {
                if !credential_types.contains(credential.as_str()) {
                    errors.push(format!(
                        "Node '{}' references undeclared credential type '{credential}'.",
                        node.node_type
                    ));
                }
            }
            if !(100..=300_000).contains(&node.timeout_ms) {
                errors.push(format!(
                    "Node '{}' timeout must be between 100 ms and 300 seconds.",
                    node.node_type
                ));
            }
            for (label, schema) in [
                ("inputSchema", &node.input_schema),
                ("outputSchema", &node.output_schema),
                ("configurationSchema", &node.configuration_schema),
            ] {
                if let Err(error) = validate_declared_schema(schema) {
                    errors.push(format!("Node '{}' {label} {error}.", node.node_type));
                }
            }
            if self.manifest_version >= 2 {
                if node.kind.is_none() {
                    errors.push(format!("Node '{}' must declare a v2 kind.", node.node_type));
                }
                if node.placements.is_empty() {
                    errors.push(format!(
                        "Node '{}' must declare at least one v2 placement.",
                        node.node_type
                    ));
                }
                if node.external_effect.is_none() {
                    errors.push(format!(
                        "Node '{}' must declare a v2 externalEffect.",
                        node.node_type
                    ));
                }
                if matches!(node.kind, Some(NodeKind::PollingTrigger))
                    && !matches!(node.external_effect, Some(ExternalEffect::Read))
                {
                    errors.push(format!(
                        "Polling trigger '{}' must be read-only.",
                        node.node_type
                    ));
                }
                let references = node
                    .connection_requirements
                    .iter()
                    .map(|requirement| requirement.reference.as_str())
                    .collect::<BTreeSet<_>>();
                if references.len() != node.connection_requirements.len() {
                    errors.push(format!(
                        "Node '{}' has duplicate connection requirement references.",
                        node.node_type
                    ));
                }
            }
        }
        for credential in &self.credentials {
            if let Err(error) = validate_declared_schema(&credential.configuration_schema) {
                errors.push(format!(
                    "Credential '{}' configurationSchema {error}.",
                    credential.credential_type
                ));
            }
        }
        if capability_keys.contains("network") && self.network_domains.is_empty() {
            errors.push("The network capability requires at least one networkDomains rule.".into());
        }
        if !capability_keys.contains("network") && !self.network_domains.is_empty() {
            errors.push("networkDomains requires the network capability.".into());
        }
        let mut domains = BTreeSet::new();
        for rule in &self.network_domains {
            let domain = rule.domain.to_ascii_lowercase();
            if domain != rule.domain || !valid_domain(&domain) || !domains.insert(domain.clone()) {
                errors.push(format!(
                    "Network domain '{}' is invalid or duplicated.",
                    rule.domain
                ));
            }
            if rule.methods.is_empty() {
                errors.push(format!(
                    "Network domain '{}' must declare methods.",
                    rule.domain
                ));
            }
        }
        const MAX_STORAGE: u64 = 100 * 1024 * 1024;
        if self.storage_requirements.temporary_bytes > MAX_STORAGE
            || self.storage_requirements.persistent_bytes > MAX_STORAGE
        {
            errors
                .push("Plugin storage requirements cannot exceed 100 MB per storage class.".into());
        }
        let declared_persistent =
            self.capabilities
                .iter()
                .find_map(|capability| match capability {
                    Capability::PersistentStorage { max_bytes } => Some(*max_bytes),
                    _ => None,
                });
        let declared_temporary = self
            .capabilities
            .iter()
            .find_map(|capability| match capability {
                Capability::TemporaryStorage { max_bytes } => Some(*max_bytes),
                _ => None,
            });
        if self.storage_requirements.persistent_bytes > declared_persistent.unwrap_or(0) {
            errors.push(
                "storageRequirements.persistentBytes exceeds the declared persistent storage capability."
                    .into(),
            );
        }
        if self.storage_requirements.temporary_bytes > declared_temporary.unwrap_or(0) {
            errors.push(
                "storageRequirements.temporaryBytes exceeds the declared temporary storage capability."
                    .into(),
            );
        }
        let privacy_required = capability_keys.contains("network")
            || capability_keys.contains("persistent_storage")
            || capability_keys.contains("external_communication")
            || capability_keys
                .iter()
                .any(|key| key.starts_with("credential_operations:"));
        if privacy_required
            && self
                .privacy_policy
                .as_deref()
                .is_none_or(|value| !is_https_url(value))
        {
            errors
                .push("A valid HTTPS privacyPolicy is required for data-accessing plugins.".into());
        }
        if require_signature {
            if self
                .package_integrity
                .strip_prefix("sha256:")
                .is_none_or(|hash| hash.len() != 64 || !hash.chars().all(|c| c.is_ascii_hexdigit()))
            {
                errors.push("packageIntegrity must be a sha256 digest.".into());
            }
            if self.signature.algorithm != "ed25519"
                || self.signature.key_id.is_empty()
                || self.signature.value.is_empty()
            {
                errors.push("A complete Ed25519 signature is required.".into());
            }
        } else if self.signature.value.is_empty() {
            warnings
                .push("Development package is unsigned and cannot be marketplace verified.".into());
        }
        ManifestValidation {
            valid: errors.is_empty(),
            errors,
            warnings,
        }
    }

    pub fn node(&self, node_type: &str, node_version: u32) -> Option<&NodeDefinition> {
        self.nodes
            .iter()
            .find(|node| node.node_type == node_type && node.node_version == node_version)
    }
}

pub fn permission_summary(manifest: &Manifest) -> Vec<String> {
    let mut permissions = Vec::new();
    for capability in &manifest.capabilities {
        match capability {
            Capability::Network => {
                permissions.extend(manifest.network_domains.iter().map(|rule| {
                    format!(
                        "Connect to {} using {}",
                        rule.domain,
                        rule.methods
                            .iter()
                            .map(HttpMethod::as_str)
                            .collect::<Vec<_>>()
                            .join(", ")
                    )
                }))
            }
            Capability::CredentialOperations {
                credential_type,
                operations,
            } => permissions.push(format!(
                "Use a selected {credential_type} connection for {}",
                operations.join(", ")
            )),
            Capability::PersistentStorage { max_bytes } => permissions.push(format!(
                "Store up to {} MB of isolated plugin data",
                bytes_mb(*max_bytes)
            )),
            Capability::TemporaryStorage { max_bytes } => permissions.push(format!(
                "Use up to {} MB of temporary storage",
                bytes_mb(*max_bytes)
            )),
            Capability::ExternalCommunication => {
                permissions.push("Send external messages or actions".into())
            }
            Capability::FilePickerRead { .. } => {
                permissions.push("Read files explicitly selected through the file picker".into())
            }
            Capability::Cryptography { operations } => permissions.push(format!(
                "Use limited cryptographic helpers: {}",
                operations.join(", ")
            )),
            Capability::WorkflowInput
            | Capability::StructuredLogging
            | Capability::Time
            | Capability::RandomIdentifiers => {}
        }
    }
    permissions.sort();
    permissions.dedup();
    permissions
}

pub fn permission_diff(old: &Manifest, new: &Manifest) -> Vec<String> {
    let old_permissions: BTreeSet<_> = permission_summary(old).into_iter().collect();
    permission_summary(new)
        .into_iter()
        .filter(|item| !old_permissions.contains(item))
        .collect()
}

pub fn canonical_manifest(manifest: &Manifest) -> Result<Vec<u8>, PluginError> {
    let mut unsigned = manifest.clone();
    unsigned.package_integrity.clear();
    unsigned.signature = Signature::default();
    let mut value =
        serde_json::to_value(unsigned).map_err(|error| PluginError::Manifest(error.to_string()))?;
    if manifest.manifest_version == 1 {
        if let Some(nodes) = value.get_mut("nodes").and_then(Value::as_array_mut) {
            for node in nodes {
                if let Some(object) = node.as_object_mut() {
                    for key in [
                        "kind",
                        "inputPorts",
                        "outputPorts",
                        "connectionRequirements",
                        "fileInputs",
                        "placements",
                        "externalEffect",
                    ] {
                        object.remove(key);
                    }
                }
            }
        }
    }
    let canonical = canonical_value(value);
    serde_json::to_vec(&canonical).map_err(|error| PluginError::Manifest(error.to_string()))
}

fn canonical_value(value: Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, value)| (key, canonical_value(value)))
                .collect::<BTreeMap<_, _>>()
                .into_iter()
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.into_iter().map(canonical_value).collect()),
        other => other,
    }
}

fn is_https_url(value: &str) -> bool {
    Url::parse(value).is_ok_and(|url| url.scheme() == "https" && url.host_str().is_some())
}

fn is_false(value: &bool) -> bool {
    !*value
}

pub(crate) fn safe_relative_path(value: &str) -> bool {
    !value.is_empty()
        && !value.contains('\\')
        && !value.starts_with('/')
        && value
            .split('/')
            .all(|part| !matches!(part, "" | "." | ".."))
}

fn valid_domain(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 253
        && !value.contains('/')
        && !value.contains(':')
        && value.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        })
}

fn bytes_mb(value: u64) -> u64 {
    value.div_ceil(1024 * 1024)
}

fn matches_host_version(requirement: &VersionReq, host_version: &Version) -> bool {
    if requirement.matches(host_version) {
        return true;
    }
    if host_version.pre.is_empty()
        || requirement.comparators.iter().any(|comparator| {
            !comparator.pre.is_empty()
                && comparator.major == host_version.major
                && comparator.minor == Some(host_version.minor)
                && comparator.patch == Some(host_version.patch)
        })
    {
        return false;
    }
    let mut compatibility_base = host_version.clone();
    compatibility_base.pre = Prerelease::EMPTY;
    compatibility_base.build = BuildMetadata::EMPTY;
    requirement.matches(&compatibility_base)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;

    pub(crate) fn manifest() -> Manifest {
        Manifest {
            manifest_version: 1,
            plugin_id: "com.sandbox.weather".into(),
            name: "Weather Data".into(),
            description: "Reads weather data.".into(),
            version: Version::new(1, 0, 0),
            publisher_id: "com.sandbox.examples".into(),
            minimum_host_version: VersionReq::parse(">=0.3.0").unwrap(),
            maximum_host_version: None,
            homepage: "https://example.com/weather".into(),
            documentation: "https://example.com/weather/docs".into(),
            support_url: "https://example.com/weather/support".into(),
            licence: "MIT".into(),
            categories: vec!["data".into()],
            keywords: vec!["weather".into()],
            icon: "assets/icon.svg".into(),
            nodes: vec![NodeDefinition {
                node_type: "weather.current".into(),
                node_version: 1,
                display_name: "Current weather".into(),
                description: "Reads current weather.".into(),
                category: "Data".into(),
                risk_level: "low".into(),
                input_schema: json!({"type":"object"}),
                output_schema: json!({"type":"object"}),
                configuration_schema: json!({"type":"object"}),
                credential_requirements: vec![],
                capabilities: vec!["network".into(), "structured_logging".into()],
                timeout_ms: 10_000,
                retry_behavior: "safe".into(),
                idempotency_support: "read_only".into(),
                documentation: "docs/weather.md".into(),
                migration_handlers: vec![],
                execution_entrypoint: "main".into(),
                kind: None,
                input_ports: vec![],
                output_ports: vec![],
                connection_requirements: vec![],
                file_inputs: vec![],
                placements: vec![],
                external_effect: None,
            }],
            credentials: vec![],
            capabilities: vec![Capability::Network, Capability::StructuredLogging],
            network_domains: vec![NetworkDomain {
                domain: "api.example.com".into(),
                methods: vec![HttpMethod::Get],
                allow_subdomains: false,
                allow_redirects: false,
            }],
            storage_requirements: StorageRequirements::default(),
            migrations: vec![],
            entrypoints: vec![Entrypoint {
                id: "main".into(),
                path: "components/main.wasm".into(),
                export: "execute".into(),
            }],
            package_integrity:
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
            signature: Signature {
                algorithm: "ed25519".into(),
                key_id: "primary".into(),
                value: "signed".into(),
            },
            pricing: Pricing::Free,
            privacy_policy: Some("https://example.com/privacy".into()),
        }
    }

    #[test]
    fn validates_manifest_and_generates_host_owned_permissions() {
        let manifest = manifest();
        assert!(manifest.validate(&Version::new(0, 3, 0), true).valid);
        assert!(permission_summary(&manifest)
            .iter()
            .any(|item| item.contains("api.example.com")));
    }

    #[test]
    fn prerelease_hosts_preserve_stable_ranges_and_explicit_beta_bounds() {
        let mut manifest = manifest();
        manifest.maximum_host_version = Some(VersionReq::parse("<0.8.0").unwrap());
        assert!(
            manifest
                .validate(&Version::parse("0.7.2-beta.4").unwrap(), true)
                .valid
        );

        manifest.minimum_host_version = VersionReq::parse(">=0.7.2-beta.4").unwrap();
        assert!(
            !manifest
                .validate(&Version::parse("0.7.0-beta.2").unwrap(), true)
                .valid
        );
        assert!(
            manifest
                .validate(&Version::parse("0.7.9-beta.1").unwrap(), true)
                .valid
        );

        assert!(
            !manifest
                .validate(&Version::parse("0.7.2-beta.3").unwrap(), true)
                .valid
        );

        manifest.minimum_host_version = VersionReq::parse(">=0.3.0").unwrap();
        manifest.maximum_host_version = Some(VersionReq::parse("<0.7.0").unwrap());
        assert!(
            !manifest
                .validate(&Version::parse("0.7.2-beta.4").unwrap(), true)
                .valid
        );
    }

    #[test]
    fn detects_permission_expansion() {
        let old = manifest();
        let mut new = old.clone();
        new.network_domains.push(NetworkDomain {
            domain: "upload.example.com".into(),
            methods: vec![HttpMethod::Post],
            allow_subdomains: false,
            allow_redirects: false,
        });
        assert_eq!(
            permission_diff(&old, &new),
            vec!["Connect to upload.example.com using POST"]
        );
    }
}
