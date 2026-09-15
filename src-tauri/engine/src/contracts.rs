use crate::model::{NodeCustomization, ValueType, Workflow, WorkflowNode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    Annotation,
    Trigger,
    Action,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EffectLevel {
    Pure,
    Read,
    Write,
    Destructive,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RetrySafety {
    Safe,
    Unsafe,
    IdempotencyRequired,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GateState {
    Available,
    SetupRequired,
    Blocked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContractPort {
    pub key: String,
    pub label: String,
    #[serde(rename = "type")]
    pub value_type: ValueType,
    pub required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeContract {
    pub node_type: String,
    pub version: u32,
    pub display_name: String,
    pub kind: NodeKind,
    pub inputs: Vec<ContractPort>,
    pub outputs: Vec<ContractPort>,
    pub branches: Vec<String>,
    pub configuration_schema: Value,
    pub placements: Vec<String>,
    pub requirements: Vec<String>,
    pub effect_level: EffectLevel,
    pub retry_safety: RetrySafety,
    pub customizable: bool,
    pub inspector_strategy: String,
    pub test_fixture: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeGate {
    pub state: GateState,
    pub code: String,
    pub message: String,
    pub remediation: Option<String>,
}

fn port(key: &str, label: &str, value_type: ValueType, required: bool) -> ContractPort {
    ContractPort {
        key: key.into(),
        label: label.into(),
        value_type,
        required,
    }
}

fn contract(node_type: &str, display_name: &str, kind: NodeKind) -> NodeContract {
    NodeContract {
        node_type: node_type.into(),
        version: 1,
        display_name: display_name.into(),
        kind,
        inputs: if matches!(kind, NodeKind::Action) {
            vec![port("input", "Input", ValueType::Any, false)]
        } else {
            vec![]
        },
        outputs: if matches!(kind, NodeKind::Annotation) {
            vec![]
        } else {
            vec![port("result", "Result", ValueType::Any, false)]
        },
        branches: vec![],
        configuration_schema: json!({"type":"object","additionalProperties":true}),
        placements: vec![
            "local".into(),
            "paired_runner".into(),
            "hosted_runner".into(),
        ],
        requirements: vec![],
        effect_level: EffectLevel::Pure,
        retry_safety: RetrySafety::Safe,
        customizable: matches!(
            node_type,
            "condition"
                | "filter"
                | "switch"
                | "split_out"
                | "aggregate"
                | "merge"
                | "remove_duplicates"
                | "set_data"
                | "map_fields"
                | "validate_schema"
                | "text_template"
                | "hash_data"
        ),
        inspector_strategy: if node_type == "note" {
            "note"
        } else {
            "builtin"
        }
        .into(),
        test_fixture: json!({"input":{},"items":[]}),
    }
}

/// The engine registry is the source of truth for editor ports, placement, retry,
/// and customization decisions. Frontends obtain the same snapshot through IPC.
pub fn node_contracts() -> Vec<NodeContract> {
    let mut result = Vec::new();
    result.push(contract("note", "Note", NodeKind::Annotation));
    for (node_type, name) in [
        ("manual_trigger", "Manual Trigger"),
        ("schedule_trigger", "Schedule Trigger"),
        ("file_watch_trigger", "File Watch Trigger"),
        ("gmail_new_email_trigger", "New Email"),
    ] {
        result.push(contract(node_type, name, NodeKind::Trigger));
    }
    for (node_type, name) in [
        ("condition", "Condition"),
        ("filter", "Filter"),
        ("switch", "Switch"),
        ("loop_over_items", "Loop Over Items"),
        ("split_out", "Split Out"),
        ("aggregate", "Aggregate"),
        ("merge", "Merge"),
        ("remove_duplicates", "Remove Duplicates"),
        ("set_data", "Set Data"),
        ("map_fields", "Map Fields"),
        ("validate_schema", "Validate Schema"),
        ("text_template", "Text Template"),
        ("hash_data", "Hash Data"),
        ("delay", "Delay"),
        ("http_request", "HTTP Request"),
        ("desktop_notification", "Desktop Notification"),
        ("move_file", "Move File"),
        ("read_file", "Read File"),
        ("write_file", "Write File"),
        ("copy_path", "Copy File or Folder"),
        ("delete_path", "Delete File or Folder"),
        ("list_folder", "List Folder"),
        ("parse_csv", "Parse CSV"),
        ("parse_json", "Parse JSON"),
        ("parse_text", "Parse Text"),
        ("get_workflow_state", "Get Workflow State"),
        ("set_workflow_state", "Set Workflow State"),
        ("compare_previous", "Compare With Previous"),
        ("run_command", "Run Command"),
        ("ai_prompt", "AI"),
        ("code", "Code / Source (legacy)"),
        ("javascript_code", "JavaScript Code"),
        ("python_code", "Python Code"),
        ("web_builder", "Web Builder"),
        ("open_browser", "Open Browser"),
        ("navigate", "Navigate"),
        ("click_element", "Click Element"),
        ("fill_field", "Fill Field"),
        ("select_option", "Select Option"),
        ("press_key", "Press Key"),
        ("wait_for", "Wait For"),
        ("extract_data", "Extract Data"),
        ("screenshot", "Screenshot"),
        ("download_file", "Download File"),
        ("upload_file", "Upload File"),
        ("close_browser", "Close Browser"),
        ("gmail_get_email", "Get Email"),
        ("gmail_create_draft", "Create Gmail Draft"),
        ("gmail_send_email", "Send Email"),
        ("gmail_add_label", "Add Gmail Label"),
        ("discord_webhook", "Discord Webhook"),
        ("discord_embed", "Discord Embed"),
        ("slack_webhook", "Slack Webhook"),
        ("approval", "Manual Approval"),
        ("custom_function", "Custom Function"),
    ] {
        result.push(contract(node_type, name, NodeKind::Action));
    }

    let mut by_type: BTreeMap<String, NodeContract> = result
        .into_iter()
        .map(|item| (item.node_type.clone(), item))
        .collect();
    let mut set_ports = |node_type: &str,
                         inputs: Vec<ContractPort>,
                         outputs: Vec<ContractPort>,
                         branches: &[&str]| {
        if let Some(item) = by_type.get_mut(node_type) {
            item.inputs = inputs;
            item.outputs = outputs;
            item.branches = branches.iter().map(|value| (*value).into()).collect();
        }
    };
    set_ports(
        "condition",
        vec![
            port("left", "Value", ValueType::Any, true),
            port("right", "Compare with", ValueType::Any, false),
        ],
        vec![port("result", "Result", ValueType::Boolean, false)],
        &["true", "false"],
    );
    set_ports(
        "filter",
        vec![port("items", "Items", ValueType::Array, true)],
        vec![
            port("output", "Retained", ValueType::Array, false),
            port("rejected", "Rejected", ValueType::Array, false),
        ],
        &["output", "rejected"],
    );
    set_ports(
        "switch",
        vec![port("items", "Items", ValueType::Array, true)],
        vec![port("fallback", "Fallback", ValueType::Array, false)],
        &["fallback"],
    );
    set_ports(
        "loop_over_items",
        vec![port("items", "Items", ValueType::Array, true)],
        vec![
            port("loop", "Loop", ValueType::Array, false),
            port("done", "Done", ValueType::Array, false),
        ],
        &["loop", "done"],
    );
    set_ports(
        "split_out",
        vec![port("items", "Items", ValueType::Array, true)],
        vec![
            port("output", "Items", ValueType::Array, false),
            port("rejected", "Rejected", ValueType::Array, false),
        ],
        &["output", "rejected"],
    );
    set_ports(
        "aggregate",
        vec![port("items", "Items", ValueType::Array, true)],
        vec![port("value", "Aggregate", ValueType::Any, false)],
        &[],
    );
    set_ports(
        "merge",
        vec![
            port("input_a", "Input A", ValueType::Array, true),
            port("input_b", "Input B", ValueType::Array, true),
        ],
        vec![port("output", "Merged", ValueType::Array, false)],
        &[],
    );
    set_ports(
        "remove_duplicates",
        vec![port("items", "Items", ValueType::Array, true)],
        vec![
            port("output", "Unique", ValueType::Array, false),
            port("duplicates", "Duplicates", ValueType::Array, false),
        ],
        &["output", "duplicates"],
    );
    set_ports(
        "set_data",
        vec![port("values", "Object", ValueType::Object, false)],
        vec![port("value", "Object", ValueType::Object, false)],
        &[],
    );
    set_ports(
        "map_fields",
        vec![port("input", "Input object", ValueType::Object, true)],
        vec![
            port("value", "Mapped object", ValueType::Object, false),
            port("mappedCount", "Mapped fields", ValueType::Number, false),
        ],
        &[],
    );
    set_ports(
        "validate_schema",
        vec![port("input", "Value", ValueType::Any, true)],
        vec![
            port("isValid", "Is valid", ValueType::Boolean, false),
            port("value", "Value", ValueType::Any, false),
            port("errors", "Errors", ValueType::Array, false),
        ],
        &["valid", "invalid"],
    );
    set_ports(
        "text_template",
        vec![port("input", "Template data", ValueType::Any, false)],
        vec![port("text", "Rendered text", ValueType::String, false)],
        &[],
    );
    set_ports(
        "hash_data",
        vec![port("input", "Value", ValueType::Any, true)],
        vec![
            port("hash", "SHA-256 hash", ValueType::String, false),
            port("bytes", "Canonical bytes", ValueType::Number, false),
        ],
        &[],
    );
    set_ports(
        "http_request",
        vec![
            port("url", "URL", ValueType::String, true),
            port("body", "Body", ValueType::Any, false),
        ],
        vec![
            port("status", "Status", ValueType::Number, false),
            port("body", "Body", ValueType::Any, false),
            port("finalUrl", "Final URL", ValueType::String, false),
        ],
        &[],
    );
    set_ports(
        "code",
        vec![port("input", "Input", ValueType::Any, false)],
        vec![
            port("code", "Source code", ValueType::String, false),
            port("result", "Result", ValueType::Any, false),
        ],
        &[],
    );
    set_ports(
        "javascript_code",
        vec![port("input", "Input items", ValueType::Any, false)],
        vec![
            port("items", "Output items", ValueType::Array, false),
            port("result", "Result", ValueType::Any, false),
        ],
        &[],
    );
    set_ports(
        "python_code",
        vec![port("input", "Input items", ValueType::Any, false)],
        vec![
            port("items", "Output items", ValueType::Array, false),
            port("result", "Result", ValueType::Any, false),
        ],
        &[],
    );
    set_ports("custom_function", vec![], vec![], &[]);
    set_ports(
        "web_builder",
        vec![
            port("html", "HTML", ValueType::String, true),
            port("javascript", "JavaScript", ValueType::String, true),
            port("css", "CSS", ValueType::String, true),
        ],
        vec![
            port("url", "Localhost URL", ValueType::String, false),
            port("port", "Port", ValueType::Number, false),
            port("status", "Server status", ValueType::String, false),
        ],
        &[],
    );

    let browser: BTreeSet<&str> = [
        "open_browser",
        "navigate",
        "click_element",
        "fill_field",
        "select_option",
        "press_key",
        "wait_for",
        "extract_data",
        "screenshot",
        "download_file",
        "upload_file",
        "close_browser",
    ]
    .into_iter()
    .collect();
    let local_only: BTreeSet<&str> = [
        "ai_prompt",
        "javascript_code",
        "python_code",
        "custom_function",
        "web_builder",
    ]
    .into_iter()
    .collect();
    let read: BTreeSet<&str> = [
        "http_request",
        "read_file",
        "list_folder",
        "parse_csv",
        "parse_json",
        "parse_text",
        "get_workflow_state",
        "gmail_get_email",
        "extract_data",
        "screenshot",
    ]
    .into_iter()
    .collect();
    let write: BTreeSet<&str> = [
        "desktop_notification",
        "move_file",
        "write_file",
        "copy_path",
        "set_workflow_state",
        "compare_previous",
        "gmail_create_draft",
        "gmail_send_email",
        "gmail_add_label",
        "discord_webhook",
        "discord_embed",
        "slack_webhook",
        "approval",
        "download_file",
        "upload_file",
    ]
    .into_iter()
    .collect();
    let destructive: BTreeSet<&str> = ["delete_path", "run_command"].into_iter().collect();
    for item in by_type.values_mut() {
        if browser.contains(item.node_type.as_str()) {
            item.placements = vec![
                "local".into(),
                "paired_runner".into(),
                "managed_browser".into(),
            ];
            item.requirements.push("browser_runtime".into());
        }
        if local_only.contains(item.node_type.as_str()) {
            item.placements = vec!["local".into()];
        }
        if item.node_type.starts_with("gmail_") {
            item.requirements.push("gmail_connection".into());
        }
        if item.node_type.starts_with("discord_") {
            item.requirements.push("discord_connection".into());
        }
        if item.node_type == "slack_webhook" {
            item.requirements.push("slack_connection".into());
        }
        if item.node_type == "ai_prompt" {
            item.requirements.push("ai_connection".into());
        }
        if read.contains(item.node_type.as_str()) {
            item.effect_level = EffectLevel::Read;
        }
        if write.contains(item.node_type.as_str()) {
            item.effect_level = EffectLevel::Write;
            item.retry_safety = RetrySafety::IdempotencyRequired;
        }
        if destructive.contains(item.node_type.as_str()) {
            item.effect_level = EffectLevel::Destructive;
            item.retry_safety = RetrySafety::Unsafe;
        }
        if item.node_type == "custom_function" {
            item.customizable = false;
            item.inspector_strategy = "custom_function".into();
        }
        item.test_fixture = match item.node_type.as_str() {
            "map_fields" => {
                json!({"input":{"first_name":"Ada"},"configuration":{"mappings":[{"source":"first_name","target":"name","required":true}]}})
            }
            "validate_schema" => {
                json!({"input":{"id":1},"configuration":{"rules":[{"path":"id","type":"number","required":true}]}})
            }
            "text_template" => {
                json!({"input":{"name":"Ada"},"configuration":{"template":"Hello {{input.name}}"}})
            }
            "hash_data" => json!({"input":{"stable":true}}),
            _ => item.test_fixture.clone(),
        };
    }
    by_type.into_values().collect()
}

pub fn contract_for(node_type: &str) -> Option<NodeContract> {
    node_contracts()
        .into_iter()
        .find(|item| item.node_type == node_type)
}

pub fn gate_node(node: &WorkflowNode, placement: &str) -> NodeGate {
    let Some(contract) = contract_for(&node.node_type) else {
        return NodeGate {
            state: GateState::Blocked,
            code: "unknown_node_contract".into(),
            message: format!("No contract is registered for {}.", node.node_type),
            remediation: Some(
                "Install or re-enable the matching plugin, or replace this node.".into(),
            ),
        };
    };
    if !contract
        .placements
        .iter()
        .any(|candidate| candidate == placement)
    {
        return NodeGate {
            state: GateState::Blocked,
            code: "unsupported_placement".into(),
            message: format!("{} cannot run on {}.", contract.display_name, placement),
            remediation: Some("Move the workflow to a supported runner.".into()),
        };
    }
    if node.node_type == "custom_function" && node.customization.is_none() {
        return NodeGate {
            state: GateState::Blocked,
            code: "custom_contract_missing".into(),
            message: "The custom function has no contract or source.".into(),
            remediation: Some("Open the ƒx editor and define the contract.".into()),
        };
    }
    if node.disabled {
        return NodeGate {
            state: GateState::SetupRequired,
            code: "node_disabled".into(),
            message: "The node is disabled.".into(),
            remediation: Some("Enable the node when its setup is complete.".into()),
        };
    }
    for requirement in &contract.requirements {
        let configured = match requirement.as_str() {
            "gmail_connection" | "discord_connection" | "slack_connection" => node
                .configuration
                .get("credentialId")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.is_empty()),
            "ai_connection" => node
                .configuration
                .get("connectionId")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.is_empty()),
            "browser_runtime" => {
                node.node_type != "open_browser"
                    || node
                        .configuration
                        .get("profileId")
                        .and_then(Value::as_str)
                        .is_some_and(|value| !value.is_empty())
            }
            _ => true,
        };
        if !configured {
            return NodeGate {
                state: GateState::SetupRequired,
                code: format!("{}_required", requirement),
                message: format!(
                    "{} requires {}.",
                    contract.display_name,
                    requirement.replace('_', " ")
                ),
                remediation: Some("Complete setup in the node inspector.".into()),
            };
        }
    }
    NodeGate {
        state: GateState::Available,
        code: "available".into(),
        message: "Ready to configure or execute.".into(),
        remediation: None,
    }
}

fn setup_required(
    code: &str,
    message: impl Into<String>,
    remediation: impl Into<String>,
) -> NodeGate {
    NodeGate {
        state: GateState::SetupRequired,
        code: code.into(),
        message: message.into(),
        remediation: Some(remediation.into()),
    }
}

/// Evaluate workflow-scoped capabilities after the base contract gate. This is
/// deliberately shared by editor IPC and execution preflight so every surface
/// reports the same stable code and remediation.
pub fn gate_node_in_workflow(
    node: &WorkflowNode,
    workflow: &Workflow,
    placement: &str,
) -> NodeGate {
    let base = gate_node(node, placement);
    if base.state != GateState::Available {
        return base;
    }

    let permissions = &workflow.settings.permissions;
    let background_trigger = workflow.enabled
        && node.id == workflow.trigger_node_id
        && matches!(
            node.node_type.as_str(),
            "schedule_trigger" | "file_watch_trigger" | "gmail_new_email_trigger"
        );
    if background_trigger && !permissions.background_execution_permitted {
        return setup_required(
            "background_permission_required",
            format!(
                "{} needs permission to run while sndbox is in the tray.",
                node.name
            ),
            "Review workflow permissions and enable background execution.",
        );
    }

    let executes_code = node.node_type == "run_command"
        || (matches!(
            node.node_type.as_str(),
            "code" | "javascript_code" | "python_code"
        ) && node
            .configuration
            .get("executionMode")
            .and_then(Value::as_str)
            == Some("run"));
    if executes_code
        && (!permissions.command_execution_permitted || permissions.approval_revision.is_none())
    {
        return setup_required(
            "command_execution_approval_required",
            format!(
                "{} requires command execution approval for this workflow revision.",
                node.name
            ),
            "Review the executable or source code, then approve command execution.",
        );
    }

    let browser_node = matches!(
        node.node_type.as_str(),
        "open_browser"
            | "navigate"
            | "click_element"
            | "fill_field"
            | "select_option"
            | "press_key"
            | "wait_for"
            | "extract_data"
            | "screenshot"
            | "download_file"
            | "upload_file"
            | "close_browser"
    );
    if browser_node && !permissions.browser_automation_permitted {
        return setup_required(
            "browser_automation_approval_required",
            format!("{} requires browser automation approval.", node.name),
            "Review browser actions and approve automation for this workflow.",
        );
    }
    if node.node_type == "open_browser" {
        if let Some(profile_id) = node.configuration.get("profileId").and_then(Value::as_str) {
            if !profile_id.is_empty()
                && !permissions
                    .approved_browser_profile_ids
                    .iter()
                    .any(|approved| approved == profile_id)
            {
                return setup_required(
                    "browser_profile_approval_required",
                    format!("Browser profile '{profile_id}' is not approved for this workflow."),
                    "Approve this managed browser profile in workflow permissions.",
                );
            }
        }
    }

    let communicates = matches!(
        node.node_type.as_str(),
        "gmail_create_draft"
            | "gmail_send_email"
            | "discord_webhook"
            | "discord_embed"
            | "slack_webhook"
    );
    if communicates && !permissions.external_communication_permitted {
        return setup_required(
            "external_communication_approval_required",
            format!("{} can create or send external communication.", node.name),
            "Review recipients, content, and connection, then approve external communication.",
        );
    }
    if node.node_type == "gmail_send_email" && permissions.communication_approval_revision.is_none()
    {
        return setup_required(
            "communication_revision_approval_required",
            "Send Email has not been approved for this workflow revision.",
            "Review recipient and message logic, then renew communication approval.",
        );
    }

    let changes_external_data = matches!(
        node.node_type.as_str(),
        "gmail_create_draft" | "gmail_add_label"
    );
    if changes_external_data && !permissions.external_data_write_permitted {
        return setup_required(
            "external_data_write_approval_required",
            format!("{} changes data in a connected service.", node.name),
            "Review the provider operation, then approve external data writes.",
        );
    }

    if node.node_type == "http_request" {
        let approved = node
            .configuration
            .get("url")
            .and_then(Value::as_str)
            .and_then(|value| url::Url::parse(value).ok())
            .and_then(|value| value.host_str().map(str::to_string))
            .is_some_and(|host| {
                permissions
                    .approved_network_domains
                    .iter()
                    .any(|domain| domain == "*" || domain.eq_ignore_ascii_case(&host))
            });
        if !approved {
            return setup_required(
                "network_domain_approval_required",
                format!(
                    "{} targets a network domain that is not approved.",
                    node.name
                ),
                "Set a literal HTTP(S) URL or approve its domain in workflow permissions.",
            );
        }
    }

    let accesses_local_paths = matches!(
        node.node_type.as_str(),
        "file_watch_trigger"
            | "move_file"
            | "read_file"
            | "write_file"
            | "copy_path"
            | "delete_path"
            | "list_folder"
            | "download_file"
            | "upload_file"
    );
    if accesses_local_paths && permissions.approved_folders.is_empty() {
        return setup_required(
            "folder_access_approval_required",
            format!(
                "{} accesses local files but no folder is approved.",
                node.name
            ),
            "Choose the narrowest folder needed in workflow permissions.",
        );
    }

    base
}

pub fn value_types_compatible(source: &ValueType, target: &ValueType) -> bool {
    matches!(source, ValueType::Any) || matches!(target, ValueType::Any) || source == target
}

pub fn custom_node_fingerprint(customization: &NodeCustomization) -> String {
    let payload = serde_json::to_vec(&json!({
        "language": customization.language,
        "sourceCode": customization.source_code,
        "inputs": customization.inputs,
        "outputs": customization.outputs,
        "branches": customization.branches,
        "tests": customization.tests,
        "runtimeRequirement": customization.runtime_requirement,
    }))
    .expect("custom node fingerprint payload is serializable");
    format!("{:x}", Sha256::digest(payload))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_has_unique_corresponding_contracts() {
        let contracts = node_contracts();
        let unique: BTreeSet<_> = contracts
            .iter()
            .map(|item| item.node_type.as_str())
            .collect();
        assert_eq!(unique.len(), contracts.len());
        for contract in contracts {
            assert!(
                !contract.inspector_strategy.is_empty(),
                "{} has no inspector",
                contract.node_type
            );
            assert!(
                contract.configuration_schema.is_object(),
                "{} has no schema",
                contract.node_type
            );
            assert!(
                contract.test_fixture.is_object(),
                "{} has no fixture",
                contract.node_type
            );
        }
    }

    fn workflow_with(node_type: &str, configuration: Value) -> Workflow {
        serde_json::from_value(json!({
            "id":"workflow", "schemaVersion":7, "name":"Gate test", "description":"",
            "enabled":false, "triggerNodeId":"node", "createdAt":"2026-01-01T00:00:00Z",
            "updatedAt":"2026-01-01T00:00:00Z", "edges":[],
            "nodes":[{"id":"node","type":node_type,"version":1,"name":"Node","position":{"x":0,"y":0},"configuration":configuration,"disabled":false}],
            "settings":{"defaultNodeTimeoutMs":30000,"maxConcurrentNodes":4,"permissions":{}}
        })).expect("test workflow should deserialize")
    }

    #[test]
    fn workflow_gate_requires_the_same_command_approval_as_runtime() {
        let workflow = workflow_with("run_command", json!({"executable":"echo"}));
        let gate = gate_node_in_workflow(&workflow.nodes[0], &workflow, "local");
        assert_eq!(gate.state, GateState::SetupRequired);
        assert_eq!(gate.code, "command_execution_approval_required");
    }

    #[test]
    fn workflow_gate_checks_literal_network_domains() {
        let mut workflow = workflow_with(
            "http_request",
            json!({"url":"https://api.example.test/data"}),
        );
        let denied = gate_node_in_workflow(&workflow.nodes[0], &workflow, "local");
        assert_eq!(denied.code, "network_domain_approval_required");
        workflow
            .settings
            .permissions
            .approved_network_domains
            .push("api.example.test".into());
        assert_eq!(
            gate_node_in_workflow(&workflow.nodes[0], &workflow, "local").state,
            GateState::Available
        );
    }
}
