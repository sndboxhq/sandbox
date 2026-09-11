use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const CURRENT_SCHEMA_VERSION: u32 = 7;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InputBinding {
    Literal {
        value: Value,
    },
    NodeOutput {
        #[serde(rename = "nodeId", alias = "node_id")]
        node_id: String,
        #[serde(default)]
        path: Vec<String>,
    },
    Template {
        template: String,
    },
    ProtectedVariable {
        name: String,
    },
    Connection {
        #[serde(rename = "connectionId", alias = "connection_id")]
        connection_id: String,
    },
}

#[cfg(test)]
mod input_binding_tests {
    use super::InputBinding;
    use serde_json::json;

    #[test]
    fn node_output_uses_the_frontend_camel_case_shape() {
        let binding: InputBinding = serde_json::from_value(json!({
            "kind": "node_output",
            "nodeId": "request",
            "path": ["status"]
        }))
        .expect("camel-case node output binding should deserialize");

        assert_eq!(
            binding,
            InputBinding::NodeOutput {
                node_id: "request".into(),
                path: vec!["status".into()],
            }
        );
        let serialized = serde_json::to_value(binding).expect("binding should serialize");
        assert_eq!(serialized.get("nodeId"), Some(&json!("request")));
        assert!(serialized.get("node_id").is_none());
    }

    #[test]
    fn snake_case_binding_fields_remain_compatible() {
        let node_output: InputBinding = serde_json::from_value(json!({
            "kind": "node_output",
            "node_id": "request"
        }))
        .expect("legacy node output binding should deserialize");
        let connection: InputBinding = serde_json::from_value(json!({
            "kind": "connection",
            "connection_id": "account"
        }))
        .expect("legacy connection binding should deserialize");

        assert!(matches!(
            node_output,
            InputBinding::NodeOutput { ref node_id, .. } if node_id == "request"
        ));
        assert_eq!(
            connection,
            InputBinding::Connection {
                connection_id: "account".into(),
            }
        );
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ValueType {
    Any,
    String,
    Number,
    Boolean,
    Object,
    Array,
    Path,
    Connection,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CustomPortDefinition {
    pub key: String,
    pub label: String,
    pub value_type: ValueType,
    #[serde(default)]
    pub required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CustomNodeTest {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub inputs: Value,
    #[serde(default)]
    pub items: Vec<Value>,
    #[serde(default)]
    pub expected_outputs: Value,
    #[serde(default)]
    pub expected_branches: Value,
    #[serde(default)]
    pub expected_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NodeCustomization {
    pub source_type: String,
    pub source_version: u32,
    pub source_name: String,
    pub source_contract_hash: String,
    pub language: String,
    pub source_code: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub inputs: Vec<CustomPortDefinition>,
    #[serde(default)]
    pub outputs: Vec<CustomPortDefinition>,
    #[serde(default)]
    pub branches: Vec<CustomPortDefinition>,
    #[serde(default)]
    pub tests: Vec<CustomNodeTest>,
    #[serde(default = "default_custom_runtime_requirement")]
    pub runtime_requirement: String,
}

fn default_custom_runtime_requirement() -> String {
    ">=20".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorStrategy {
    Fail,
    Route,
    Fallback,
}

impl Default for ErrorStrategy {
    fn default() -> Self {
        Self::Fail
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RetryBackoff {
    Fixed,
    Exponential,
}

impl Default for RetryBackoff {
    fn default() -> Self {
        Self::Fixed
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NodeErrorPolicy {
    #[serde(default)]
    pub strategy: ErrorStrategy,
    #[serde(default)]
    pub max_retries: u8,
    #[serde(default)]
    pub retry_delay_ms: u64,
    #[serde(default)]
    pub backoff: RetryBackoff,
    #[serde(default)]
    pub fallback_outputs: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CustomNodeVerification {
    pub workflow_id: String,
    pub node_id: String,
    pub fingerprint: String,
    pub passed_at: DateTime<Utc>,
    pub output_coverage: Vec<String>,
    pub branch_coverage: Vec<String>,
    pub runtime_version: String,
}

impl Default for NodeErrorPolicy {
    fn default() -> Self {
        Self {
            strategy: ErrorStrategy::Fail,
            max_retries: 0,
            retry_delay_ms: 0,
            backoff: RetryBackoff::Fixed,
            fallback_outputs: Value::Object(Default::default()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowNode {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: String,
    pub version: u32,
    pub name: String,
    pub position: Position,
    #[serde(default)]
    pub configuration: Value,
    #[serde(default)]
    pub disabled: bool,
    /// Versioned, typed data mappings. Static configuration remains in
    /// `configuration`; bindings replace individual top-level fields at run
    /// time without embedding secret material in the workflow document.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub input_bindings: std::collections::BTreeMap<String, InputBinding>,
    /// Present only for third-party nodes. Built-in v0.1/v0.2 nodes keep this
    /// field absent and therefore require no migration choice from the user.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin: Option<PluginNodePin>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub customization: Option<NodeCustomization>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_policy: Option<NodeErrorPolicy>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginNodePin {
    pub plugin_id: String,
    pub plugin_version: String,
    pub package_integrity: String,
    pub publisher_id: String,
    /// Host-resolved node input mapping. References use the same expression
    /// syntax as built-in node configuration and default to an empty object.
    #[serde(default = "empty_object", skip_serializing_if = "is_empty_object")]
    pub input: Value,
    /// Friendly manifest references mapped to opaque host connection IDs. The
    /// referenced secret remains in the operating-system credential store.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub credential_references: std::collections::BTreeMap<String, String>,
}

fn empty_object() -> Value {
    Value::Object(Default::default())
}

fn is_empty_object(value: &Value) -> bool {
    value.as_object().is_some_and(serde_json::Map::is_empty)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowOwner {
    pub owner_type: String,
    pub owner_id: String,
}

impl Default for WorkflowOwner {
    fn default() -> Self {
        Self {
            owner_type: "personal".into(),
            owner_id: "local".into(),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PluginInstallState {
    Disabled,
    Enabled,
    Revoked,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    pub plugin_id: String,
    pub version: String,
    pub package_integrity: String,
    pub publisher_id: String,
    pub publisher_key_id: String,
    /// Public verification material retained so every execution can re-check
    /// the immutable package instead of trusting installation-time state.
    #[serde(skip, default)]
    pub publisher_public_key_pem: Option<String>,
    pub owner_type: String,
    pub owner_id: String,
    pub source: String,
    pub development: bool,
    pub state: PluginInstallState,
    pub manifest: Value,
    pub requested_permissions: Vec<String>,
    pub approved_permissions: Vec<String>,
    pub update_requires_review: bool,
    pub package_path: String,
    pub installed_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginRevocation {
    pub plugin_id: String,
    pub version: Option<String>,
    pub package_integrity: Option<String>,
    pub reason: String,
    pub security_notice_url: Option<String>,
    pub revoked_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowEdge {
    pub id: String,
    pub source_node_id: String,
    pub source_handle: String,
    pub target_node_id: String,
    pub target_handle: String,
    #[serde(default = "control_edge_kind")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_port: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_port: Option<String>,
}

fn control_edge_kind() -> String {
    "control".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CredentialReference {
    pub provider: String,
    pub key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PermissionSummary {
    #[serde(default)]
    pub approved_folders: Vec<String>,
    #[serde(default)]
    pub approved_network_domains: Vec<String>,
    #[serde(default)]
    pub command_execution_permitted: bool,
    #[serde(default)]
    pub background_execution_permitted: bool,
    #[serde(default)]
    pub approval_revision: Option<String>,
    #[serde(default)]
    pub approved_browser_profile_ids: Vec<String>,
    #[serde(default)]
    pub browser_automation_permitted: bool,
    #[serde(default)]
    pub external_communication_permitted: bool,
    #[serde(default)]
    pub external_data_write_permitted: bool,
    #[serde(default)]
    pub communication_approval_revision: Option<String>,
    /// Names only. Values are read by the runner at execution time and never
    /// persisted in the workflow document.
    #[serde(default)]
    pub approved_environment_variables: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowSettings {
    #[serde(default = "default_timeout")]
    pub default_node_timeout_ms: u64,
    #[serde(default = "default_concurrency")]
    pub max_concurrent_nodes: usize,
    #[serde(default)]
    pub permissions: PermissionSummary,
    #[serde(default = "default_expression_language_version")]
    pub expression_language_version: u32,
    #[serde(default)]
    pub collection_limits: CollectionLimits,
}
fn default_timeout() -> u64 {
    30_000
}
fn default_concurrency() -> usize {
    4
}
fn default_expression_language_version() -> u32 {
    1
}
impl Default for WorkflowSettings {
    fn default() -> Self {
        Self {
            default_node_timeout_ms: default_timeout(),
            max_concurrent_nodes: default_concurrency(),
            permissions: PermissionSummary::default(),
            expression_language_version: default_expression_language_version(),
            collection_limits: CollectionLimits::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CollectionLimits {
    #[serde(default = "default_max_collection_items")]
    pub max_input_items: usize,
    #[serde(default = "default_max_collection_items")]
    pub max_result_items: usize,
    #[serde(default = "default_max_item_bytes")]
    pub max_item_bytes: usize,
    #[serde(default = "default_max_aggregate_bytes")]
    pub max_aggregate_bytes: usize,
    #[serde(default = "default_max_cartesian_items")]
    pub max_cartesian_items: usize,
    #[serde(default = "default_max_loop_iterations")]
    pub max_loop_iterations: usize,
    #[serde(default = "default_max_loop_concurrency")]
    pub max_loop_concurrency: usize,
    #[serde(default = "default_max_deduplication_keys")]
    pub max_deduplication_keys: usize,
    #[serde(default = "default_max_history_previews")]
    pub max_history_item_previews: usize,
}

impl Default for CollectionLimits {
    fn default() -> Self {
        Self {
            max_input_items: default_max_collection_items(),
            max_result_items: default_max_collection_items(),
            max_item_bytes: default_max_item_bytes(),
            max_aggregate_bytes: default_max_aggregate_bytes(),
            max_cartesian_items: default_max_cartesian_items(),
            max_loop_iterations: default_max_loop_iterations(),
            max_loop_concurrency: default_max_loop_concurrency(),
            max_deduplication_keys: default_max_deduplication_keys(),
            max_history_item_previews: default_max_history_previews(),
        }
    }
}

fn default_max_collection_items() -> usize {
    10_000
}
fn default_max_item_bytes() -> usize {
    1_048_576
}
fn default_max_aggregate_bytes() -> usize {
    16_777_216
}
fn default_max_cartesian_items() -> usize {
    25_000
}
fn default_max_loop_iterations() -> usize {
    10_000
}
fn default_max_loop_concurrency() -> usize {
    16
}
fn default_max_deduplication_keys() -> usize {
    50_000
}
fn default_max_history_previews() -> usize {
    100
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Workflow {
    pub id: String,
    pub schema_version: u32,
    #[serde(default)]
    pub owner: WorkflowOwner,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub enabled: bool,
    pub trigger_node_id: String,
    pub nodes: Vec<WorkflowNode>,
    pub edges: Vec<WorkflowEdge>,
    #[serde(default)]
    pub settings: WorkflowSettings,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionStatus {
    Queued,
    Running,
    Successful,
    SuccessfulWithWarnings,
    Failed,
    Skipped,
    Cancelled,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NodeStatus {
    Idle,
    Waiting,
    Running,
    Successful,
    Handled,
    Failed,
    Skipped,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggestion: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct BinaryReference {
    pub reference: String,
    #[serde(default)]
    pub file_name: Option<String>,
    #[serde(default)]
    pub content_type: Option<String>,
    #[serde(default)]
    pub size_bytes: Option<u64>,
    #[serde(default)]
    pub sha256: Option<String>,
}

/// Canonical runtime unit used by Code nodes and persisted inspection data.
/// `data` remains JSON while large bytes live behind scoped artifact grants.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowItem {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub item_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_item_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_item_id: Option<String>,
    #[serde(default)]
    pub data: Value,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub binary: std::collections::BTreeMap<String, BinaryReference>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_node_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_item_index: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_position: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_position: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub branch_history: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loop_iteration: Option<usize>,
    #[serde(default = "default_execution_attempt")]
    pub execution_attempt: u32,
    #[serde(default = "default_item_status")]
    pub status: String,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub trusted_paths: std::collections::BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub correlations: std::collections::BTreeMap<String, String>,
}

fn default_execution_attempt() -> u32 {
    1
}
fn default_item_status() -> String {
    "successful".into()
}

impl WorkflowItem {
    pub fn json(data: Value) -> Self {
        Self {
            item_id: String::new(),
            origin_item_id: None,
            parent_item_id: None,
            data,
            binary: Default::default(),
            source_node_id: None,
            source_item_index: None,
            original_position: None,
            current_position: None,
            branch: None,
            branch_history: vec![],
            loop_iteration: None,
            execution_attempt: 1,
            status: default_item_status(),
            trusted_paths: Default::default(),
            correlations: Default::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CollectionEvidence {
    pub input_item_count: usize,
    pub output_item_count: usize,
    #[serde(default)]
    pub rejected_item_count: usize,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub branch_counts: std::collections::BTreeMap<String, usize>,
    #[serde(default)]
    pub iteration_count: usize,
    #[serde(default)]
    pub batch_count: usize,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sample_items: Vec<WorkflowItem>,
    #[serde(default)]
    pub preview_truncated: bool,
    #[serde(default)]
    pub runtime_data_truncated: bool,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub ordering_policy: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub waiting_for_inputs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeMetadata {
    pub runtime: String,
    pub runtime_version: String,
    pub helper_language_version: u32,
    pub dependency_environment_id: String,
    pub execution_mode: String,
    #[serde(default)]
    pub output_bytes: u64,
    #[serde(default)]
    pub log_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DataLineage {
    pub source: String,
    #[serde(default)]
    pub path: Vec<String>,
    #[serde(default)]
    pub target_field: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NodeExecution {
    pub node_id: String,
    pub status: NodeStatus,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub duration_ms: Option<u64>,
    #[serde(default)]
    pub input: Value,
    #[serde(default)]
    pub output: Value,
    #[serde(default)]
    pub logs: Vec<String>,
    #[serde(default)]
    pub retry_count: u32,
    pub error: Option<ExecutionError>,
    pub skip_reason: Option<String>,
    pub branch_followed: Option<String>,
    #[serde(default)]
    pub browser_diagnostics: Option<BrowserDiagnostics>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub input_items: Vec<WorkflowItem>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub output_items: Vec<WorkflowItem>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub lineage: Vec<DataLineage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<RuntimeMetadata>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub test_data_source: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capability_usage: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collection: Option<CollectionEvidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionRecord {
    pub id: String,
    pub workflow_id: String,
    pub workflow_version: u32,
    pub trigger: Value,
    pub status: ExecutionStatus,
    pub started_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
    pub duration_ms: Option<u64>,
    pub node_executions: Vec<NodeExecution>,
    pub error: Option<ExecutionError>,
    pub skip_reason: Option<String>,
    #[serde(default)]
    pub recovered_after_crash: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowSummary {
    pub workflow: Workflow,
    pub metadata: WorkflowMetadata,
    pub last_execution: Option<ExecutionRecord>,
    pub next_run_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRevisionSummary {
    pub revision_id: String,
    pub workflow_id: String,
    pub parent_revision_id: Option<String>,
    pub schema_version: u32,
    pub content_hash: String,
    pub change_summary: String,
    pub created_at: DateTime<Utc>,
    pub current: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowMetadata {
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub folder: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub archived_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub last_opened_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowMetadataPatch {
    pub favorite: Option<bool>,
    pub folder: Option<Option<String>>,
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub add_tags: Option<Vec<String>>,
    #[serde(default)]
    pub remove_tags: Option<Vec<String>>,
    pub archived_at: Option<Option<DateTime<Utc>>>,
    pub last_opened_at: Option<Option<DateTime<Utc>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserProfileSettings {
    #[serde(default = "default_viewport_width")]
    pub viewport_width: u32,
    #[serde(default = "default_viewport_height")]
    pub viewport_height: u32,
    #[serde(default)]
    pub download_folder: Option<String>,
    #[serde(default)]
    pub proxy: Option<String>,
    #[serde(default)]
    pub user_agent: Option<String>,
    #[serde(default)]
    pub permissions: Vec<String>,
}
fn default_viewport_width() -> u32 {
    1280
}
fn default_viewport_height() -> u32 {
    800
}
impl Default for BrowserProfileSettings {
    fn default() -> Self {
        Self {
            viewport_width: default_viewport_width(),
            viewport_height: default_viewport_height(),
            download_folder: None,
            proxy: None,
            user_agent: None,
            permissions: vec![],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserProfile {
    pub id: String,
    pub name: String,
    pub persistent: bool,
    pub data_path: String,
    #[serde(default)]
    pub settings: BrowserProfileSettings,
    pub created_at: DateTime<Utc>,
    pub last_used_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSession {
    pub session_id: String,
    pub profile_id: String,
    pub context_id: String,
    pub page_id: String,
    pub current_url: String,
    pub started_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum LocatorKind {
    Role,
    Label,
    Placeholder,
    TestId,
    Text,
    Attribute,
    Css,
    XPath,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocatorCandidate {
    pub kind: LocatorKind,
    pub value: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub exact: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StructuredLocator {
    pub primary: LocatorCandidate,
    #[serde(default)]
    pub alternatives: Vec<LocatorCandidate>,
    #[serde(default)]
    pub element_role: Option<String>,
    #[serde(default)]
    pub accessible_name: Option<String>,
    pub tag: String,
    #[serde(default)]
    pub stable_attributes: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub frame_path: Vec<String>,
    pub recording_url: String,
    #[serde(default)]
    pub nearby_text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct LocatorAttempt {
    pub kind: String,
    pub value: String,
    pub match_count: usize,
    pub succeeded: bool,
    #[serde(default)]
    pub weak_fallback: bool,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDiagnostics {
    #[serde(default)]
    pub current_url: String,
    #[serde(default)]
    pub page_title: String,
    #[serde(default)]
    pub locator_attempts: Vec<LocatorAttempt>,
    #[serde(default)]
    pub successful_locator: Option<LocatorCandidate>,
    #[serde(default)]
    pub match_count: usize,
    #[serde(default)]
    pub console_errors: Vec<String>,
    #[serde(default)]
    pub failed_network_requests: Vec<String>,
    #[serde(default)]
    pub screenshot_path: Option<String>,
    #[serde(default)]
    pub trace_path: Option<String>,
    #[serde(default)]
    pub playwright_error: Option<String>,
    #[serde(default)]
    pub unexpected_navigation: bool,
    #[serde(default)]
    pub rerecord_available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionStatus {
    Connected,
    Expired,
    Revoked,
    Error,
    SetupRequired,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionMetadata {
    pub id: String,
    pub provider: String,
    pub display_name: String,
    pub account_identifier: Option<String>,
    #[serde(default)]
    pub scopes: Vec<String>,
    pub created_at: DateTime<Utc>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub expires_at: Option<DateTime<Utc>>,
    pub status: ConnectionStatus,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PendingApproval {
    pub id: String,
    pub execution_id: String,
    pub workflow_id: String,
    pub node_id: String,
    pub action: Value,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub resolved_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecordedStep {
    pub id: String,
    pub action: String,
    pub name: String,
    pub configuration: Value,
    #[serde(default)]
    pub sensitive_input_required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecordedWorkflowDraft {
    pub id: String,
    pub workflow_id: Option<String>,
    pub profile_id: String,
    pub status: String,
    #[serde(default)]
    pub steps: Vec<RecordedStep>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
