use crate::model::{NodeCustomization, ValueType, WorkflowNode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use sha2::{Digest, Sha256};

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
    ContractPort { key: key.into(), label: label.into(), value_type, required }
}

fn contract(node_type: &str, display_name: &str, kind: NodeKind) -> NodeContract {
    NodeContract {
        node_type: node_type.into(),
        version: 1,
        display_name: display_name.into(),
        kind,
        inputs: if matches!(kind, NodeKind::Action) { vec![port("input", "Input", ValueType::Any, false)] } else { vec![] },
        outputs: if matches!(kind, NodeKind::Annotation) { vec![] } else { vec![port("result", "Result", ValueType::Any, false)] },
        branches: vec![],
        configuration_schema: json!({"type":"object","additionalProperties":true}),
        placements: vec!["local".into(), "paired_runner".into(), "hosted_runner".into()],
        requirements: vec![],
        effect_level: EffectLevel::Pure,
        retry_safety: RetrySafety::Safe,
        customizable: matches!(node_type, "condition" | "filter" | "switch" | "split_out" | "aggregate" | "merge" | "remove_duplicates" | "set_data"),
        inspector_strategy: if node_type == "note" { "note" } else { "builtin" }.into(),
        test_fixture: json!({"input":{},"items":[]}),
    }
}

/// The engine registry is the source of truth for editor ports, placement, retry,
/// and customization decisions. Frontends obtain the same snapshot through IPC.
pub fn node_contracts() -> Vec<NodeContract> {
    let mut result = Vec::new();
    result.push(contract("note", "Note", NodeKind::Annotation));
    for (node_type, name) in [
        ("manual_trigger", "Manual Trigger"), ("schedule_trigger", "Schedule Trigger"),
        ("file_watch_trigger", "File Watch Trigger"), ("gmail_new_email_trigger", "New Email"),
    ] { result.push(contract(node_type, name, NodeKind::Trigger)); }
    for (node_type, name) in [
        ("condition", "Condition"), ("filter", "Filter"), ("switch", "Switch"),
        ("loop_over_items", "Loop Over Items"), ("split_out", "Split Out"),
        ("aggregate", "Aggregate"), ("merge", "Merge"), ("remove_duplicates", "Remove Duplicates"),
        ("set_data", "Set Data"), ("delay", "Delay"), ("http_request", "HTTP Request"),
        ("desktop_notification", "Desktop Notification"), ("move_file", "Move File"),
        ("read_file", "Read File"), ("write_file", "Write File"), ("copy_path", "Copy File or Folder"),
        ("delete_path", "Delete File or Folder"), ("list_folder", "List Folder"),
        ("parse_csv", "Parse CSV"), ("parse_json", "Parse JSON"), ("parse_text", "Parse Text"),
        ("get_workflow_state", "Get Workflow State"), ("set_workflow_state", "Set Workflow State"),
        ("compare_previous", "Compare With Previous"), ("run_command", "Run Command"),
        ("ai_prompt", "AI"), ("code", "Code / Source (legacy)"),
        ("javascript_code", "JavaScript Code"), ("python_code", "Python Code"),
        ("web_builder", "Web Builder"), ("open_browser", "Open Browser"),
        ("navigate", "Navigate"), ("click_element", "Click Element"), ("fill_field", "Fill Field"),
        ("select_option", "Select Option"), ("press_key", "Press Key"), ("wait_for", "Wait For"),
        ("extract_data", "Extract Data"), ("screenshot", "Screenshot"),
        ("download_file", "Download File"), ("upload_file", "Upload File"),
        ("close_browser", "Close Browser"), ("gmail_get_email", "Get Email"),
        ("gmail_create_draft", "Create Gmail Draft"), ("gmail_send_email", "Send Email"),
        ("gmail_add_label", "Add Gmail Label"), ("discord_webhook", "Discord Webhook"),
        ("discord_embed", "Discord Embed"), ("slack_webhook", "Slack Webhook"),
        ("approval", "Manual Approval"), ("custom_function", "Custom Function"),
    ] { result.push(contract(node_type, name, NodeKind::Action)); }

    let mut by_type: BTreeMap<String, NodeContract> = result.into_iter().map(|item| (item.node_type.clone(), item)).collect();
    let mut set_ports = |node_type: &str, inputs: Vec<ContractPort>, outputs: Vec<ContractPort>, branches: &[&str]| {
        if let Some(item) = by_type.get_mut(node_type) { item.inputs = inputs; item.outputs = outputs; item.branches = branches.iter().map(|value| (*value).into()).collect(); }
    };
    set_ports("condition", vec![port("left","Value",ValueType::Any,true),port("right","Compare with",ValueType::Any,false)], vec![port("result","Result",ValueType::Boolean,false)], &["true","false"]);
    set_ports("filter", vec![port("items","Items",ValueType::Array,true)], vec![port("output","Retained",ValueType::Array,false),port("rejected","Rejected",ValueType::Array,false)], &["output","rejected"]);
    set_ports("switch", vec![port("items","Items",ValueType::Array,true)], vec![port("fallback","Fallback",ValueType::Array,false)], &["fallback"]);
    set_ports("loop_over_items", vec![port("items","Items",ValueType::Array,true)], vec![port("loop","Loop",ValueType::Array,false),port("done","Done",ValueType::Array,false)], &["loop","done"]);
    set_ports("split_out", vec![port("items","Items",ValueType::Array,true)], vec![port("output","Items",ValueType::Array,false),port("rejected","Rejected",ValueType::Array,false)], &["output","rejected"]);
    set_ports("aggregate", vec![port("items","Items",ValueType::Array,true)], vec![port("value","Aggregate",ValueType::Any,false)], &[]);
    set_ports("merge", vec![port("input_a","Input A",ValueType::Array,true),port("input_b","Input B",ValueType::Array,true)], vec![port("output","Merged",ValueType::Array,false)], &[]);
    set_ports("remove_duplicates", vec![port("items","Items",ValueType::Array,true)], vec![port("output","Unique",ValueType::Array,false),port("duplicates","Duplicates",ValueType::Array,false)], &["output","duplicates"]);
    set_ports("set_data", vec![port("values","Object",ValueType::Object,false)], vec![port("value","Object",ValueType::Object,false)], &[]);
    set_ports("http_request", vec![port("url","URL",ValueType::String,true),port("body","Body",ValueType::Any,false)], vec![port("status","Status",ValueType::Number,false),port("body","Body",ValueType::Any,false),port("finalUrl","Final URL",ValueType::String,false)], &[]);
    set_ports("javascript_code", vec![port("input","Input items",ValueType::Any,false)], vec![port("items","Output items",ValueType::Array,false),port("result","Result",ValueType::Any,false)], &[]);
    set_ports("python_code", vec![port("input","Input items",ValueType::Any,false)], vec![port("items","Output items",ValueType::Array,false),port("result","Result",ValueType::Any,false)], &[]);
    set_ports("custom_function", vec![], vec![], &[]);

    let browser: BTreeSet<&str> = ["open_browser","navigate","click_element","fill_field","select_option","press_key","wait_for","extract_data","screenshot","download_file","upload_file","close_browser"].into_iter().collect();
    let local_only: BTreeSet<&str> = ["ai_prompt","javascript_code","python_code","custom_function","web_builder"].into_iter().collect();
    let read: BTreeSet<&str> = ["http_request","read_file","list_folder","parse_csv","parse_json","parse_text","get_workflow_state","gmail_get_email","extract_data","screenshot"].into_iter().collect();
    let write: BTreeSet<&str> = ["desktop_notification","move_file","write_file","copy_path","set_workflow_state","compare_previous","gmail_create_draft","gmail_send_email","gmail_add_label","discord_webhook","discord_embed","slack_webhook","approval","download_file","upload_file"].into_iter().collect();
    let destructive: BTreeSet<&str> = ["delete_path","run_command"].into_iter().collect();
    for item in by_type.values_mut() {
        if browser.contains(item.node_type.as_str()) { item.placements = vec!["local".into(),"paired_runner".into(),"managed_browser".into()]; item.requirements.push("browser_runtime".into()); }
        if local_only.contains(item.node_type.as_str()) { item.placements = vec!["local".into()]; }
        if item.node_type.starts_with("gmail_") { item.requirements.push("gmail_connection".into()); }
        if item.node_type.starts_with("discord_") { item.requirements.push("discord_connection".into()); }
        if item.node_type == "slack_webhook" { item.requirements.push("slack_connection".into()); }
        if item.node_type == "ai_prompt" { item.requirements.push("ai_connection".into()); }
        if read.contains(item.node_type.as_str()) { item.effect_level = EffectLevel::Read; }
        if write.contains(item.node_type.as_str()) { item.effect_level = EffectLevel::Write; item.retry_safety = RetrySafety::IdempotencyRequired; }
        if destructive.contains(item.node_type.as_str()) { item.effect_level = EffectLevel::Destructive; item.retry_safety = RetrySafety::Unsafe; }
        if item.node_type == "custom_function" { item.customizable = false; item.inspector_strategy = "custom_function".into(); }
    }
    by_type.into_values().collect()
}

pub fn contract_for(node_type: &str) -> Option<NodeContract> {
    node_contracts().into_iter().find(|item| item.node_type == node_type)
}

pub fn gate_node(node: &WorkflowNode, placement: &str) -> NodeGate {
    let Some(contract) = contract_for(&node.node_type) else {
        return NodeGate { state: GateState::Blocked, code: "unknown_node_contract".into(), message: format!("No contract is registered for {}.", node.node_type), remediation: Some("Install or re-enable the matching plugin, or replace this node.".into()) };
    };
    if !contract.placements.iter().any(|candidate| candidate == placement) {
        return NodeGate { state: GateState::Blocked, code: "unsupported_placement".into(), message: format!("{} cannot run on {}.", contract.display_name, placement), remediation: Some("Move the workflow to a supported runner.".into()) };
    }
    if node.node_type == "custom_function" && node.customization.is_none() {
        return NodeGate { state: GateState::Blocked, code: "custom_contract_missing".into(), message: "The custom function has no contract or source.".into(), remediation: Some("Open the ƒx editor and define the contract.".into()) };
    }
    if node.disabled {
        return NodeGate { state: GateState::SetupRequired, code: "node_disabled".into(), message: "The node is disabled.".into(), remediation: Some("Enable the node when its setup is complete.".into()) };
    }
    for requirement in &contract.requirements {
        let configured = match requirement.as_str() {
            "gmail_connection" | "discord_connection" | "slack_connection" => node.configuration.get("credentialId").and_then(Value::as_str).is_some_and(|value| !value.is_empty()),
            "ai_connection" => node.configuration.get("connectionId").and_then(Value::as_str).is_some_and(|value| !value.is_empty()),
            "browser_runtime" => node.node_type != "open_browser" || node.configuration.get("profileId").and_then(Value::as_str).is_some_and(|value| !value.is_empty()),
            _ => true,
        };
        if !configured {
            return NodeGate { state: GateState::SetupRequired, code: format!("{}_required", requirement), message: format!("{} requires {}.", contract.display_name, requirement.replace('_', " ")), remediation: Some("Complete setup in the node inspector.".into()) };
        }
    }
    NodeGate { state: GateState::Available, code: "available".into(), message: "Ready to configure or execute.".into(), remediation: None }
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
    })).expect("custom node fingerprint payload is serializable");
    format!("{:x}", Sha256::digest(payload))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_has_unique_corresponding_contracts() {
        let contracts = node_contracts();
        let unique: BTreeSet<_> = contracts.iter().map(|item| item.node_type.as_str()).collect();
        assert_eq!(unique.len(), contracts.len());
        for contract in contracts {
            assert!(!contract.inspector_strategy.is_empty(), "{} has no inspector", contract.node_type);
            assert!(contract.configuration_schema.is_object(), "{} has no schema", contract.node_type);
            assert!(contract.test_fixture.is_object(), "{} has no fixture", contract.node_type);
        }
    }
}
