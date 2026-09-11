use crate::{contract_for, expressions::inspect_template, value_types_compatible, EffectLevel, EngineError, ErrorStrategy, InputBinding, RetrySafety, ValueType, Workflow, WorkflowNode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};

const TRIGGERS: &[&str] = &[
    "manual_trigger",
    "schedule_trigger",
    "file_watch_trigger",
    "gmail_new_email_trigger",
    "google.calendar.event_changed",
    "google.drive.file_changed",
    "google.sheets.row_added",
    "slack.channel_message_posted",
    "notion.data_source_page_changed",
    "github.issue_or_pull_request_changed",
    "github.workflow_run_completed",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ValidationIssue {
    pub code: String,
    pub message: String,
    pub severity: ValidationSeverity,
    pub node_id: Option<String>,
    pub edge_id: Option<String>,
    pub field_path: Option<String>,
    pub suggestion: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ValidationSeverity {
    Info,
    Error,
    Warning,
}

pub fn validate(workflow: &Workflow) -> Vec<ValidationIssue> {
    let mut issues = Vec::new();
    if workflow.schema_version != crate::model::CURRENT_SCHEMA_VERSION {
        issues.push(issue(
            "unsupported_schema",
            format!(
                "Workflow schema {} is not supported.",
                workflow.schema_version
            ),
            None,
            None,
        ));
    }
    if workflow.settings.expression_language_version
        != crate::expressions::EXPRESSION_LANGUAGE_VERSION
    {
        issues.push(issue(
            "expression_version_incompatible",
            format!(
                "Workflow requires expression language {}, but this runner supports {}.",
                workflow.settings.expression_language_version,
                crate::expressions::EXPRESSION_LANGUAGE_VERSION
            ),
            None,
            None,
        ));
    }
    let ids: HashSet<_> = workflow.nodes.iter().map(|n| n.id.as_str()).collect();
    if ids.len() != workflow.nodes.len() {
        issues.push(issue(
            "duplicate_node",
            "Node identifiers must be unique.",
            None,
            None,
        ));
    }
    let triggers: Vec<_> = workflow
        .nodes
        .iter()
        .filter(|n| TRIGGERS.contains(&n.node_type.as_str()))
        .collect();
    if triggers.len() != 1 {
        issues.push(issue(
            "trigger_count",
            format!(
                "Workflow requires exactly one trigger; found {}.",
                triggers.len()
            ),
            None,
            None,
        ));
    } else if workflow.trigger_node_id != triggers[0].id {
        issues.push(issue(
            "trigger_mismatch",
            "The workflow trigger does not match its triggerNodeId.",
            Some(triggers[0].id.clone()),
            None,
        ));
    }
    let mut edge_ids = HashSet::new();
    for edge in &workflow.edges {
        if !edge_ids.insert(&edge.id) {
            issues.push(issue(
                "duplicate_edge",
                "Edge identifiers must be unique.",
                None,
                Some(edge.id.clone()),
            ));
        }
        if !ids.contains(edge.source_node_id.as_str())
            || !ids.contains(edge.target_node_id.as_str())
        {
            issues.push(issue(
                "missing_endpoint",
                "Connection references a node that no longer exists.",
                None,
                Some(edge.id.clone()),
            ));
        }
        if edge.source_node_id == edge.target_node_id {
            issues.push(issue(
                "self_connection",
                "A node cannot connect to itself.",
                Some(edge.source_node_id.clone()),
                Some(edge.id.clone()),
            ));
        }
        if workflow.nodes.iter().any(|node| {
            node.node_type == "note"
                && (node.id == edge.source_node_id || node.id == edge.target_node_id)
        }) {
            issues.push(issue(
                "note_connection",
                "Notes are canvas-only and cannot be connected to workflow steps.",
                None,
                Some(edge.id.clone()),
            ));
        }
        if let Some(source) = workflow.nodes.iter().find(|n| n.id == edge.source_node_id) {
            if source.node_type == "condition"
                && !matches!(edge.source_handle.as_str(), "true" | "false")
            {
                issues.push(issue(
                    "condition_handle",
                    "Condition connections must use the true or false output.",
                    Some(source.id.clone()),
                    Some(edge.id.clone()),
                ));
            }
            if source.node_type == "switch" {
                let valid: HashSet<&str> = source
                    .configuration
                    .get("cases")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|case| case.get("id").and_then(Value::as_str))
                    .chain(
                        source
                            .configuration
                            .get("fallbackBranchId")
                            .and_then(Value::as_str),
                    )
                    .collect();
                if !valid.contains(edge.source_handle.as_str()) {
                    issues.push(issue(
                        "switch_handle_invalid",
                        format!(
                            "Switch connection uses unknown branch '{}'.",
                            edge.source_handle
                        ),
                        Some(source.id.clone()),
                        Some(edge.id.clone()),
                    ));
                }
            }
            let fixed_handles: Option<&[&str]> = match source.node_type.as_str() {
                "filter" | "split_out" => Some(&["output", "rejected"]),
                "loop_over_items" => Some(&["loop", "done"]),
                "remove_duplicates" => Some(&["output", "duplicates"]),
                _ => None,
            };
            if fixed_handles.is_some_and(|handles| !handles.contains(&edge.source_handle.as_str()))
            {
                issues.push(issue(
                    "collection_handle_invalid",
                    format!(
                        "{} connection uses unknown output '{}'.",
                        source.name, edge.source_handle
                    ),
                    Some(source.id.clone()),
                    Some(edge.id.clone()),
                ));
            }
        }
        if let Some(target) = workflow.nodes.iter().find(|n| n.id == edge.target_node_id) {
            if TRIGGERS.contains(&target.node_type.as_str()) {
                issues.push(issue(
                    "trigger_input",
                    "Trigger nodes cannot have incoming connections.",
                    Some(target.id.clone()),
                    Some(edge.id.clone()),
                ));
            }
            if target.node_type == "merge" {
                let port = edge.target_port.as_deref().unwrap_or(&edge.target_handle);
                let valid = target
                    .configuration
                    .get("inputPorts")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|value| value.get("id").and_then(Value::as_str))
                    .any(|id| id == port);
                if !valid {
                    issues.push(issue(
                        "merge_input_invalid",
                        format!("Merge connection uses unknown input port '{port}'."),
                        Some(target.id.clone()),
                        Some(edge.id.clone()),
                    ));
                }
            }
        }
        validate_typed_edge(workflow, edge, &mut issues);
    }
    if topological_order(workflow).is_err() {
        issues.push(issue(
            "cycle",
            "Workflow contains a circular connection. Loops are not supported.",
            None,
            None,
        ));
    }
    if triggers.len() == 1 {
        let mut reachable = HashSet::from([triggers[0].id.as_str()]);
        let mut changed = true;
        while changed {
            changed = false;
            for edge in &workflow.edges {
                if reachable.contains(edge.source_node_id.as_str())
                    && reachable.insert(edge.target_node_id.as_str())
                {
                    changed = true;
                }
            }
        }
        for node in workflow
            .nodes
            .iter()
            .filter(|n| n.node_type != "note" && !n.disabled && !reachable.contains(n.id.as_str()))
        {
            let mut disconnected = issue(
                "disconnected_node",
                format!("{} is not connected to the trigger.", node.name),
                Some(node.id.clone()),
                None,
            );
            disconnected.severity = ValidationSeverity::Warning;
            disconnected.suggestion =
                Some("Connect this node or disable it if it is not currently needed.".into());
            issues.push(disconnected);
        }
    }
    for node in &workflow.nodes {
        if node.node_type == "note" {
            continue;
        }
        validate_collection_node(workflow, node, &mut issues);
        validate_error_policy(workflow, node, &mut issues);
        validate_custom_function(node, &mut issues);
        let reachable_sources = upstream_node_ids(workflow, &node.id);
        for (field_path, source) in expression_strings(&node.configuration, "configuration") {
            if field_path.starts_with("configuration.pinnedData")
                || field_path.starts_with("configuration.dependencies")
                || matches!(
                    field_path.rsplit('.').next(),
                    Some(
                        "sourceCode"
                            | "credentialId"
                            | "connectionId"
                            | "profileId"
                            | "runtimeVersion"
                    )
                )
            {
                continue;
            }
            if !source.contains("{{") {
                continue;
            }
            match inspect_template(source) {
                Err(error) => {
                    let mut expression_issue = issue(
                        "expression_invalid",
                        error.to_string(),
                        Some(node.id.clone()),
                        None,
                    );
                    expression_issue.field_path = Some(field_path);
                    issues.push(expression_issue);
                }
                Ok(references) => {
                    for source_id in references {
                        if !reachable_sources.contains(source_id.as_str()) {
                            let mut expression_issue = issue("expression_unreachable", format!("Expression references node '{source_id}', which is not reachable upstream."), Some(node.id.clone()), None);
                            expression_issue.field_path = Some(field_path.clone());
                            expression_issue.suggestion =
                                Some("Choose a node connected before this field's node.".into());
                            issues.push(expression_issue);
                        }
                    }
                }
            }
        }
        for (field, binding) in &node.input_bindings {
            if field.trim().is_empty() {
                let mut binding_issue = issue(
                    "binding_field_missing",
                    "A data binding has no target field.",
                    Some(node.id.clone()),
                    None,
                );
                binding_issue.field_path = Some("inputBindings".into());
                issues.push(binding_issue);
            }
            if let InputBinding::NodeOutput { node_id, .. } = binding {
                if node_id == &node.id {
                    let mut binding_issue = issue(
                        "binding_self_reference",
                        "A node cannot map its own output as input.",
                        Some(node.id.clone()),
                        None,
                    );
                    binding_issue.field_path = Some(format!("inputBindings.{field}"));
                    issues.push(binding_issue);
                } else if !ids.contains(node_id.as_str()) {
                    let mut binding_issue = issue(
                        "binding_source_missing",
                        format!("Input '{field}' references a node that no longer exists."),
                        Some(node.id.clone()),
                        None,
                    );
                    binding_issue.field_path = Some(format!("inputBindings.{field}"));
                    issues.push(binding_issue);
                } else if !reachable_sources.contains(node_id.as_str()) {
                    let mut binding_issue = issue("binding_source_unreachable", format!("Input '{field}' references node '{node_id}', which does not run before this node."), Some(node.id.clone()), None);
                    binding_issue.field_path = Some(format!("inputBindings.{field}"));
                    issues.push(binding_issue);
                }
            }
        }
        if matches!(
            node.node_type.as_str(),
            "code" | "javascript_code" | "python_code"
        ) {
            let expected_language = match node.node_type.as_str() {
                "javascript_code" => Some("javascript"),
                "python_code" => Some("python"),
                _ => None,
            };
            if expected_language.is_some_and(|expected| {
                node.configuration.get("language").and_then(Value::as_str) != Some(expected)
            }) {
                let mut mismatch = issue(
                    "code_language_mismatch",
                    format!(
                        "{} must use the {} runtime.",
                        node.name,
                        expected_language.unwrap()
                    ),
                    Some(node.id.clone()),
                    None,
                );
                mismatch.field_path = Some("configuration.language".into());
                issues.push(mismatch);
            }
            if node
                .configuration
                .get("helperLanguageVersion")
                .and_then(Value::as_u64)
                .unwrap_or(1)
                != crate::expressions::EXPRESSION_LANGUAGE_VERSION as u64
            {
                let mut unsupported = issue(
                    "expression_version_incompatible",
                    format!(
                        "{} requires an unsupported helper-language version.",
                        node.name
                    ),
                    Some(node.id.clone()),
                    None,
                );
                unsupported.field_path = Some("configuration.helperLanguageVersion".into());
                issues.push(unsupported);
            }
            if node
                .configuration
                .get("dependencies")
                .and_then(Value::as_array)
                .is_some_and(|dependencies| !dependencies.is_empty())
            {
                let mut packages=issue("package_policy_rejected","Stage 1 Code runtimes support built-in helpers only; package installation is not enabled.",Some(node.id.clone()),None);
                packages.field_path = Some("configuration.dependencies".into());
                packages.suggestion=Some("Remove package requirements or run the transformation through an approved integration node.".into());
                issues.push(packages);
            }
            if node
                .configuration
                .get("networkPolicy")
                .and_then(Value::as_str)
                .is_some_and(|policy| policy != "none")
            {
                let mut network = issue(
                    "code_network_denied",
                    "Code nodes cannot request ambient network access in this runtime.",
                    Some(node.id.clone()),
                    None,
                );
                network.field_path = Some("configuration.networkPolicy".into());
                issues.push(network);
            }
        }
        let missing = match node.node_type.as_str() {
            "http_request" => node
                .configuration
                .get("url")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .unwrap_or("")
                .is_empty()
                .then_some("HTTP Request requires a URL."),
            "condition" => (!node.configuration.get("operator").is_some()
                || !node.configuration.get("left").is_some())
            .then_some("Condition requires a value and operator."),
            "schedule_trigger" => node
                .configuration
                .get("scheduleType")
                .is_none()
                .then_some("Schedule Trigger requires a schedule."),
            "file_watch_trigger" => node
                .configuration
                .get("folder")
                .and_then(|v| v.as_str())
                .map(str::is_empty)
                .unwrap_or(true)
                .then_some("File Watch Trigger requires an approved folder."),
            "desktop_notification" => node
                .configuration
                .get("title")
                .and_then(|v| v.as_str())
                .map(str::is_empty)
                .unwrap_or(true)
                .then_some("Desktop Notification requires a title."),
            "move_file" => (node.configuration.get("source").is_none()
                || node.configuration.get("destinationFolder").is_none())
            .then_some("Move File requires source and destination paths."),
            "read_file" => missing_string_or_binding(node, "path")
                .then_some("Read File requires an approved file path."),
            "write_file" => (missing_string_or_binding(node, "path")
                || missing_value_or_binding(node, "content"))
            .then_some("Write File requires a path and content."),
            "copy_path" => (missing_string_or_binding(node, "source")
                || missing_string_or_binding(node, "destination"))
            .then_some("Copy File or Folder requires source and destination paths."),
            "delete_path" => missing_string_or_binding(node, "path")
                .then_some("Delete File or Folder requires an approved path."),
            "list_folder" => missing_string_or_binding(node, "folder")
                .then_some("List Folder requires an approved folder."),
            "parse_csv" | "parse_json" | "parse_text" => (missing_string_or_binding(node, "path")
                && missing_string_or_binding(node, "content"))
            .then_some("Map content from another node or choose an approved file."),
            "get_workflow_state" | "set_workflow_state" | "compare_previous" => {
                missing_string_or_binding(node, "key")
                    .then_some("Workflow state nodes require a state key.")
            }
            "run_command" => node
                .configuration
                .get("executable")
                .and_then(|v| v.as_str())
                .map(str::is_empty)
                .unwrap_or(true)
                .then_some("Run Command requires an executable."),
            "ai_prompt" => {
                if missing_string_or_binding(node, "connectionId") {
                    Some("AI requires a connected model.")
                } else if missing_string_or_binding(node, "prompt") {
                    Some("AI requires an instruction.")
                } else {
                    None
                }
            }
            "code" | "javascript_code" | "python_code" => {
                missing_string_or_binding(node, "sourceCode")
                    .then_some("Code requires source before it can run.")
            }
            "web_builder" => (missing_string_or_binding(node, "html")
                || missing_string_or_binding(node, "javascript")
                || missing_string_or_binding(node, "css"))
            .then_some("Web Builder requires mapped HTML, JavaScript, and CSS inputs."),
            "open_browser" => empty_string(&node.configuration, "profileId")
                .then_some("Open Browser requires a managed browser profile."),
            "navigate" => {
                empty_string(&node.configuration, "url").then_some("Navigate requires a URL.")
            }
            "click_element" | "select_option" | "extract_data" => {
                (!has_locator(&node.configuration))
                    .then_some("This browser action requires a structured target locator.")
            }
            "fill_field" => {
                if !has_locator(&node.configuration) {
                    Some("Fill Field requires a structured target locator.")
                } else if empty_string(&node.configuration, "value") {
                    Some(
                        if node
                            .configuration
                            .get("sensitive")
                            .and_then(|v| v.as_bool())
                            == Some(true)
                        {
                            "Fill Field has a protected value that must be mapped to a credential or protected workflow input."
                        } else {
                            "Fill Field requires a value."
                        },
                    )
                } else {
                    None
                }
            }
            "download_file" => {
                if !has_locator(&node.configuration) {
                    Some("Download File requires a structured target locator.")
                } else if empty_string(&node.configuration, "destinationFolder") {
                    Some("Download File requires an approved destination folder.")
                } else {
                    None
                }
            }
            "upload_file" => {
                if !has_locator(&node.configuration) {
                    Some("Upload File requires a structured target locator.")
                } else if empty_string(&node.configuration, "file") {
                    Some("Upload File requires an approved local file or trusted file mapping.")
                } else {
                    None
                }
            }
            "gmail_new_email_trigger" => empty_string(&node.configuration, "credentialId")
                .then_some("New Email Trigger requires a Gmail connection."),
            "gmail_get_email" => {
                if empty_string(&node.configuration, "credentialId") {
                    Some("Get Email requires a Gmail connection.")
                } else if empty_string(&node.configuration, "messageId") {
                    Some("Get Email requires a message or thread ID.")
                } else {
                    None
                }
            }
            "gmail_create_draft" | "gmail_send_email" => {
                if empty_string(&node.configuration, "credentialId") {
                    Some("Gmail action requires a connection.")
                } else if empty_string(&node.configuration, "to") {
                    Some("Email action requires at least one recipient.")
                } else {
                    None
                }
            }
            "gmail_add_label" => {
                if empty_string(&node.configuration, "credentialId") {
                    Some("Add Label requires a Gmail connection.")
                } else if empty_string(&node.configuration, "messageId") {
                    Some("Add Label requires a message ID.")
                } else {
                    None
                }
            }
            "discord_webhook" | "discord_embed" | "slack_webhook" => {
                if empty_string(&node.configuration, "credentialId") {
                    Some("Webhook action requires a secure connection.")
                } else if empty_string(
                    &node.configuration,
                    if node.node_type == "discord_embed" {
                        "description"
                    } else {
                        "content"
                    },
                ) {
                    Some("Webhook action requires message content.")
                } else {
                    None
                }
            }
            "approval" => empty_string(&node.configuration, "proposedAction")
                .then_some("Manual Approval requires a proposed action description."),
            _ => None,
        };
        if let Some(message) = missing {
            let mut incomplete = issue("incomplete_node", message, Some(node.id.clone()), None);
            if let Some(field) = incomplete_field(node) {
                incomplete.field_path = Some(format!("configuration.{field}"));
                incomplete.suggestion =
                    Some("Complete this field before running the workflow.".into());
            }
            issues.push(incomplete);
        }
        if is_browser_action(&node.node_type)
            && !has_upstream_browser_session(workflow, &node.id, &mut HashSet::new())
        {
            issues.push(issue(
                "browser_session_missing",
                format!("{} has no upstream Open Browser session.", node.name),
                Some(node.id.clone()),
                None,
            ));
        }
    }
    for name in &workflow.settings.permissions.approved_environment_variables {
        if name.is_empty()
            || name.len() > 128
            || !name.chars().all(|character| {
                character.is_ascii_uppercase() || character.is_ascii_digit() || character == '_'
            })
        {
            issues.push(issue("environment_name_invalid",format!("Environment variable name '{name}' is invalid; use uppercase letters, digits and underscores."),None,None));
        }
    }
    issues
}

fn validate_typed_edge(workflow: &Workflow, edge: &crate::WorkflowEdge, issues: &mut Vec<ValidationIssue>) {
    let Some(source) = workflow.nodes.iter().find(|node| node.id == edge.source_node_id) else { return; };
    let Some(target) = workflow.nodes.iter().find(|node| node.id == edge.target_node_id) else { return; };
    let source_key = edge.source_port.as_deref().unwrap_or(&edge.source_handle);
    let target_key = edge.target_port.as_deref().unwrap_or(&edge.target_handle);
    // `output` and `input` are legacy control-flow handles. Explicit named ports
    // are checked against the authoritative contract.
    if matches!(source_key, "output" | "success") && target_key == "input" { return; }
    let source_type = source.customization.as_ref()
        .and_then(|customization| customization.outputs.iter().find(|port| port.key == source_key).map(|port| port.value_type.clone()))
        .or_else(|| contract_for(&source.node_type).and_then(|contract| contract.outputs.into_iter().find(|port| port.key == source_key).map(|port| port.value_type)));
    let target_type = target.customization.as_ref()
        .and_then(|customization| customization.inputs.iter().find(|port| port.key == target_key).map(|port| port.value_type.clone()))
        .or_else(|| contract_for(&target.node_type).and_then(|contract| contract.inputs.into_iter().find(|port| port.key == target_key).map(|port| port.value_type)));
    if source_type.is_none() && source.node_type == "custom_function" && source_key != "error" {
        issues.push(issue("source_port_missing", format!("{} has no output port '{source_key}'.", source.name), Some(source.id.clone()), Some(edge.id.clone())));
    }
    if target_type.is_none() && target.node_type == "custom_function" && target_key != "input" {
        issues.push(issue("target_port_missing", format!("{} has no input port '{target_key}'.", target.name), Some(target.id.clone()), Some(edge.id.clone())));
    }
    if let (Some(source_type), Some(target_type)) = (source_type, target_type) {
        if !value_types_compatible(&source_type, &target_type) {
            issues.push(issue("port_type_incompatible", format!("Cannot connect {source_key} ({source_type:?}) to {target_key} ({target_type:?})."), Some(target.id.clone()), Some(edge.id.clone())));
        }
    }
}

fn validate_error_policy(workflow: &Workflow, node: &WorkflowNode, issues: &mut Vec<ValidationIssue>) {
    let policy = node.error_policy.clone().unwrap_or_default();
    if TRIGGERS.contains(&node.node_type.as_str()) && node.error_policy.is_some() {
        issues.push(issue("trigger_error_policy_unsupported", "Trigger nodes cannot use an error policy.", Some(node.id.clone()), None));
        return;
    }
    if policy.max_retries > 5 {
        issues.push(issue("retry_count_out_of_range", "Retries must be between 0 and 5.", Some(node.id.clone()), None));
    }
    if policy.retry_delay_ms > 30_000 {
        issues.push(issue("retry_delay_out_of_range", "Retry delay must be between 0 and 30 seconds.", Some(node.id.clone()), None));
    }
    if policy.max_retries > 0 {
        match contract_for(&node.node_type) {
            Some(contract) if contract.effect_level == EffectLevel::Destructive || contract.retry_safety == RetrySafety::Unsafe =>
                issues.push(issue("retry_not_safe", "This operation cannot be retried automatically.", Some(node.id.clone()), None)),
            Some(contract) if contract.retry_safety == RetrySafety::IdempotencyRequired =>
                issues.push(issue("retry_idempotency_required", "This operation needs declared idempotency support before retries can be enabled.", Some(node.id.clone()), None)),
            _ => {}
        }
    }
    let error_edges = workflow.edges.iter().filter(|edge| edge.source_node_id == node.id && edge.source_handle == "error").count();
    match policy.strategy {
        ErrorStrategy::Route if error_edges != 1 => issues.push(issue("error_route_edge_count", format!("Route policy requires exactly one connected error edge; found {error_edges}."), Some(node.id.clone()), None)),
        ErrorStrategy::Fail | ErrorStrategy::Fallback if error_edges > 0 => issues.push(issue("error_edge_without_route", "The reserved error edge is only available when the route policy is selected.", Some(node.id.clone()), None)),
        _ => {}
    }
    if policy.strategy == ErrorStrategy::Fallback {
        let Some(values) = policy.fallback_outputs.as_object() else {
            issues.push(issue("fallback_outputs_invalid", "Fallback outputs must be an object.", Some(node.id.clone()), None));
            return;
        };
        let outputs = node.customization.as_ref().map(|customization| customization.outputs.clone()).unwrap_or_else(|| contract_for(&node.node_type).map(|contract| contract.outputs.into_iter().map(|port| crate::CustomPortDefinition { key: port.key, label: port.label, value_type: port.value_type, required: port.required }).collect()).unwrap_or_default());
        for output in outputs.iter().filter(|output| output.required) {
            match values.get(&output.key) {
                None => issues.push(issue("fallback_output_missing", format!("Fallback output '{}' is required.", output.key), Some(node.id.clone()), None)),
                Some(value) if !json_matches_type(value, &output.value_type) => issues.push(issue("fallback_output_type", format!("Fallback output '{}' has the wrong type.", output.key), Some(node.id.clone()), None)),
                _ => {}
            }
        }
    }
}

fn validate_custom_function(node: &WorkflowNode, issues: &mut Vec<ValidationIssue>) {
    if node.node_type != "custom_function" { return; }
    let Some(customization) = &node.customization else {
        issues.push(issue("custom_contract_missing", "Custom function contract and source are required.", Some(node.id.clone()), None));
        return;
    };
    if !matches!(customization.language.as_str(), "javascript" | "python") {
        issues.push(issue("custom_language_unsupported", "Custom functions support JavaScript or Python.", Some(node.id.clone()), None));
    }
    if customization.source_code.trim().is_empty() {
        issues.push(issue("custom_source_missing", "Custom function source cannot be empty.", Some(node.id.clone()), None));
    }
    let valid_source = contract_for(&customization.source_type).is_some_and(|contract| contract.customizable && contract.effect_level == EffectLevel::Pure);
    if !valid_source {
        issues.push(issue("custom_source_not_pure", "Only pure, customizable built-in nodes can be used as a source.", Some(node.id.clone()), None));
    }
    for (count, limit, code, label) in [(customization.inputs.len(),16,"custom_input_limit","inputs"),(customization.outputs.len(),16,"custom_output_limit","outputs"),(customization.branches.len(),8,"custom_branch_limit","branches")] {
        if count > limit { issues.push(issue(code, format!("Custom functions support at most {limit} {label}."), Some(node.id.clone()), None)); }
    }
    let mut keys = HashSet::new();
    for port in customization.inputs.iter().chain(&customization.outputs).chain(&customization.branches) {
        if !valid_identifier(&port.key) || port.key == "error" {
            issues.push(issue("custom_port_identifier", format!("'{}' is not a valid port key; 'error' is reserved.", port.key), Some(node.id.clone()), None));
        }
        if !keys.insert(port.key.as_str()) {
            issues.push(issue("custom_port_duplicate", format!("Port key '{}' is duplicated.", port.key), Some(node.id.clone()), None));
        }
    }
    if customization.tests.is_empty() {
        issues.push(issue("custom_tests_required", "Add and pass saved fixtures before this custom function can run.", Some(node.id.clone()), None));
    }
}

fn valid_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    chars.next().is_some_and(|first| first == '_' || first.is_ascii_alphabetic())
        && chars.all(|character| character == '_' || character.is_ascii_alphanumeric())
}

fn json_matches_type(value: &Value, value_type: &ValueType) -> bool {
    match value_type {
        ValueType::Any => true, ValueType::String | ValueType::Path | ValueType::Connection => value.is_string(),
        ValueType::Number => value.is_number(), ValueType::Boolean => value.is_boolean(),
        ValueType::Object => value.is_object(), ValueType::Array => value.is_array(),
    }
}

enum ArraySchema {
    Unknown,
    Object(&'static [&'static str]),
}
impl ArraySchema {
    fn rejects(&self, path: &str) -> bool {
        match self {
            Self::Unknown => false,
            Self::Object(fields) => path.is_empty() || !fields.contains(&path),
        }
    }
}

fn validate_collection_node(
    workflow: &Workflow,
    node: &crate::WorkflowNode,
    issues: &mut Vec<ValidationIssue>,
) {
    let config = &node.configuration;
    match node.node_type.as_str() {
        "filter" => {
            if config
                .get("rules")
                .and_then(Value::as_array)
                .is_none_or(Vec::is_empty)
            {
                issues.push(issue(
                    "filter_rules_missing",
                    "Filter requires at least one rule.",
                    Some(node.id.clone()),
                    None,
                ));
            }
            validate_rules(node, config, issues);
        }
        "switch" => {
            let cases = config
                .get("cases")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            if cases.is_empty() {
                issues.push(issue(
                    "switch_cases_missing",
                    "Switch requires at least one case.",
                    Some(node.id.clone()),
                    None,
                ));
            }
            let mut ids = HashSet::new();
            for case in cases {
                let id = case.get("id").and_then(Value::as_str).unwrap_or("");
                if id.is_empty()
                    || !id
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
                {
                    issues.push(issue(
                        "switch_branch_id_invalid",
                        "Switch case IDs must contain letters, numbers, underscores or hyphens.",
                        Some(node.id.clone()),
                        None,
                    ));
                } else if !ids.insert(id) {
                    issues.push(issue(
                        "switch_branch_id_duplicate",
                        format!("Switch branch ID '{id}' is duplicated."),
                        Some(node.id.clone()),
                        None,
                    ));
                }
                validate_rules(node, case, issues);
            }
            let fallback = config
                .get("fallbackBranchId")
                .and_then(Value::as_str)
                .unwrap_or("");
            if fallback.is_empty()
                || !fallback
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
            {
                issues.push(issue(
                    "switch_fallback_invalid",
                    "Switch requires a valid stable fallback branch ID.",
                    Some(node.id.clone()),
                    None,
                ));
            } else if !ids.insert(fallback) {
                issues.push(issue(
                    "switch_branch_id_duplicate",
                    "Switch fallback ID duplicates a case ID.",
                    Some(node.id.clone()),
                    None,
                ));
            }
        }
        "split_out" => {
            if config.get("fieldPath").and_then(Value::as_str).is_none() {
                issues.push(issue("split_array_path_missing","Split Out requires an array field path (use an empty string only for a top-level array).",Some(node.id.clone()),None));
            } else if let Some(source) = workflow
                .edges
                .iter()
                .find(|edge| edge.target_node_id == node.id)
                .and_then(|edge| {
                    workflow
                        .nodes
                        .iter()
                        .find(|candidate| candidate.id == edge.source_node_id)
                })
            {
                let known: ArraySchema = match source.node_type.as_str() {
                    "parse_csv" => ArraySchema::Object(&["rows", "headers"]),
                    "list_folder" => ArraySchema::Object(&["entries"]),
                    "parse_text" => ArraySchema::Object(&["lines"]),
                    _ => ArraySchema::Unknown,
                };
                let path = config
                    .get("fieldPath")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if known.rejects(path) {
                    issues.push(issue(
                        "split_array_schema_mismatch",
                        format!("'{path}' is not a known array output from {}.", source.name),
                        Some(node.id.clone()),
                        None,
                    ));
                }
            }
        }
        "loop_over_items" => {
            let done = workflow
                .edges
                .iter()
                .any(|edge| edge.source_node_id == node.id && edge.source_handle == "done");
            if !done {
                issues.push(issue(
                    "loop_completion_missing",
                    "Loop Over Items requires a connected Done output.",
                    Some(node.id.clone()),
                    None,
                ));
            }
            let body = workflow
                .edges
                .iter()
                .any(|edge| edge.source_node_id == node.id && edge.source_handle == "loop");
            if !body {
                issues.push(issue(
                    "loop_body_missing",
                    "Loop Over Items requires a connected Loop body.",
                    Some(node.id.clone()),
                    None,
                ));
            }
            let maximum = config
                .get("maxIterations")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            if maximum == 0 {
                issues.push(issue(
                    "loop_unbounded",
                    "Loop Over Items requires a positive maximum iteration count.",
                    Some(node.id.clone()),
                    None,
                ));
            } else if maximum as usize > workflow.settings.collection_limits.max_loop_iterations {
                issues.push(issue(
                    "loop_iteration_limit",
                    format!(
                        "Loop maximum {maximum} exceeds runner policy {}.",
                        workflow.settings.collection_limits.max_loop_iterations
                    ),
                    Some(node.id.clone()),
                    None,
                ));
            }
            if config.get("batchSize").and_then(Value::as_u64).unwrap_or(0) == 0 {
                issues.push(issue(
                    "loop_batch_size_invalid",
                    "Loop Over Items requires a positive batch size.",
                    Some(node.id.clone()),
                    None,
                ));
            }
            let concurrency = config
                .get("concurrency")
                .and_then(Value::as_u64)
                .unwrap_or(1) as usize;
            if concurrency > workflow.settings.collection_limits.max_loop_concurrency {
                issues.push(issue(
                    "loop_concurrency_limit",
                    format!(
                        "Loop concurrency {concurrency} exceeds runner policy {}.",
                        workflow.settings.collection_limits.max_loop_concurrency
                    ),
                    Some(node.id.clone()),
                    None,
                ));
            }
            if config
                .get("iterationRetryCount")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                > 10
            {
                issues.push(issue(
                    "loop_retry_limit",
                    "Loop iteration retries cannot exceed 10.",
                    Some(node.id.clone()),
                    None,
                ));
            }
        }
        "aggregate" => {
            let allowed = [
                "collect_items",
                "collect_field",
                "count",
                "sum",
                "minimum",
                "maximum",
                "average",
                "first",
                "last",
                "concatenate",
                "group_by",
                "object_by_key",
            ];
            let operation = config.get("operation").and_then(Value::as_str);
            if !operation.is_some_and(|value| allowed.contains(&value)) {
                issues.push(issue(
                    "aggregate_operation_invalid",
                    "Aggregate requires a supported operation.",
                    Some(node.id.clone()),
                    None,
                ));
            }
            if matches!(
                operation,
                Some(
                    "collect_field"
                        | "sum"
                        | "minimum"
                        | "maximum"
                        | "average"
                        | "first"
                        | "last"
                        | "concatenate"
                )
            ) && config.get("fieldPath").and_then(Value::as_str).is_none()
            {
                issues.push(issue(
                    "aggregate_field_missing",
                    "This Aggregate operation requires a selected field path.",
                    Some(node.id.clone()),
                    None,
                ));
            }
            if operation == Some("group_by")
                && config
                    .get("groupFields")
                    .and_then(Value::as_array)
                    .is_none_or(Vec::is_empty)
            {
                issues.push(issue(
                    "aggregate_group_fields_missing",
                    "Group by requires at least one field.",
                    Some(node.id.clone()),
                    None,
                ));
            }
        }
        "remove_duplicates" => {
            if config.get("scope").and_then(Value::as_str) == Some("workflow_state")
                && workflow.settings.collection_limits.max_deduplication_keys == 0
            {
                issues.push(issue(
                    "dedupe_state_unavailable",
                    "This runner policy does not allow retained cross-run deduplication keys.",
                    Some(node.id.clone()),
                    None,
                ));
            }
        }
        "merge" => {
            let ports = config
                .get("inputPorts")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            if ports.len() < 2 {
                issues.push(issue(
                    "merge_inputs_missing",
                    "Merge requires at least two named input ports.",
                    Some(node.id.clone()),
                    None,
                ));
            }
            let mut ids = HashSet::new();
            for port in ports {
                let id = port.get("id").and_then(Value::as_str).unwrap_or("");
                if id.is_empty() || !ids.insert(id) {
                    issues.push(issue(
                        "merge_input_id_duplicate",
                        "Merge input IDs must be present and unique.",
                        Some(node.id.clone()),
                        None,
                    ));
                }
            }
            let mode = config.get("mode").and_then(Value::as_str).unwrap_or("");
            if ![
                "wait_all",
                "append",
                "combine_position",
                "combine_fields",
                "cartesian",
                "choose_branch",
            ]
            .contains(&mode)
            {
                issues.push(issue(
                    "merge_mode_invalid",
                    "Merge requires a supported mode.",
                    Some(node.id.clone()),
                    None,
                ));
            }
            if matches!(mode, "combine_fields" | "cartesian") && ports.len() != 2 {
                issues.push(issue(
                    "merge_binary_mode_inputs",
                    format!("Merge mode '{mode}' requires exactly two named inputs."),
                    Some(node.id.clone()),
                    None,
                ));
            }
            if mode == "combine_fields"
                && (config
                    .get("leftKey")
                    .and_then(Value::as_str)
                    .is_none_or(str::is_empty)
                    || config
                        .get("rightKey")
                        .and_then(Value::as_str)
                        .is_none_or(str::is_empty))
            {
                issues.push(issue(
                    "merge_join_key_missing",
                    "Combine by matching fields requires both join-key paths.",
                    Some(node.id.clone()),
                    None,
                ));
            }
            if mode == "choose_branch"
                && !config
                    .get("chooseStrategy")
                    .and_then(Value::as_str)
                    .is_some_and(|value| matches!(value, "first_non_empty" | "first_successful"))
            {
                issues.push(issue("merge_choice_invalid","Choose branch requires an explicit first-non-empty or first-successful strategy.",Some(node.id.clone()),None));
            }
            if mode == "cartesian" {
                let maximum = config
                    .get("maxResults")
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as usize;
                if maximum == 0 {
                    issues.push(issue(
                        "merge_cartesian_unbounded",
                        "Cartesian Merge requires a positive hard result limit.",
                        Some(node.id.clone()),
                        None,
                    ));
                } else if maximum > workflow.settings.collection_limits.max_cartesian_items {
                    issues.push(issue(
                        "merge_cartesian_limit",
                        format!(
                            "Cartesian limit {maximum} exceeds runner policy {}.",
                            workflow.settings.collection_limits.max_cartesian_items
                        ),
                        Some(node.id.clone()),
                        None,
                    ));
                }
            }
        }
        _ => {}
    }
    let incoming = workflow
        .edges
        .iter()
        .filter(|edge| edge.target_node_id == node.id)
        .count();
    if incoming > 1 && node.node_type != "merge" {
        issues.push(issue("ambiguous_convergence",format!("{} has {incoming} incoming control branches. Add Merge to define convergence explicitly.",node.name),Some(node.id.clone()),None));
    }
}

fn validate_rules(node: &crate::WorkflowNode, value: &Value, issues: &mut Vec<ValidationIssue>) {
    if let Some(rules) = value.get("rules").and_then(Value::as_array) {
        for rule in rules {
            if rule.get("rules").is_some() {
                validate_rules(node, rule, issues);
                continue;
            }
            if rule.get("operator").and_then(Value::as_str) == Some("matches_regex") {
                let pattern = rule
                    .get("value")
                    .or_else(|| rule.get("right"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if pattern.len() > 1024 || regex::Regex::new(pattern).is_err() {
                    let mut invalid = issue(
                        "rule_regex_invalid",
                        "Rule contains an invalid or overlong regular expression.",
                        Some(node.id.clone()),
                        None,
                    );
                    invalid.field_path = Some("configuration.rules".into());
                    issues.push(invalid);
                }
            }
        }
    }
}

fn upstream_node_ids<'a>(workflow: &'a Workflow, node_id: &str) -> HashSet<&'a str> {
    let mut reachable = HashSet::new();
    let mut pending = vec![node_id];
    while let Some(target) = pending.pop() {
        for edge in workflow
            .edges
            .iter()
            .filter(|edge| edge.target_node_id == target)
        {
            if reachable.insert(edge.source_node_id.as_str()) {
                pending.push(edge.source_node_id.as_str());
            }
        }
    }
    reachable
}

fn expression_strings<'a>(value: &'a Value, prefix: &str) -> Vec<(String, &'a str)> {
    let mut result = Vec::new();
    match value {
        Value::String(source) => result.push((prefix.to_string(), source.as_str())),
        Value::Array(values) => {
            for (index, value) in values.iter().enumerate() {
                result.extend(expression_strings(value, &format!("{prefix}.{index}")));
            }
        }
        Value::Object(values) => {
            for (key, value) in values {
                result.extend(expression_strings(value, &format!("{prefix}.{key}")));
            }
        }
        _ => {}
    }
    result
}

fn missing_string_or_binding(node: &crate::WorkflowNode, field: &str) -> bool {
    !node.input_bindings.contains_key(field)
        && node
            .configuration
            .get(field)
            .and_then(|value| value.as_str())
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
}

fn missing_value_or_binding(node: &crate::WorkflowNode, field: &str) -> bool {
    !node.input_bindings.contains_key(field)
        && node
            .configuration
            .get(field)
            .is_none_or(|value| value.is_null())
}

fn incomplete_field(node: &crate::WorkflowNode) -> Option<&'static str> {
    let config = &node.configuration;
    match node.node_type.as_str() {
        "http_request" | "navigate" => Some("url"),
        "condition" => Some(if config.get("left").is_none() {
            "left"
        } else {
            "operator"
        }),
        "schedule_trigger" => Some("scheduleType"),
        "file_watch_trigger" => Some("folder"),
        "desktop_notification" => Some("title"),
        "move_file" => Some(if config.get("source").is_none() {
            "source"
        } else {
            "destinationFolder"
        }),
        "run_command" => Some("executable"),
        "ai_prompt" => Some(if empty_string(config, "connectionId") {
            "connectionId"
        } else {
            "prompt"
        }),
        "code" | "javascript_code" | "python_code" => Some("sourceCode"),
        "web_builder" => Some(if missing_string_or_binding(node, "html") {
            "html"
        } else if missing_string_or_binding(node, "javascript") {
            "javascript"
        } else {
            "css"
        }),
        "open_browser" => Some("profileId"),
        "click_element" | "select_option" | "extract_data" => Some("locator"),
        "fill_field" => Some(if !has_locator(config) {
            "locator"
        } else {
            "value"
        }),
        "download_file" => Some(if !has_locator(config) {
            "locator"
        } else {
            "destinationFolder"
        }),
        "upload_file" => Some(if !has_locator(config) {
            "locator"
        } else {
            "file"
        }),
        "gmail_new_email_trigger" => Some("credentialId"),
        "gmail_get_email" => Some(if empty_string(config, "credentialId") {
            "credentialId"
        } else {
            "messageId"
        }),
        "gmail_create_draft" | "gmail_send_email" => {
            Some(if empty_string(config, "credentialId") {
                "credentialId"
            } else {
                "to"
            })
        }
        "gmail_add_label" => Some(if empty_string(config, "credentialId") {
            "credentialId"
        } else {
            "messageId"
        }),
        "discord_webhook" | "discord_embed" | "slack_webhook" => {
            Some(if empty_string(config, "credentialId") {
                "credentialId"
            } else if node.node_type == "discord_embed" {
                "description"
            } else {
                "content"
            })
        }
        "approval" => Some("proposedAction"),
        _ => None,
    }
}

fn empty_string(configuration: &serde_json::Value, key: &str) -> bool {
    configuration
        .get(key)
        .and_then(|value| value.as_str())
        .map(str::trim)
        .unwrap_or("")
        .is_empty()
}

fn has_locator(configuration: &serde_json::Value) -> bool {
    configuration
        .get("locator")
        .and_then(|value| value.get("primary"))
        .and_then(|value| value.get("value"))
        .and_then(|value| value.as_str())
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}

fn is_browser_action(node_type: &str) -> bool {
    matches!(
        node_type,
        "navigate"
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
    )
}

fn has_upstream_browser_session(
    workflow: &Workflow,
    node_id: &str,
    visited: &mut HashSet<String>,
) -> bool {
    if !visited.insert(node_id.to_string()) {
        return false;
    }
    workflow
        .edges
        .iter()
        .filter(|edge| edge.target_node_id == node_id)
        .any(|edge| {
            workflow
                .nodes
                .iter()
                .find(|node| node.id == edge.source_node_id)
                .map(|node| {
                    node.node_type == "open_browser"
                        || (is_browser_action(&node.node_type)
                            && has_upstream_browser_session(workflow, &node.id, visited))
                })
                .unwrap_or(false)
        })
}

fn issue(
    code: &str,
    message: impl Into<String>,
    node_id: Option<String>,
    edge_id: Option<String>,
) -> ValidationIssue {
    ValidationIssue {
        code: code.into(),
        message: message.into(),
        severity: ValidationSeverity::Error,
        node_id,
        edge_id,
        field_path: None,
        suggestion: None,
    }
}

pub fn topological_order(workflow: &Workflow) -> Result<Vec<String>, EngineError> {
    let mut indegree: HashMap<&str, usize> =
        workflow.nodes.iter().map(|n| (n.id.as_str(), 0)).collect();
    let mut outgoing: HashMap<&str, Vec<&str>> = HashMap::new();
    for edge in &workflow.edges {
        if let Some(value) = indegree.get_mut(edge.target_node_id.as_str()) {
            *value += 1;
        }
        outgoing
            .entry(edge.source_node_id.as_str())
            .or_default()
            .push(edge.target_node_id.as_str());
    }
    let mut queue: VecDeque<&str> = workflow
        .nodes
        .iter()
        .filter(|n| indegree.get(n.id.as_str()) == Some(&0))
        .map(|n| n.id.as_str())
        .collect();
    let mut result = Vec::new();
    while let Some(id) = queue.pop_front() {
        result.push(id.to_string());
        for target in outgoing.get(id).into_iter().flatten() {
            if let Some(value) = indegree.get_mut(target) {
                *value -= 1;
                if *value == 0 {
                    queue.push_back(target);
                }
            }
        }
    }
    if result.len() != workflow.nodes.len() {
        return Err(EngineError::Validation("Workflow contains a cycle.".into()));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::*;
    use chrono::Utc;
    use serde_json::json;
    fn workflow(edges: Vec<(&str, &str)>) -> Workflow {
        let nodes = ["a", "b", "c"]
            .iter()
            .map(|id| WorkflowNode {
                id: id.to_string(),
                node_type: if *id == "a" {
                    "manual_trigger"
                } else {
                    "set_data"
                }
                .into(),
                version: 1,
                name: id.to_string(),
                position: Position { x: 0., y: 0. },
                configuration: json!({}),
                disabled: false,
                input_bindings: Default::default(),
                plugin: None,
                customization: None,
                error_policy: None,
            })
            .collect();
        Workflow {
            id: "w".into(),
            schema_version: crate::model::CURRENT_SCHEMA_VERSION,
            owner: Default::default(),
            name: "test".into(),
            description: "".into(),
            enabled: true,
            trigger_node_id: "a".into(),
            nodes,
            edges: edges
                .into_iter()
                .enumerate()
                .map(|(i, (s, t))| WorkflowEdge {
                    id: i.to_string(),
                    source_node_id: s.into(),
                    source_handle: "output".into(),
                    target_node_id: t.into(),
                    target_handle: "input".into(),
                    kind: "control".into(),
                    source_port: Some("output".into()),
                    target_port: Some("input".into()),
                })
                .collect(),
            settings: Default::default(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }
    #[test]
    fn orders_dependencies() {
        assert_eq!(
            topological_order(&workflow(vec![("a", "b"), ("b", "c")])).unwrap(),
            vec!["a", "b", "c"]
        );
    }
    #[test]
    fn detects_cycles() {
        assert!(topological_order(&workflow(vec![("a", "b"), ("b", "c"), ("c", "a")])).is_err());
    }
    #[test]
    fn reports_disconnected_node() {
        assert!(validate(&workflow(vec![("a", "b")]))
            .iter()
            .any(|i| i.code == "disconnected_node"));
    }

    #[test]
    fn allows_unconnected_notes_but_rejects_note_edges() {
        let mut annotated = workflow(vec![("a", "b")]);
        annotated.nodes[2].node_type = "note".into();
        annotated.nodes[2].configuration = json!({"content":"Choose a connection."});
        assert!(!validate(&annotated)
            .iter()
            .any(|issue| issue.code == "disconnected_node" && issue.node_id.as_deref() == Some("c")));

        annotated.edges.push(WorkflowEdge {
            id: "note-edge".into(),
            source_node_id: "a".into(),
            source_handle: "output".into(),
            target_node_id: "c".into(),
            target_handle: "input".into(),
            kind: "control".into(),
            source_port: Some("output".into()),
            target_port: Some("input".into()),
        });
        assert!(validate(&annotated)
            .iter()
            .any(|issue| issue.code == "note_connection"));
    }
    #[test]
    fn validates_collection_graph_shapes_and_rules() {
        let mut switch = workflow(vec![("a", "b")]);
        switch.nodes[1].node_type = "switch".into();
        switch.nodes[1].configuration = json!({"cases":[]});
        assert!(validate(&switch)
            .iter()
            .any(|issue| issue.code == "switch_cases_missing"));

        let mut filter = workflow(vec![("a", "b")]);
        filter.nodes[1].node_type = "filter".into();
        filter.nodes[1].configuration =
            json!({"rules":[{"field":"name","operator":"matches_regex","value":"["}]});
        assert!(validate(&filter)
            .iter()
            .any(|issue| issue.code == "rule_regex_invalid"));

        let converged = workflow(vec![("a", "b"), ("a", "c"), ("b", "c")]);
        assert!(validate(&converged)
            .iter()
            .any(|issue| issue.code == "ambiguous_convergence"));
    }

    #[test]
    fn validates_loop_and_merge_boundaries() {
        let mut looped = workflow(vec![("a", "b")]);
        looped.nodes[1].node_type = "loop_over_items".into();
        looped.nodes[1].configuration = json!({"maxIterations":0,"concurrency":99});
        let issues = validate(&looped);
        for code in [
            "loop_body_missing",
            "loop_completion_missing",
            "loop_unbounded",
            "loop_concurrency_limit",
        ] {
            assert!(
                issues.iter().any(|issue| issue.code == code),
                "missing {code}"
            );
        }

        let mut merged = workflow(vec![("a", "b")]);
        merged.nodes[1].node_type = "merge".into();
        merged.nodes[1].configuration =
            json!({"mode":"cartesian","maxResults":0,"inputPorts":[{"id":"same"},{"id":"same"}]});
        let issues = validate(&merged);
        assert!(issues
            .iter()
            .any(|issue| issue.code == "merge_input_id_duplicate"));
        assert!(issues
            .iter()
            .any(|issue| issue.code == "merge_cartesian_unbounded"));
    }
}
