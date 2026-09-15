use async_trait::async_trait;
use sandbox_engine::{
    Database, Engine, EngineError, ExecutionRecord, HostServices, PendingApproval,
    PluginHostResult, Workflow, WorkflowNode,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashSet, net::IpAddr, path::Path, sync::Arc};
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;
use url::{Host, Url};

pub mod usage;

#[derive(Debug, thiserror::Error)]
pub enum HostedRunnerError {
    #[error("hosted workload policy is invalid: {0}")]
    Policy(String),
    #[error("workflow is incompatible with a managed hosted runner: {0}")]
    Incompatible(String),
    #[error(transparent)]
    Engine(#[from] EngineError),
    #[error("temporary workload storage failed: {0}")]
    TemporaryStorage(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IsolationPolicy {
    pub workspace_id: String,
    pub environment_id: String,
    pub deployment_id: String,
    pub workflow_revision_id: String,
    pub execution_id: String,
    pub region: String,
    pub cpu_millis: u32,
    pub memory_bytes: u64,
    pub duration_seconds: u32,
    pub temporary_storage_bytes: u64,
    pub log_bytes: u64,
    pub artifact_bytes: u64,
    pub allowed_network_origins: Vec<String>,
    pub allow_private_network: bool,
    pub plugin_capabilities: Vec<String>,
    pub secret_grant_references: Vec<String>,
}

impl IsolationPolicy {
    pub fn validate(&self) -> Result<(), HostedRunnerError> {
        if self.workspace_id.is_empty()
            || self.environment_id.is_empty()
            || self.deployment_id.is_empty()
            || self.workflow_revision_id.is_empty()
            || self.execution_id.is_empty()
        {
            return Err(HostedRunnerError::Policy(
                "workspace, revision and execution identities are required".into(),
            ));
        }
        if !(100..=8_000).contains(&self.cpu_millis) {
            return Err(HostedRunnerError::Policy(
                "CPU must be between 100 and 8000 millicores".into(),
            ));
        }
        if !(64 * 1024 * 1024..=16 * 1024 * 1024 * 1024).contains(&self.memory_bytes) {
            return Err(HostedRunnerError::Policy(
                "memory must be between 64 MiB and 16 GiB".into(),
            ));
        }
        if !(1..=86_400).contains(&self.duration_seconds) {
            return Err(HostedRunnerError::Policy(
                "duration must be between one second and 24 hours".into(),
            ));
        }
        if self.temporary_storage_bytes > 10 * 1024 * 1024 * 1024 {
            return Err(HostedRunnerError::Policy(
                "temporary storage exceeds 10 GiB".into(),
            ));
        }
        if self.log_bytes > 100 * 1024 * 1024 || self.artifact_bytes > 5 * 1024 * 1024 * 1024 {
            return Err(HostedRunnerError::Policy(
                "log or artifact quota exceeds the hosted maximum".into(),
            ));
        }
        if self.allow_private_network {
            return Err(HostedRunnerError::Policy(
                "managed hosted runners require an explicit private-network connector".into(),
            ));
        }
        for origin in &self.allowed_network_origins {
            validate_egress_url(origin)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedPluginAvailability {
    pub plugin_id: String,
    pub version: String,
    pub package_integrity: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkloadRequest {
    pub workflow: Workflow,
    pub trigger: Value,
    pub policy: IsolationPolicy,
    #[serde(default)]
    pub plugins: Vec<HostedPluginAvailability>,
    #[serde(default)]
    pub connection_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompatibilityIssue {
    pub node_id: String,
    pub node_type: String,
    pub reason: String,
}

const HOSTED_BUILT_INS: &[&str] = &[
    "manual_trigger",
    "schedule_trigger",
    "gmail_new_email_trigger",
    "condition",
    "filter",
    "switch",
    "loop_over_items",
    "split_out",
    "aggregate",
    "merge",
    "remove_duplicates",
    "set_data",
    "map_fields",
    "validate_schema",
    "text_template",
    "hash_data",
    "delay",
    "http_request",
    "gmail_get_email",
    "gmail_create_draft",
    "gmail_send_email",
    "gmail_add_label",
    "discord_webhook",
    "discord_embed",
    "slack_webhook",
    "approval",
];

pub fn validate_hosted_workflow(request: &WorkloadRequest) -> Vec<CompatibilityIssue> {
    let plugins: HashSet<_> = request
        .plugins
        .iter()
        .map(|plugin| {
            (
                &plugin.plugin_id,
                &plugin.version,
                &plugin.package_integrity,
            )
        })
        .collect();
    let connections: HashSet<_> = request.connection_ids.iter().collect();
    let mut issues = Vec::new();
    for node in request.workflow.nodes.iter().filter(|node| !node.disabled) {
        if let Some(pin) = &node.plugin {
            if !plugins.contains(&(&pin.plugin_id, &pin.plugin_version, &pin.package_integrity)) {
                issues.push(issue(
                    node,
                    "The exact sandboxed plugin package is unavailable.",
                ));
            }
            for connection_id in pin.credential_references.values() {
                if !connections.contains(connection_id) {
                    issues.push(issue(
                        node,
                        "A plugin connection is not deployed to this environment.",
                    ));
                }
            }
        } else if !HOSTED_BUILT_INS.contains(&node.node_type.as_str()) {
            let reason = match node.node_type.as_str() {
                "file_watch_trigger" | "move_file" => {
                    "Managed hosted runners cannot access the user's local filesystem."
                }
                "run_command" => "Managed hosted runners do not allow arbitrary shell commands.",
                "javascript_code" => "JavaScript Code requires the pinned Node.js runtime, which is not installed in the selected hosted runner image.",
                "python_code" => "Python Code requires the pinned Python runtime, which is not installed in the selected hosted runner image.",
                "desktop_notification" => "Desktop notifications require a desktop runner.",
                "open_browser" | "navigate" | "click_element" | "fill_field" | "select_option"
                | "press_key" | "wait_for" | "extract_data" | "screenshot" | "download_file"
                | "upload_file" | "close_browser" => {
                    "Browser nodes require a managed browser worker."
                }
                _ => "This node type is not supported by the hosted runner image.",
            };
            issues.push(issue(node, reason));
        }
        if let Some(connection_id) = node
            .configuration
            .get("credentialId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            if !connections.contains(&connection_id.to_string()) {
                issues.push(issue(
                    node,
                    "The required connection is not deployed to this environment.",
                ));
            }
        }
    }
    issues
}

fn issue(node: &WorkflowNode, reason: &str) -> CompatibilityIssue {
    CompatibilityIssue {
        node_id: node.id.clone(),
        node_type: node.node_type.clone(),
        reason: reason.into(),
    }
}

pub struct WorkloadSandbox {
    directory: TempDir,
}
impl WorkloadSandbox {
    pub fn create() -> Result<Self, HostedRunnerError> {
        tempfile::Builder::new()
            .prefix("sandbox-hosted-")
            .tempdir()
            .map(|directory| Self { directory })
            .map_err(|error| HostedRunnerError::TemporaryStorage(error.to_string()))
    }
    pub fn path(&self) -> &Path {
        self.directory.path()
    }
}

pub struct HostedRunner {
    host: Arc<dyn HostServices>,
}
impl Default for HostedRunner {
    fn default() -> Self {
        Self {
            host: Arc::new(HostedHost),
        }
    }
}
impl HostedRunner {
    pub fn with_host(host: Arc<dyn HostServices>) -> Self {
        Self { host }
    }
    pub async fn execute(
        &self,
        request: WorkloadRequest,
        cancellation: CancellationToken,
    ) -> Result<ExecutionRecord, HostedRunnerError> {
        request.policy.validate()?;
        let issues = validate_hosted_workflow(&request);
        if !issues.is_empty() {
            return Err(HostedRunnerError::Incompatible(
                issues
                    .into_iter()
                    .map(|item| format!("{}: {}", item.node_id, item.reason))
                    .collect::<Vec<_>>()
                    .join(" "),
            ));
        }
        let sandbox = WorkloadSandbox::create()?;
        let db = Database::open(sandbox.path().join("execution.sqlite3"))?;
        db.save_workflow(request.workflow.clone())?;
        let engine = Engine::new(db, self.host.clone());
        let maximum = std::time::Duration::from_secs(request.policy.duration_seconds as u64);
        tokio::time::timeout(
            maximum,
            engine.run(request.workflow, request.trigger, cancellation),
        )
        .await
        .map_err(|_| {
            HostedRunnerError::Engine(EngineError::Node(
                "Hosted execution exceeded its duration limit.".into(),
            ))
        })?
        .map_err(HostedRunnerError::Engine)
    }
}

pub struct HostedHost;
#[async_trait]
impl HostServices for HostedHost {
    async fn desktop_notification(&self, _title: &str, _message: &str) -> Result<(), EngineError> {
        Err(EngineError::Node(
            "Desktop notifications are unavailable on managed hosted runners.".into(),
        ))
    }
    async fn integration_operation(
        &self,
        _operation: &str,
        _payload: Value,
    ) -> Result<Value, EngineError> {
        Err(EngineError::Node("The requested cloud connection operation is not available in this runner configuration.".into()))
    }
    async fn plugin_operation(
        &self,
        _workflow: &Workflow,
        _node: &WorkflowNode,
        _execution_id: &str,
        _input: Value,
        _cancellation: CancellationToken,
    ) -> Result<PluginHostResult, EngineError> {
        Err(EngineError::Node(
            "The hosted plugin runtime is not configured for this workload.".into(),
        ))
    }
    async fn approval_requested(&self, _approval: &PendingApproval) -> Result<(), EngineError> {
        Ok(())
    }
}

pub fn validate_egress_url(value: &str) -> Result<(), HostedRunnerError> {
    let url = Url::parse(value)
        .map_err(|_| HostedRunnerError::Policy(format!("invalid network origin: {value}")))?;
    if !matches!(url.scheme(), "http" | "https") || url.username() != "" || url.password().is_some()
    {
        return Err(HostedRunnerError::Policy(format!(
            "dangerous network origin: {value}"
        )));
    }
    match url.host() {
        Some(Host::Ipv4(ip))
            if ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_unspecified()
                || ip.is_broadcast()
                || ip.octets() == [169, 254, 169, 254] =>
        {
            Err(HostedRunnerError::Policy(format!(
                "private or metadata address is blocked: {ip}"
            )))
        }
        Some(Host::Ipv6(ip)) if ip.is_loopback() || ip.is_unspecified() || is_private_ipv6(ip) => {
            Err(HostedRunnerError::Policy(format!(
                "private or link-local address is blocked: {ip}"
            )))
        }
        Some(Host::Domain(domain))
            if domain.eq_ignore_ascii_case("localhost") || domain.ends_with(".localhost") =>
        {
            Err(HostedRunnerError::Policy("localhost is blocked".into()))
        }
        Some(_) => Ok(()),
        None => Err(HostedRunnerError::Policy(
            "network origin requires a host".into(),
        )),
    }
}

fn is_private_ipv6(ip: std::net::Ipv6Addr) -> bool {
    ip.is_unique_local()
        || ip.is_unicast_link_local()
        || matches!(
            IpAddr::V6(ip).to_string().as_str(),
            "::ffff:169.254.169.254"
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use sandbox_engine::{
        ExecutionStatus, PermissionSummary, Position, WorkflowEdge, WorkflowOwner,
        WorkflowSettings, CURRENT_SCHEMA_VERSION,
    };

    fn workflow(node_type: &str) -> Workflow {
        let trigger = WorkflowNode {
            id: "trigger".into(),
            node_type: "manual_trigger".into(),
            version: 1,
            name: "Manual".into(),
            position: Position { x: 0.0, y: 0.0 },
            configuration: serde_json::json!({}),
            disabled: false,
            input_bindings: Default::default(),
            plugin: None,
            customization: None,
            error_policy: None,
        };
        let action = WorkflowNode {
            id: "action".into(),
            node_type: node_type.into(),
            version: 1,
            name: "Action".into(),
            position: Position { x: 1.0, y: 0.0 },
            configuration: if node_type == "set_data" {
                serde_json::json!({"values":{"answer":42}})
            } else {
                serde_json::json!({})
            },
            disabled: false,
            input_bindings: Default::default(),
            plugin: None,
            customization: None,
            error_policy: None,
        };
        Workflow {
            id: "workflow".into(),
            schema_version: CURRENT_SCHEMA_VERSION,
            owner: WorkflowOwner::default(),
            name: "Hosted".into(),
            description: String::new(),
            enabled: true,
            trigger_node_id: "trigger".into(),
            nodes: vec![trigger, action],
            edges: vec![WorkflowEdge {
                id: "edge".into(),
                source_node_id: "trigger".into(),
                source_handle: "output".into(),
                target_node_id: "action".into(),
                target_handle: "input".into(),
                kind: "control".into(),
                source_port: Some("output".into()),
                target_port: Some("input".into()),
            }],
            settings: WorkflowSettings {
                default_node_timeout_ms: 5_000,
                max_concurrent_nodes: 1,
                permissions: PermissionSummary::default(),
                ..WorkflowSettings::default()
            },
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }
    fn request(node_type: &str) -> WorkloadRequest {
        WorkloadRequest {
            workflow: workflow(node_type),
            trigger: serde_json::json!({"source":"test"}),
            policy: IsolationPolicy {
                workspace_id: "workspace".into(),
                environment_id: "environment".into(),
                deployment_id: "deployment".into(),
                workflow_revision_id: "revision".into(),
                execution_id: "execution".into(),
                region: "eu-west-2".into(),
                cpu_millis: 500,
                memory_bytes: 128 * 1024 * 1024,
                duration_seconds: 30,
                temporary_storage_bytes: 64 * 1024 * 1024,
                log_bytes: 1024 * 1024,
                artifact_bytes: 10 * 1024 * 1024,
                allowed_network_origins: vec!["https://api.example.com".into()],
                allow_private_network: false,
                plugin_capabilities: vec![],
                secret_grant_references: vec![],
            },
            plugins: vec![],
            connection_ids: vec![],
        }
    }

    #[test]
    fn rejects_local_browser_shell_and_private_network_capabilities() {
        for node in [
            "move_file",
            "run_command",
            "desktop_notification",
            "open_browser",
        ] {
            assert!(!validate_hosted_workflow(&request(node)).is_empty());
        }
        assert!(validate_egress_url("http://169.254.169.254/latest/meta-data").is_err());
        assert!(validate_egress_url("http://127.0.0.1").is_err());
        assert!(validate_egress_url("https://api.example.com").is_ok());
    }
    #[test]
    fn destroys_temporary_filesystem_on_drop() {
        let path = {
            let sandbox = WorkloadSandbox::create().unwrap();
            let path = sandbox.path().to_path_buf();
            std::fs::write(path.join("temporary"), "data").unwrap();
            path
        };
        assert!(!path.exists());
    }
    #[tokio::test]
    async fn executes_the_same_engine_workflow_semantics() {
        let result = HostedRunner::default()
            .execute(request("set_data"), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(result.status, ExecutionStatus::Successful);
        assert_eq!(
            result
                .node_executions
                .iter()
                .find(|node| node.node_id == "action")
                .unwrap()
                .output,
            serde_json::json!({"answer":42})
        );
    }

    #[tokio::test]
    async fn hosted_runner_uses_the_shared_collection_runtime() {
        let mut workload=request("filter");
        workload.workflow.nodes[1].configuration=serde_json::json!({"rules":[{"field":"event.source","operator":"equals","value":"test"}]});
        assert!(validate_hosted_workflow(&workload).is_empty());
        let result=HostedRunner::default().execute(workload,CancellationToken::new()).await.unwrap();
        let filtered=result.node_executions.iter().find(|node|node.node_id=="action").unwrap();
        assert_eq!(filtered.collection.as_ref().unwrap().input_item_count,1);
        assert_eq!(filtered.collection.as_ref().unwrap().output_item_count,1);
    }
}
