use crate::{credential_vault::CredentialVault, AppState};
use sandbox_engine::{
    validation::{validate, ValidationIssue, ValidationSeverity},
    ConnectionStatus, Database, Position, Workflow, WorkflowEdge, WorkflowNode,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    error::Error as StdError,
    sync::Arc,
};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

type Result<T> = std::result::Result<T, String>;
const MAX_AI_BUILD_ATTEMPTS: usize = 3;

const SUPPORTED_NODES: &[&str] = &[
    "note",
    "manual_trigger",
    "schedule_trigger",
    "file_watch_trigger",
    "condition",
    "filter",
    "split_out",
    "aggregate",
    "remove_duplicates",
    "set_data",
    "map_fields",
    "validate_schema",
    "text_template",
    "hash_data",
    "delay",
    "http_request",
    "desktop_notification",
    "move_file",
    "read_file",
    "write_file",
    "copy_path",
    "delete_path",
    "list_folder",
    "parse_csv",
    "parse_json",
    "parse_text",
    "get_workflow_state",
    "set_workflow_state",
    "compare_previous",
    "run_command",
    "ai_prompt",
    "code",
    "javascript_code",
    "python_code",
    "web_builder",
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
    "gmail_new_email_trigger",
    "gmail_get_email",
    "gmail_create_draft",
    "gmail_send_email",
    "gmail_add_label",
    "discord_webhook",
    "discord_embed",
    "slack_webhook",
    "approval",
];

const TRIGGER_NODES: &[&str] = &[
    "manual_trigger",
    "schedule_trigger",
    "file_watch_trigger",
    "gmail_new_email_trigger",
];

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiGraph {
    #[serde(default)]
    reply: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    nodes: Vec<AiNode>,
    edges: Vec<AiEdge>,
}

#[derive(Debug, Deserialize, Serialize)]
struct AiNode {
    key: String,
    #[serde(rename = "type")]
    node_type: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default = "empty_object")]
    configuration: Value,
    #[serde(default)]
    disabled: bool,
    #[serde(default, rename = "inputBindings")]
    input_bindings: BTreeMap<String, AiBinding>,
}

#[derive(Debug, Deserialize, Serialize)]
struct AiBinding {
    source: String,
    #[serde(default = "default_output_port")]
    output: String,
}

fn default_output_port() -> String {
    "result".into()
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiEdge {
    source: String,
    target: String,
    #[serde(default = "output_handle")]
    source_handle: String,
    #[serde(default = "input_handle")]
    target_handle: String,
}

fn input_handle() -> String {
    "input".into()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiWorkflowProposal {
    workflow: Workflow,
    message: String,
    added_node_count: usize,
    removed_node_count: usize,
    issues: Vec<ValidationIssue>,
    tested: bool,
    validation_attempts: usize,
}

fn empty_object() -> Value {
    json!({})
}

fn output_handle() -> String {
    "output".into()
}

#[tauri::command]
pub async fn build_workflow_with_ai(
    connection_id: String,
    message: String,
    workflow: Workflow,
    request_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AiWorkflowProposal> {
    let request = message.trim();
    if request.is_empty() {
        return Err("Tell the AI what you want to build or change.".into());
    }
    if request.chars().count() > 8_000 {
        return Err("AI workflow requests are limited to 8,000 characters.".into());
    }

    emit_workflow_activity(
        &app,
        &request_id,
        "connection",
        "Checking the selected AI connection",
        0,
    );
    let connection = state
        .engine
        .database()
        .get_connection(&connection_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "The selected AI connection no longer exists.".to_string())?;
    if !matches!(
        connection.provider.as_str(),
        "openai" | "anthropic" | "openai_compatible"
    ) {
        return Err("Choose an OpenAI, Anthropic, or OpenAI-compatible connection.".into());
    }
    let secret = state.credential_vault.get(&connection_id)?;
    let api_key = secret
        .get("apiKey")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "The AI API key is missing. Reconnect this provider.".to_string())?;
    let model = connection
        .metadata
        .get("model")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "The AI connection needs a model ID. Reconnect it with a model available to your account.".to_string())?;

    let system = system_prompt();
    let current = serde_json::to_string(&workflow)
        .map_err(|error| format!("The current workflow could not be prepared: {error}"))?;
    let mut user = format!(
        "USER REQUEST:\n{request}\n\nCURRENT WORKFLOW:\n{current}\n\nReturn the complete replacement graph as JSON."
    );
    for attempt in 1..=MAX_AI_BUILD_ATTEMPTS {
        emit_workflow_activity(
            &app,
            &request_id,
            "provider",
            &format!(
                "Waiting for {model} to {} the workflow",
                if attempt == 1 { "build" } else { "repair" }
            ),
            attempt,
        );
        let content = request_provider(
            &connection.provider,
            &connection.metadata,
            api_key,
            model,
            &system,
            &user,
        )
        .await?;
        emit_workflow_activity(
            &app,
            &request_id,
            "parsing",
            "Parsing the returned nodes, bindings, and connections",
            attempt,
        );
        let graph = match parse_graph(&content) {
            Ok(graph) => graph,
            Err(error) if attempt < MAX_AI_BUILD_ATTEMPTS => {
                emit_workflow_activity(
                    &app,
                    &request_id,
                    "repair",
                    "The response was not valid workflow JSON; asking the model to correct it",
                    attempt,
                );
                user = format!(
                    "The previous response for this request was not valid workflow JSON. Return the complete corrected replacement graph in the required JSON shape, with no Markdown or commentary outside it.\n\nORIGINAL USER REQUEST:\n{request}\n\nPARSING FAILURE:\n{error}\n\nINVALID RESPONSE:\n{}",
                    truncate(&content, 20_000)
                );
                continue;
            }
            Err(error) => {
                return Err(format!(
                    "The AI did not return valid workflow JSON after {attempt} attempts. No draft was returned. {error}"
                ));
            }
        };
        let graph_json = serde_json::to_string(&graph)
            .map_err(|error| format!("The AI graph could not be tested: {error}"))?;
        emit_workflow_activity(
            &app,
            &request_id,
            "validation",
            "Testing the complete graph with the workflow validator",
            attempt,
        );
        let mut proposal = match graph_to_proposal(graph, workflow.clone()) {
            Ok(proposal) => proposal,
            Err(error) if attempt < MAX_AI_BUILD_ATTEMPTS => {
                emit_workflow_activity(
                    &app,
                    &request_id,
                    "repair",
                    "The graph could not be loaded by the workflow engine; asking the model to repair it",
                    attempt,
                );
                user = format!(
                    "The previous graph for this request could not be loaded by the workflow engine. Return the complete corrected replacement graph in the required JSON shape.\n\nORIGINAL USER REQUEST:\n{request}\n\nFAILED GRAPH:\n{graph_json}\n\nENGINE FAILURE:\n{error}\n\nFix the failure without removing requested behaviour."
                );
                continue;
            }
            Err(error) => {
                return Err(format!(
                    "The AI graph still could not be loaded after {attempt} attempts. No draft was returned. {error}"
                ));
            }
        };
        let blocking_issues = proposal
            .issues
            .iter()
            .filter(|issue| is_blocking_ai_issue(issue))
            .collect::<Vec<_>>();
        if blocking_issues.is_empty() {
            proposal.tested = proposal.issues.is_empty();
            proposal.validation_attempts = attempt;
            emit_workflow_activity(
                &app,
                &request_id,
                "complete",
                if proposal.tested {
                    "Workflow test passed with no validation issues"
                } else {
                    "Draft is structurally sound and ready for you to finish"
                },
                attempt,
            );
            return Ok(proposal);
        }

        let issue_summary = blocking_issues
            .iter()
            .map(|issue| format!("- {}: {}", issue.code, issue.message))
            .collect::<Vec<_>>()
            .join("\n");
        if attempt == MAX_AI_BUILD_ATTEMPTS {
            return Err(format!(
                "The AI draft still failed workflow testing after {attempt} attempts. No draft was returned. {} Please add the missing details and try again.",
                proposal
                    .issues
                    .first()
                    .map(|issue| issue.message.as_str())
                    .unwrap_or("The graph is incomplete.")
            ));
        }
        emit_workflow_activity(
            &app,
            &request_id,
            "repair",
            &format!(
                "Found {} issue{}; sending the exact failures back for repair",
                proposal.issues.len(),
                if proposal.issues.len() == 1 { "" } else { "s" }
            ),
            attempt,
        );
        user = format!(
            "The previous graph for this request failed the application's workflow tests. Return a complete corrected replacement graph in the required JSON shape. Do not explain the errors outside the JSON.\n\nORIGINAL USER REQUEST:\n{request}\n\nFAILED GRAPH:\n{graph_json}\n\nVALIDATION FAILURES:\n{issue_summary}\n\nFix every failure. Do not remove requested behaviour merely to silence validation."
        );
    }
    Err("The AI workflow test ended unexpectedly. No draft was returned.".into())
}

/// Missing credentials, URLs, paths, and other user-owned values should not
/// prevent the AI from returning a useful graph. The editor highlights those
/// fields before a run; malformed topology and invalid bindings remain fatal.
fn is_blocking_ai_issue(issue: &ValidationIssue) -> bool {
    issue.code != "incomplete_node"
        && (issue.severity == ValidationSeverity::Error || issue.code == "disconnected_node")
}

fn emit_workflow_activity(
    app: &AppHandle,
    request_id: &str,
    phase: &str,
    message: &str,
    attempt: usize,
) {
    let _ = app.emit(
        "ai-workflow-activity",
        json!({
            "requestId": request_id,
            "phase": phase,
            "message": message,
            "attempt": attempt,
        }),
    );
}

pub(crate) async fn run_ai_prompt(
    database: &Database,
    vault: Arc<dyn CredentialVault>,
    payload: Value,
) -> Result<Value> {
    let connection_id = payload
        .get("connectionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "AI requires a connected model.".to_string())?;
    let prompt = payload
        .get("prompt")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "AI requires an instruction.".to_string())?;
    let system = payload
        .get("systemPrompt")
        .and_then(Value::as_str)
        .unwrap_or("You are a helpful workflow assistant.");
    let max_tokens = payload
        .get("maxTokens")
        .and_then(Value::as_u64)
        .unwrap_or(1_200)
        .clamp(64, 32_000);
    let temperature = payload
        .get("temperature")
        .and_then(Value::as_f64)
        .unwrap_or(0.2)
        .clamp(0.0, 1.0);
    let mut connection = database
        .get_connection(connection_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "The selected AI connection no longer exists.".to_string())?;
    if connection.status != ConnectionStatus::Connected
        || !matches!(
            connection.provider.as_str(),
            "openai" | "anthropic" | "openai_compatible"
        )
    {
        return Err("The selected AI connection must be reconnected before it can run.".into());
    }
    let secret = vault.get(connection_id)?;
    let api_key = secret
        .get("apiKey")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "The AI API key is missing. Reconnect this provider.".to_string())?;
    let model = connection
        .metadata
        .get("model")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| "The AI connection needs a model ID.".to_string())?;
    let (response, usage) = request_text_provider(
        &connection.provider,
        &connection.metadata,
        api_key,
        &model,
        system,
        prompt,
        max_tokens,
        temperature,
    )
    .await?;
    connection.last_used_at = Some(chrono::Utc::now());
    database
        .save_connection(&connection)
        .map_err(|error| error.to_string())?;
    Ok(json!({
        "response": response,
        "usage": usage,
        "model": model,
        "provider": connection.provider,
    }))
}

#[tauri::command]
pub async fn generate_code_with_ai(
    connection_id: String,
    language: String,
    instruction: String,
    current_code: String,
    state: State<'_, AppState>,
) -> Result<Value> {
    if !matches!(language.as_str(), "python" | "html" | "javascript" | "css") {
        return Err(
            "Choose Python, HTML, JavaScript, or CSS before asking AI to write code.".into(),
        );
    }
    let instruction = instruction.trim();
    if instruction.is_empty() {
        return Err("Describe the code you want AI to write.".into());
    }
    if instruction.chars().count() > 8_000 || current_code.len() > 2 * 1024 * 1024 {
        return Err("The AI coding request is too large.".into());
    }
    let system = format!(
        "You are the code-writing assistant inside sndbox. Write production-quality {language}. Return only the complete code for the file, with no Markdown fences or explanation. Preserve useful existing behaviour unless the user asks to replace it. The code may run inside a workflow or, for HTML, JavaScript, and CSS, feed a localhost Web Builder node. Never include credentials, API keys, or private data."
    );
    let prompt = format!(
        "USER INSTRUCTION:\n{instruction}\n\nCURRENT {language_upper} CODE:\n{current_code}\n\nReturn the complete updated file.",
        language_upper = language.to_uppercase(),
    );
    let output = run_ai_prompt(
        state.engine.database(),
        state.credential_vault.clone(),
        json!({
            "connectionId": connection_id,
            "prompt": prompt,
            "systemPrompt": system,
            "maxTokens": 8_000,
            "temperature": 0.15,
        }),
    )
    .await?;
    let response = output
        .get("response")
        .and_then(Value::as_str)
        .map(strip_code_fence)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "AI returned an empty code block.".to_string())?;
    Ok(json!({
        "code": response,
        "model": output.get("model"),
        "usage": output.get("usage"),
    }))
}

fn strip_code_fence(value: &str) -> String {
    let trimmed = value.trim();
    if !trimmed.starts_with("```") {
        return trimmed.to_string();
    }
    let start = trimmed.find('\n').map(|index| index + 1).unwrap_or(3);
    let end = trimmed
        .rfind("```")
        .filter(|index| *index >= start)
        .unwrap_or(trimmed.len());
    trimmed[start..end].trim().to_string()
}

async fn request_text_provider(
    provider: &str,
    metadata: &Value,
    api_key: &str,
    model: &str,
    system: &str,
    prompt: &str,
    max_tokens: u64,
    temperature: f64,
) -> Result<(String, Value)> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("The AI client could not start: {error}"))?;
    let response = if provider == "anthropic" {
        client
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&json!({
                "model": model,
                "max_tokens": max_tokens,
                "temperature": temperature,
                "system": system,
                "messages": [{"role": "user", "content": prompt}],
            }))
            .send()
            .await
    } else if provider == "openai" {
        client
            .post("https://api.openai.com/v1/responses")
            .bearer_auth(api_key)
            .json(&json!({
                "model": model,
                "instructions": system,
                "input": prompt,
                "max_output_tokens": max_tokens,
                "store": false,
            }))
            .send()
            .await
    } else {
        let base = compatible_base_url(metadata)?;
        client
            .post(format!("{}/chat/completions", base.trim_end_matches('/')))
            .bearer_auth(api_key)
            .json(&json!({
                "model": model,
                "max_tokens": max_tokens,
                "temperature": temperature,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": prompt},
                ],
            }))
            .send()
            .await
    }
    .map_err(ai_transport_error)?;
    let status = response.status();
    let value: Value = response
        .json()
        .await
        .map_err(|error| format!("The AI provider returned an unreadable response: {error}"))?;
    if !status.is_success() {
        let detail = value
            .pointer("/error/message")
            .and_then(Value::as_str)
            .or_else(|| value.get("error").and_then(Value::as_str))
            .unwrap_or("The provider rejected the request.");
        return Err(format!(
            "AI provider HTTP {status}: {}",
            truncate(detail, 500)
        ));
    }
    let content = if provider == "anthropic" {
        value
            .get("content")
            .and_then(Value::as_array)
            .and_then(|items| {
                items
                    .iter()
                    .find(|item| item.get("type").and_then(Value::as_str) == Some("text"))
            })
            .and_then(|item| item.get("text"))
            .and_then(Value::as_str)
    } else if provider == "openai" {
        value
            .get("output")
            .and_then(Value::as_array)
            .and_then(|items| {
                items
                    .iter()
                    .find_map(|item| item.get("content").and_then(Value::as_array))
            })
            .and_then(|items| {
                items
                    .iter()
                    .find(|item| item.get("type").and_then(Value::as_str) == Some("output_text"))
            })
            .and_then(|item| item.get("text"))
            .and_then(Value::as_str)
    } else {
        value
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
    }
    .ok_or_else(|| "The AI provider returned no text response.".to_string())?;
    Ok((
        content.to_string(),
        value.get("usage").cloned().unwrap_or_else(|| json!({})),
    ))
}

async fn request_provider(
    provider: &str,
    metadata: &Value,
    api_key: &str,
    model: &str,
    system: &str,
    user: &str,
) -> Result<String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("The AI client could not start: {error}"))?;

    let response = if provider == "anthropic" {
        client
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&json!({
                "model": model,
                "max_tokens": 8_000,
                "system": system,
                "messages": [{"role": "user", "content": user}]
            }))
            .send()
            .await
    } else if provider == "openai" {
        client
            .post("https://api.openai.com/v1/responses")
            .bearer_auth(api_key)
            .json(&json!({
                "model": model,
                "instructions": system,
                "input": user,
                "max_output_tokens": 8_000,
                "store": false,
                "text": {
                    "format": {
                        "type": "json_schema",
                        "name": "sndbox_workflow_graph",
                        "strict": false,
                        "schema": workflow_schema()
                    }
                }
            }))
            .send()
            .await
    } else {
        let base = compatible_base_url(metadata)?;
        client
            .post(format!("{}/chat/completions", base.trim_end_matches('/')))
            .bearer_auth(api_key)
            .json(&json!({
                "model": model,
                "max_tokens": 8_000,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user}
                ]
            }))
            .send()
            .await
    }
    .map_err(ai_transport_error)?;

    let status = response.status();
    let value: Value = response
        .json()
        .await
        .map_err(|error| format!("The AI provider returned an unreadable response: {error}"))?;
    if !status.is_success() {
        let detail = value
            .pointer("/error/message")
            .or_else(|| value.get("error"))
            .and_then(Value::as_str)
            .unwrap_or("The provider rejected the request.");
        return Err(format!(
            "AI provider HTTP {status}: {}",
            truncate(detail, 500)
        ));
    }

    if provider == "anthropic" {
        value
            .get("content")
            .and_then(Value::as_array)
            .and_then(|items| {
                items
                    .iter()
                    .find(|item| item.get("type").and_then(Value::as_str) == Some("text"))
            })
            .and_then(|item| item.get("text"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "Anthropic returned no text response.".into())
    } else if provider == "openai" {
        value
            .get("output")
            .and_then(Value::as_array)
            .and_then(|items| {
                items.iter().find_map(|item| {
                    item.get("content")
                        .and_then(Value::as_array)
                        .and_then(|content| {
                            content.iter().find(|part| {
                                part.get("type").and_then(Value::as_str) == Some("output_text")
                            })
                        })
                })
            })
            .and_then(|item| item.get("text"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "OpenAI returned no workflow output.".into())
    } else {
        value
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "The OpenAI-compatible provider returned no text response.".into())
    }
}

fn compatible_base_url(metadata: &Value) -> Result<String> {
    let raw = metadata
        .get("baseUrl")
        .and_then(Value::as_str)
        .ok_or_else(|| "The OpenAI-compatible connection needs a base URL.".to_string())?;
    let url = reqwest::Url::parse(raw).map_err(|_| "The AI base URL is invalid.".to_string())?;
    let local = matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    if url.scheme() != "https" && !(url.scheme() == "http" && local) {
        return Err("AI base URLs must use HTTPS; HTTP is allowed only for localhost.".into());
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Put credentials in the API key field, not in the AI base URL.".into());
    }
    Ok(raw.trim_end_matches('/').to_string())
}

fn ai_transport_error(error: reqwest::Error) -> String {
    let mut chain = vec![error.to_string()];
    let mut source = error.source();
    while let Some(cause) = source {
        let detail = cause.to_string();
        if !detail.is_empty() && chain.last() != Some(&detail) {
            chain.push(detail);
        }
        source = cause.source();
    }
    let guidance = if error.is_timeout() {
        "The request timed out. Check the connection and try again."
    } else if error.is_connect() {
        "Check your internet connection, VPN, proxy, firewall, and any TLS-inspection certificate configured on this device."
    } else if error.is_builder() {
        "Reconnect this AI provider; the stored endpoint or credential contains an invalid value."
    } else {
        "Try again, then test the connection from Settings if the problem continues."
    };
    format!(
        "The AI provider could not be reached. {} {guidance}",
        chain.join(": ")
    )
}

pub(crate) async fn test_ai_provider_connection(
    provider: &str,
    metadata: &Value,
    api_key: &str,
) -> Result<Value> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("The AI client could not start: {error}"))?;
    let response = if provider == "anthropic" {
        client
            .get("https://api.anthropic.com/v1/models")
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .send()
            .await
    } else if provider == "openai" {
        client
            .get("https://api.openai.com/v1/models")
            .bearer_auth(api_key)
            .send()
            .await
    } else if provider == "openai_compatible" {
        let base = compatible_base_url(metadata)?;
        client
            .get(format!("{}/models", base.trim_end_matches('/')))
            .bearer_auth(api_key)
            .send()
            .await
    } else {
        return Err("This connection is not an AI provider.".into());
    }
    .map_err(ai_transport_error)?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("The AI provider returned an unreadable response: {error}"))?;
    if !status.is_success() {
        let value = serde_json::from_str::<Value>(&body).unwrap_or(Value::Null);
        let detail = value
            .pointer("/error/message")
            .and_then(Value::as_str)
            .or_else(|| value.get("error").and_then(Value::as_str))
            .unwrap_or_else(|| body.trim());
        let detail = if detail.is_empty() {
            "The provider rejected the connection test."
        } else {
            detail
        };
        return Err(format!(
            "AI provider HTTP {status}: {}",
            truncate(detail, 500)
        ));
    }

    Ok(json!({
        "healthy": true,
        "provider": provider,
        "message": "The AI provider is reachable and accepted this credential."
    }))
}

fn parse_graph(content: &str) -> Result<AiGraph> {
    let trimmed = content.trim();
    let json_text = if trimmed.starts_with("```") {
        let after_line = trimmed.find('\n').map(|index| index + 1).unwrap_or(3);
        let end = trimmed.rfind("```").unwrap_or(trimmed.len());
        &trimmed[after_line..end]
    } else {
        trimmed
    };
    let candidate = json_text.trim();
    if let Ok(graph) = serde_json::from_str(candidate) {
        return Ok(graph);
    }
    // Compatible providers do not all honour JSON-only instructions. Recover
    // a complete outer object when they add a short preface or epilogue.
    if let (Some(start), Some(end)) = (candidate.find('{'), candidate.rfind('}')) {
        if start < end {
            if let Ok(graph) = serde_json::from_str(&candidate[start..=end]) {
                return Ok(graph);
            }
        }
    }
    // A few gateways encode the JSON object as a JSON string.
    if let Ok(encoded) = serde_json::from_str::<String>(candidate) {
        if let Ok(graph) = serde_json::from_str(&encoded) {
            return Ok(graph);
        }
    }
    serde_json::from_str::<AiGraph>(candidate).map_err(|error| {
        format!("The AI response was not a valid sndbox workflow proposal: {error}")
    })
}

fn graph_to_proposal(graph: AiGraph, current: Workflow) -> Result<AiWorkflowProposal> {
    let mut graph = graph;
    if graph.nodes.is_empty() || graph.nodes.len() > 100 {
        return Err("AI proposals must contain between 1 and 100 nodes.".into());
    }
    if graph.edges.len() > 250 {
        return Err("The AI proposal contains too many connections.".into());
    }
    let allowed: HashSet<&str> = SUPPORTED_NODES.iter().copied().collect();
    let mut keys = HashSet::new();
    for node in &graph.nodes {
        if node.key.trim().is_empty() || !keys.insert(node.key.clone()) {
            return Err("Every AI-proposed node needs a unique, non-empty key.".into());
        }
        if !allowed.contains(node.node_type.as_str()) {
            return Err(format!(
                "The AI proposed an unsupported node type: {}.",
                node.node_type
            ));
        }
        if !node.configuration.is_object() {
            return Err(format!(
                "Configuration for {} must be a JSON object.",
                node.key
            ));
        }
    }
    let trigger_keys: Vec<String> = graph
        .nodes
        .iter()
        .filter(|node| TRIGGER_NODES.contains(&node.node_type.as_str()))
        .map(|node| node.key.clone())
        .collect();
    if trigger_keys.len() != 1 {
        return Err("The AI proposal must contain exactly one trigger node.".into());
    }
    let trigger_key = trigger_keys[0].clone();

    apply_configuration_defaults(&mut graph);
    normalize_web_builder_connections(&mut graph);
    normalize_workflow_connections(&mut graph, &trigger_key);

    let ids: HashMap<String, String> = graph
        .nodes
        .iter()
        .map(|node| {
            (
                node.key.clone(),
                format!("{}_{}", node.node_type, &Uuid::new_v4().to_string()[..8]),
            )
        })
        .collect();
    let node_types: HashMap<String, String> = graph
        .nodes
        .iter()
        .map(|node| (node.key.clone(), node.node_type.clone()))
        .collect();
    let code_languages: HashMap<String, String> = graph
        .nodes
        .iter()
        .filter(|node| node.node_type == "code")
        .filter_map(|node| {
            node.configuration
                .get("language")
                .and_then(Value::as_str)
                .map(|language| (node.key.clone(), language.to_string()))
        })
        .collect();
    let mut level = HashMap::<String, usize>::from([(trigger_key.clone(), 0)]);
    for _ in 0..graph.nodes.len() {
        for edge in &graph.edges {
            if let Some(source_level) = level.get(&edge.source).copied() {
                let next = source_level + 1;
                level
                    .entry(edge.target.clone())
                    .and_modify(|value| *value = (*value).max(next))
                    .or_insert(next);
            }
        }
    }
    let mut rows = HashMap::<usize, usize>::new();
    let nodes: Vec<WorkflowNode> = graph
        .nodes
        .into_iter()
        .map(|node| -> Result<WorkflowNode> {
            let column = level.get(&node.key).copied().unwrap_or(0);
            let row = rows.entry(column).or_insert(0);
            let position = Position {
                x: 60.0 + column as f64 * 280.0,
                y: 140.0 + *row as f64 * 160.0,
            };
            *row += 1;
            let mut input_bindings = BTreeMap::new();
            for (field, binding) in node.input_bindings {
                let source_id = ids.get(&binding.source).ok_or_else(|| {
                    format!(
                        "Input '{field}' on {} references a missing source node.",
                        node.key
                    )
                })?;
                if binding.source == node.key {
                    return Err(format!(
                        "Input '{field}' on {} cannot reference itself.",
                        node.key
                    ));
                }
                input_bindings.insert(
                    field,
                    sandbox_engine::InputBinding::NodeOutput {
                        node_id: source_id.clone(),
                        path: vec![binding.output],
                    },
                );
            }
            Ok(WorkflowNode {
                id: ids[&node.key].clone(),
                node_type: node.node_type.clone(),
                version: 1,
                name: node
                    .name
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| title_case(&node.node_type)),
                position,
                configuration: node.configuration,
                disabled: node.disabled,
                input_bindings,
                plugin: None,
                customization: None,
                error_policy: None,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let mut seen_edges = HashSet::new();
    let edges: Vec<WorkflowEdge> = graph
        .edges
        .into_iter()
        .map(|edge| {
            if !ids.contains_key(&edge.source)
                || !ids.contains_key(&edge.target)
                || edge.source == edge.target
            {
                return Err(
                    "The AI proposal contains a connection to a missing or identical node."
                        .to_string(),
                );
            }
            if !seen_edges.insert((
                edge.source.clone(),
                edge.target.clone(),
                edge.source_handle.clone(),
                edge.target_handle.clone(),
            )) {
                return Err("The AI proposal contains a duplicate connection.".to_string());
            }
            let web_builder_input = node_types
                .get(&edge.target)
                .is_some_and(|node_type| node_type == "web_builder");
            if web_builder_input {
                let required_language = match edge.target_handle.as_str() {
                    "html" => "html",
                    "javascript" => "javascript",
                    "css" => "css",
                    _ => return Err(
                        "Web Builder connections must target its html, javascript, or css input."
                            .to_string(),
                    ),
                };
                if node_types.get(&edge.source).map(String::as_str) != Some("code")
                    || code_languages.get(&edge.source).map(String::as_str)
                        != Some(required_language)
                {
                    return Err(format!(
                        "The Web Builder {} input requires a {} Code node.",
                        edge.target_handle, required_language
                    ));
                }
            } else if edge.target_handle != "input" {
                return Err("Only Web Builder exposes named target inputs.".to_string());
            }
            Ok(WorkflowEdge {
                id: format!("edge_{}", &Uuid::new_v4().to_string()[..8]),
                source_node_id: ids[&edge.source].clone(),
                source_handle: edge.source_handle,
                target_node_id: ids[&edge.target].clone(),
                target_handle: edge.target_handle.clone(),
                kind: "control".into(),
                source_port: web_builder_input.then(|| "code".into()),
                target_port: web_builder_input.then_some(edge.target_handle),
            })
        })
        .collect::<Result<Vec<_>>>()?;

    let added_node_count = nodes.len().saturating_sub(current.nodes.len());
    let removed_node_count = current.nodes.len().saturating_sub(nodes.len());
    let mut workflow = current;
    workflow.name = graph
        .name
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(workflow.name);
    workflow.description = graph.description.unwrap_or(workflow.description);
    workflow.trigger_node_id = ids[&trigger_key].clone();
    workflow.nodes = nodes;
    workflow.edges = edges;
    workflow.enabled = false;
    let issues = validate(&workflow);
    Ok(AiWorkflowProposal {
        workflow,
        message: if graph.reply.trim().is_empty() {
            "I drafted a workflow for you to review.".into()
        } else {
            graph.reply
        },
        added_node_count,
        removed_node_count,
        issues,
        tested: false,
        validation_attempts: 0,
    })
}

/// Fill in stable runtime options the model commonly omits. Model-supplied
/// values always win; user-owned values such as credentials and paths stay blank.
fn apply_configuration_defaults(graph: &mut AiGraph) {
    for node in &mut graph.nodes {
        let defaults = match node.node_type.as_str() {
            "note" => json!({"content":""}),
            "schedule_trigger" => {
                json!({"scheduleType":"minutes","every":15,"time":"09:00","cron":"0 */15 * * *"})
            }
            "file_watch_trigger" => json!({"folder":"","events":["created"],"pattern":""}),
            "condition" => json!({"left":"","operator":"equals","right":""}),
            "filter" => {
                json!({"mode":"keep_matches","combinator":"all","rules":[{"id":"rule_1","field":"","operator":"equals","value":""}],"exposeRejected":true})
            }
            "split_out" => {
                json!({"fieldPath":"","destinationField":"item","keepParentFields":true,"keepOriginalArray":false,"includeIndex":true,"emptyArrayPolicy":"emit_no_items","invalidInputPolicy":"fail"})
            }
            "aggregate" => {
                json!({"operation":"collect_items","fieldPath":"","includeMissing":false,"preserveLineage":false,"separator":",","groupFields":[],"keyField":"id","duplicateKeyPolicy":"fail"})
            }
            "remove_duplicates" => {
                json!({"fields":[],"caseSensitive":true,"normalizeWhitespace":false,"keep":"first","scope":"collection","exposeDuplicates":true})
            }
            "set_data" => json!({"values":{"key":"value"}}),
            "map_fields" => {
                json!({"mappings":[{"source":"","target":"value","required":false,"default":null}],"preserveUnmapped":false})
            }
            "validate_schema" => {
                json!({"rules":[{"path":"","type":"any","required":true}],"allowAdditionalFields":true})
            }
            "text_template" => json!({"template":"Hello {{input.name}}"}),
            "hash_data" => json!({"encoding":"hex"}),
            "delay" => json!({"amount":1,"unit":"seconds"}),
            "http_request" => {
                json!({"method":"GET","url":"","query":{},"headers":{},"body":null,"timeoutMs":30000,"retryCount":0})
            }
            "desktop_notification" => json!({"title":"sndbox","message":"Workflow completed"}),
            "parse_csv" => {
                json!({"path":"","content":"","delimiter":",","hasHeaders":true,"trim":true})
            }
            "parse_json" => json!({"path":"","content":""}),
            "parse_text" => json!({"path":"","content":"","trim":true,"removeEmptyLines":false}),
            "code" => {
                json!({"language":"javascript","sourceCode":"","executionMode":"source","itemMode":"all_items","runtimeVersion":">=20","helperLanguageVersion":1,"dependencies":[],"timeoutMs":30000})
            }
            "javascript_code" => {
                json!({"language":"javascript","sourceCode":"","executionMode":"run","itemMode":"all_items","runtimeVersion":">=20","helperLanguageVersion":1,"dependencies":[],"timeoutMs":30000})
            }
            "python_code" => {
                json!({"language":"python","sourceCode":"","executionMode":"run","itemMode":"all_items","runtimeVersion":">=3.11","helperLanguageVersion":1,"dependencies":[],"timeoutMs":30000})
            }
            "web_builder" => {
                json!({"html":"","javascript":"","css":"","port":0,"openBrowser":true})
            }
            _ => json!({}),
        };
        let Some(configuration) = node.configuration.as_object_mut() else {
            continue;
        };
        let Some(defaults) = defaults.as_object() else {
            continue;
        };
        for (key, value) in defaults {
            configuration
                .entry(key.clone())
                .or_insert_with(|| value.clone());
        }
    }
}

/// Restore control-flow edges that models sometimes omit. Data bindings imply
/// execution order, and every remaining disconnected component gets a safe
/// entry edge from the trigger. Notes are canvas-only and stay unconnected.
fn normalize_workflow_connections(graph: &mut AiGraph, trigger_key: &str) {
    let node_types: HashMap<String, String> = graph
        .nodes
        .iter()
        .map(|node| (node.key.clone(), node.node_type.clone()))
        .collect();

    graph.edges.retain(|edge| {
        node_types.get(&edge.source).map(String::as_str) != Some("note")
            && node_types.get(&edge.target).map(String::as_str) != Some("note")
    });

    let mut connected_pairs: HashSet<(String, String)> = graph
        .edges
        .iter()
        .map(|edge| (edge.source.clone(), edge.target.clone()))
        .collect();
    let mut inferred = Vec::new();
    for target in &graph.nodes {
        if matches!(target.node_type.as_str(), "note" | "web_builder") {
            continue;
        }
        for binding in target.input_bindings.values() {
            let Some(source_type) = node_types.get(&binding.source).map(String::as_str) else {
                continue;
            };
            if source_type == "note" || source_type == "condition" {
                continue;
            }
            if connected_pairs.insert((binding.source.clone(), target.key.clone())) {
                inferred.push(AiEdge {
                    source: binding.source.clone(),
                    target: target.key.clone(),
                    source_handle: "output".into(),
                    target_handle: "input".into(),
                });
            }
        }
    }
    graph.edges.extend(inferred);

    let mut reachable = HashSet::from([trigger_key.to_string()]);
    loop {
        let before = reachable.len();
        for edge in &graph.edges {
            if reachable.contains(&edge.source) {
                reachable.insert(edge.target.clone());
            }
        }
        if reachable.len() == before {
            break;
        }
    }

    let unreachable: HashSet<String> = graph
        .nodes
        .iter()
        .filter(|node| node.node_type != "note" && !reachable.contains(&node.key))
        .map(|node| node.key.clone())
        .collect();
    let component_roots: Vec<String> = graph
        .nodes
        .iter()
        .filter(|node| {
            unreachable.contains(&node.key)
                && node.node_type != "web_builder"
                && !node.input_bindings.values().any(|binding| {
                    node_types.get(&binding.source).map(String::as_str) == Some("condition")
                })
                && !graph
                    .edges
                    .iter()
                    .any(|edge| edge.target == node.key && unreachable.contains(&edge.source))
        })
        .map(|node| node.key.clone())
        .collect();
    for root in component_roots {
        if connected_pairs.insert((trigger_key.to_string(), root.clone())) {
            graph.edges.push(AiEdge {
                source: trigger_key.to_string(),
                target: root,
                source_handle: "output".into(),
                target_handle: "input".into(),
            });
        }
    }
}

/// Models occasionally describe a control-flow dependency as a generic edge into
/// Web Builder. The canvas has no generic Web Builder input: its three incoming
/// edges are typed source-code bindings. Repair those drafts from the Code node
/// language and discard unrelated incoming edges instead of rejecting the whole
/// workflow proposal.
fn normalize_web_builder_connections(graph: &mut AiGraph) {
    let node_types: HashMap<String, String> = graph
        .nodes
        .iter()
        .map(|node| (node.key.clone(), node.node_type.clone()))
        .collect();
    let code_languages: HashMap<String, String> = graph
        .nodes
        .iter()
        .filter(|node| node.node_type == "code")
        .filter_map(|node| {
            node.configuration
                .get("language")
                .and_then(Value::as_str)
                .filter(|language| matches!(*language, "html" | "javascript" | "css"))
                .map(|language| (node.key.clone(), language.to_string()))
        })
        .collect();
    let builder_keys: HashSet<String> = node_types
        .iter()
        .filter(|(_, node_type)| node_type.as_str() == "web_builder")
        .map(|(key, _)| key.clone())
        .collect();

    let mut claimed_inputs = HashSet::<(String, String)>::new();
    let mut normalized_edges = Vec::with_capacity(graph.edges.len());
    for mut edge in std::mem::take(&mut graph.edges) {
        if builder_keys.contains(&edge.target) {
            let Some(language) = code_languages.get(&edge.source) else {
                // HTTP, state, condition, and other workflow nodes should remain
                // in their own control-flow branch rather than feed source code.
                continue;
            };
            edge.source_handle = "output".into();
            edge.target_handle = language.clone();
            if !claimed_inputs.insert((edge.target.clone(), language.clone())) {
                continue;
            }
        }
        normalized_edges.push(edge);
    }
    graph.edges = normalized_edges;

    for builder in graph
        .nodes
        .iter_mut()
        .filter(|node| node.node_type == "web_builder")
    {
        let existing_bindings = std::mem::take(&mut builder.input_bindings);
        let mut bindings = BTreeMap::new();

        for port in ["html", "javascript", "css"] {
            let edge_source = graph
                .edges
                .iter()
                .find(|edge| edge.target == builder.key && edge.target_handle == port)
                .map(|edge| edge.source.clone());
            let bound_source = existing_bindings.get(port).and_then(|binding| {
                (code_languages.get(&binding.source).map(String::as_str) == Some(port))
                    .then(|| binding.source.clone())
            });
            let available_source = code_languages
                .iter()
                .find(|(_, language)| language.as_str() == port)
                .map(|(key, _)| key.clone());
            let Some(source) = edge_source.or(bound_source).or(available_source) else {
                continue;
            };

            bindings.insert(
                port.into(),
                AiBinding {
                    source: source.clone(),
                    output: "code".into(),
                },
            );
            if !graph
                .edges
                .iter()
                .any(|edge| edge.target == builder.key && edge.target_handle == port)
            {
                graph.edges.push(AiEdge {
                    source,
                    target: builder.key.clone(),
                    source_handle: "output".into(),
                    target_handle: port.into(),
                });
            }
        }
        builder.input_bindings = bindings;
    }
}

fn system_prompt() -> String {
    format!(
        "You are the workflow builder inside sndbox. Convert the user's request into a complete visual workflow graph using the application's nodes, not by pretending that one code block performs the whole workflow. Return JSON only, with this exact shape: {{\"reply\":\"brief explanation\",\"name\":\"optional workflow name\",\"description\":\"optional description\",\"nodes\":[{{\"key\":\"stable_local_key\",\"type\":\"node_type\",\"name\":\"label\",\"configuration\":{{}},\"inputBindings\":{{\"targetField\":{{\"source\":\"upstream_key\",\"output\":\"output_key\"}}}},\"disabled\":false}}],\"edges\":[{{\"source\":\"key\",\"target\":\"key\",\"sourceHandle\":\"output\",\"targetHandle\":\"input\"}}]}}. Output the complete replacement graph, including unchanged nodes when editing. Use exactly one trigger and make every enabled executable node reachable from it. The note node is the only exception: it is a canvas-only annotation with configuration {{\"content\":\"clear instructions\"}}, must have no edges or bindings, and is never executed. Add a note when the workflow needs setup steps, missing credentials or values, assumptions, or manual review instructions; never use a note in place of executable behaviour. Condition branches use sourceHandle true or false. Filter and Split Out use output or rejected; Remove Duplicates uses output or duplicates. Bind data between nodes with inputBindings and the upstream output key, and always add the matching control-flow edge so the source runs before the target. Important capabilities: schedule_trigger runs recurring checks; http_request performs HTTP calls and outputs status, body, and finalUrl; condition branches on values; get_workflow_state, set_workflow_state, and compare_previous persist and compare results; desktop_notification and communication nodes alert users; JavaScript Code and Python Code transform workflow data; legacy Code nodes author HTML, browser JavaScript, or CSS source; Web Builder renders a localhost interface. HTTP checks, state, conditions, and alerts must be real workflow nodes rather than browser-side fetch code when the user asks for monitoring. Code nodes use configuration {{\"language\":\"python|html|javascript|css\",\"sourceCode\":\"complete working source\",\"executionMode\":\"source|run\"}}. When the user asks for an interface, write complete HTML, JavaScript, and CSS source in three Code nodes. Web Builder accepts only those three matching Code outputs: map code to html, javascript, and css with inputBindings and create one matching edge per input. Never connect HTTP, condition, state, trigger, or notification nodes directly to Web Builder. Keep the monitoring flow as its own node branch and the interface as a Code/Web Builder branch, with both branches connected to the trigger. All non-Web-Builder edges use targetHandle input. Never leave requested code blocks empty. Never invent node types, credentials, API keys, file paths, selectors, addresses, or personal data; leave unknown external configuration values empty and explain exactly what the user must provide in a note. Keep side-effecting actions disabled when intent is ambiguous. Supported node types: {}.",
        SUPPORTED_NODES.join(", ")
    )
}

fn workflow_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["reply", "name", "description", "nodes", "edges"],
        "properties": {
            "reply": {"type": "string"},
            "name": {"type": ["string", "null"]},
            "description": {"type": ["string", "null"]},
            "nodes": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["key", "type", "name", "configuration", "disabled"],
                    "properties": {
                        "key": {"type": "string"},
                        "type": {"type": "string", "enum": SUPPORTED_NODES},
                        "name": {"type": ["string", "null"]},
                        "configuration": {"type": "object", "additionalProperties": true},
                        "inputBindings": {
                            "type": "object",
                            "additionalProperties": {
                                "type": "object",
                                "additionalProperties": false,
                                "required": ["source", "output"],
                                "properties": {
                                    "source": {"type": "string"},
                                    "output": {"type": "string"}
                                }
                            }
                        },
                        "disabled": {"type": "boolean"}
                    }
                }
            },
            "edges": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["source", "target", "sourceHandle", "targetHandle"],
                    "properties": {
                        "source": {"type": "string"},
                        "target": {"type": "string"},
                        "sourceHandle": {"type": "string", "enum": ["output", "true", "false", "rejected", "duplicates"]},
                        "targetHandle": {"type": "string", "enum": ["input", "html", "javascript", "css"]}
                    }
                }
            }
        }
    })
}

fn title_case(value: &str) -> String {
    value
        .split('_')
        .map(|part| {
            let mut chars = part.chars();
            chars
                .next()
                .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn truncate(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_local_http_compatible_provider() {
        assert_eq!(
            compatible_base_url(&json!({"baseUrl":"http://localhost:11434/v1"})).unwrap(),
            "http://localhost:11434/v1"
        );
    }

    #[test]
    fn rejects_insecure_remote_compatible_provider() {
        assert!(compatible_base_url(&json!({"baseUrl":"http://example.com/v1"})).is_err());
    }

    #[test]
    fn parses_fenced_json() {
        let value = parse_graph("```json\n{\"nodes\":[],\"edges\":[]}\n```").unwrap();
        assert!(value.nodes.is_empty());
    }

    #[test]
    fn parses_json_surrounded_by_provider_commentary() {
        let value =
            parse_graph("Here is the workflow:\n{\"nodes\":[],\"edges\":[]}\nDone.").unwrap();
        assert!(value.nodes.is_empty());
    }

    #[test]
    fn incomplete_fields_are_reviewable_but_structural_errors_block() {
        let reviewable = ValidationIssue {
            code: "incomplete_node".into(),
            message: "Add a URL.".into(),
            severity: ValidationSeverity::Error,
            node_id: None,
            edge_id: None,
            field_path: None,
            suggestion: None,
        };
        let structural = ValidationIssue {
            code: "cycle".into(),
            ..reviewable.clone()
        };
        let disconnected = ValidationIssue {
            code: "disconnected_node".into(),
            severity: ValidationSeverity::Warning,
            ..reviewable.clone()
        };
        assert!(!is_blocking_ai_issue(&reviewable));
        assert!(is_blocking_ai_issue(&structural));
        assert!(is_blocking_ai_issue(&disconnected));
    }

    #[test]
    fn strips_markdown_from_generated_code() {
        assert_eq!(
            strip_code_fence("```javascript\nconst ready = true;\n```"),
            "const ready = true;"
        );
        assert_eq!(
            strip_code_fence("body { color: red; }"),
            "body { color: red; }"
        );
    }

    #[test]
    fn turns_a_safe_graph_into_a_disabled_reviewable_workflow() {
        let current = crate::templates::blank(Some("Original".into()));
        let graph = AiGraph {
            reply: "Drafted it.".into(),
            name: Some("Daily check".into()),
            description: Some("Checks an endpoint.".into()),
            nodes: vec![
                AiNode {
                    key: "start".into(),
                    node_type: "manual_trigger".into(),
                    name: None,
                    configuration: json!({}),
                    disabled: false,
                    input_bindings: BTreeMap::new(),
                },
                AiNode {
                    key: "request".into(),
                    node_type: "http_request".into(),
                    name: Some("Check endpoint".into()),
                    configuration: json!({"url":""}),
                    disabled: true,
                    input_bindings: BTreeMap::new(),
                },
            ],
            edges: vec![AiEdge {
                source: "start".into(),
                target: "request".into(),
                source_handle: "output".into(),
                target_handle: "input".into(),
            }],
        };
        let proposal = graph_to_proposal(graph, current).unwrap();
        assert_eq!(proposal.workflow.name, "Daily check");
        assert!(!proposal.workflow.enabled);
        assert_eq!(proposal.workflow.nodes.len(), 2);
        assert_eq!(proposal.workflow.edges.len(), 1);
        assert_eq!(
            proposal.workflow.trigger_node_id,
            proposal.workflow.nodes[0].id
        );
    }

    #[test]
    fn repairs_missing_execution_edges_and_leaves_notes_unconnected() {
        let current = crate::templates::blank(Some("Original".into()));
        let graph = AiGraph {
            reply: "Drafted it.".into(),
            name: None,
            description: None,
            nodes: vec![
                AiNode {
                    key: "start".into(),
                    node_type: "manual_trigger".into(),
                    name: None,
                    configuration: json!({}),
                    disabled: false,
                    input_bindings: BTreeMap::new(),
                },
                AiNode {
                    key: "data".into(),
                    node_type: "set_data".into(),
                    name: Some("Prepare message".into()),
                    configuration: json!({"values":{"message":"Ready"}}),
                    disabled: false,
                    input_bindings: BTreeMap::new(),
                },
                AiNode {
                    key: "notify".into(),
                    node_type: "desktop_notification".into(),
                    name: None,
                    configuration: json!({"title":"Finished","message":""}),
                    disabled: false,
                    input_bindings: BTreeMap::from([(
                        "message".into(),
                        AiBinding {
                            source: "data".into(),
                            output: "value".into(),
                        },
                    )]),
                },
                AiNode {
                    key: "setup".into(),
                    node_type: "note".into(),
                    name: Some("Before running".into()),
                    configuration: json!({"content":"Review the notification text."}),
                    disabled: false,
                    input_bindings: BTreeMap::new(),
                },
            ],
            // This is a common malformed model response: the only edge points
            // to an annotation while the executable steps rely on a binding.
            edges: vec![AiEdge {
                source: "start".into(),
                target: "setup".into(),
                source_handle: "output".into(),
                target_handle: "input".into(),
            }],
        };

        let proposal = graph_to_proposal(graph, current).unwrap();
        let by_name: HashMap<_, _> = proposal
            .workflow
            .nodes
            .iter()
            .map(|node| (node.name.as_str(), node.id.as_str()))
            .collect();
        assert_eq!(proposal.workflow.edges.len(), 2);
        assert!(proposal
            .workflow
            .edges
            .iter()
            .any(
                |edge| edge.source_node_id == proposal.workflow.trigger_node_id
                    && edge.target_node_id == by_name["Prepare message"]
            ));
        assert!(proposal
            .workflow
            .edges
            .iter()
            .any(|edge| edge.source_node_id == by_name["Prepare message"]
                && edge.target_node_id == by_name["Desktop Notification"]));
        assert!(!proposal
            .workflow
            .edges
            .iter()
            .any(|edge| edge.source_node_id == by_name["Before running"]
                || edge.target_node_id == by_name["Before running"]));
        assert!(!proposal
            .issues
            .iter()
            .any(|issue| issue.code == "disconnected_node"));
    }

    #[test]
    fn translates_ai_code_bindings_to_stable_node_ids() {
        let current = crate::templates::blank(Some("Original".into()));
        let code = |key: &str, language: &str| AiNode {
            key: key.into(),
            node_type: "code".into(),
            name: None,
            configuration: json!({"language":language,"sourceCode":"working source","executionMode":"source"}),
            disabled: false,
            input_bindings: BTreeMap::new(),
        };
        let graph = AiGraph {
            reply: "Built it.".into(),
            name: None,
            description: None,
            nodes: vec![
                AiNode {
                    key: "start".into(),
                    node_type: "manual_trigger".into(),
                    name: None,
                    configuration: json!({}),
                    disabled: false,
                    input_bindings: BTreeMap::new(),
                },
                code("html", "html"),
                code("js", "javascript"),
                code("css", "css"),
                AiNode {
                    key: "site".into(),
                    node_type: "web_builder".into(),
                    name: None,
                    configuration: json!({"html":"","javascript":"","css":"","port":0,"openBrowser":true}),
                    disabled: false,
                    input_bindings: BTreeMap::from([
                        (
                            "html".into(),
                            AiBinding {
                                source: "html".into(),
                                output: "code".into(),
                            },
                        ),
                        (
                            "javascript".into(),
                            AiBinding {
                                source: "js".into(),
                                output: "code".into(),
                            },
                        ),
                        (
                            "css".into(),
                            AiBinding {
                                source: "css".into(),
                                output: "code".into(),
                            },
                        ),
                    ]),
                },
            ],
            edges: vec![
                AiEdge {
                    source: "start".into(),
                    target: "html".into(),
                    source_handle: "output".into(),
                    target_handle: "input".into(),
                },
                AiEdge {
                    source: "start".into(),
                    target: "js".into(),
                    source_handle: "output".into(),
                    target_handle: "input".into(),
                },
                AiEdge {
                    source: "start".into(),
                    target: "css".into(),
                    source_handle: "output".into(),
                    target_handle: "input".into(),
                },
                AiEdge {
                    source: "html".into(),
                    target: "site".into(),
                    source_handle: "output".into(),
                    target_handle: "html".into(),
                },
                AiEdge {
                    source: "js".into(),
                    target: "site".into(),
                    source_handle: "output".into(),
                    target_handle: "javascript".into(),
                },
                AiEdge {
                    source: "css".into(),
                    target: "site".into(),
                    source_handle: "output".into(),
                    target_handle: "css".into(),
                },
            ],
        };
        let proposal = graph_to_proposal(graph, current).unwrap();
        let builder = proposal
            .workflow
            .nodes
            .iter()
            .find(|node| node.node_type == "web_builder")
            .unwrap();
        assert_eq!(builder.input_bindings.len(), 3);
        let html_id = proposal
            .workflow
            .nodes
            .iter()
            .find(|node| node.name == "Code" && node.configuration["language"] == "html")
            .unwrap()
            .id
            .clone();
        assert_eq!(
            builder.input_bindings["html"],
            sandbox_engine::InputBinding::NodeOutput {
                node_id: html_id,
                path: vec!["code".into()]
            }
        );
        let builder_edges = proposal
            .workflow
            .edges
            .iter()
            .filter(|edge| edge.target_node_id == builder.id)
            .collect::<Vec<_>>();
        assert_eq!(builder_edges.len(), 3);
        assert!(builder_edges.iter().any(
            |edge| edge.target_handle == "html" && edge.target_port.as_deref() == Some("html")
        ));
        assert!(builder_edges
            .iter()
            .any(|edge| edge.target_handle == "javascript"
                && edge.target_port.as_deref() == Some("javascript")));
        assert!(builder_edges
            .iter()
            .any(|edge| edge.target_handle == "css" && edge.target_port.as_deref() == Some("css")));
    }

    #[test]
    fn repairs_mixed_monitor_edges_before_building_the_proposal() {
        let current = crate::templates::blank(Some("Original".into()));
        let code = |key: &str, language: &str| AiNode {
            key: key.into(),
            node_type: "code".into(),
            name: None,
            configuration: json!({
                "language": language,
                "sourceCode": "working source",
                "executionMode": "source"
            }),
            disabled: false,
            input_bindings: BTreeMap::new(),
        };
        let graph = AiGraph {
            reply: "Built a monitor and its interface.".into(),
            name: Some("Uptime monitor".into()),
            description: None,
            nodes: vec![
                AiNode {
                    key: "start".into(),
                    node_type: "schedule_trigger".into(),
                    name: None,
                    configuration: json!({"scheduleType":"minutes","every":5}),
                    disabled: false,
                    input_bindings: BTreeMap::new(),
                },
                AiNode {
                    key: "check".into(),
                    node_type: "http_request".into(),
                    name: None,
                    configuration: json!({"method":"GET","url":"","timeoutMs":30000}),
                    disabled: false,
                    input_bindings: BTreeMap::new(),
                },
                code("html", "html"),
                code("js", "javascript"),
                code("css", "css"),
                AiNode {
                    key: "site".into(),
                    node_type: "web_builder".into(),
                    name: None,
                    configuration: json!({"html":"","javascript":"","css":"","port":0,"openBrowser":true}),
                    disabled: false,
                    input_bindings: BTreeMap::new(),
                },
            ],
            edges: vec![
                AiEdge {
                    source: "start".into(),
                    target: "check".into(),
                    source_handle: "output".into(),
                    target_handle: "input".into(),
                },
                // A model may express this as a generic execution dependency.
                // It must not invalidate the otherwise useful draft.
                AiEdge {
                    source: "check".into(),
                    target: "site".into(),
                    source_handle: "output".into(),
                    target_handle: "input".into(),
                },
                AiEdge {
                    source: "html".into(),
                    target: "site".into(),
                    source_handle: "output".into(),
                    target_handle: "input".into(),
                },
                AiEdge {
                    source: "js".into(),
                    target: "site".into(),
                    source_handle: "output".into(),
                    target_handle: "input".into(),
                },
                AiEdge {
                    source: "css".into(),
                    target: "site".into(),
                    source_handle: "output".into(),
                    target_handle: "input".into(),
                },
            ],
        };

        let proposal = graph_to_proposal(graph, current).unwrap();
        let builder = proposal
            .workflow
            .nodes
            .iter()
            .find(|node| node.node_type == "web_builder")
            .unwrap();
        let incoming = proposal
            .workflow
            .edges
            .iter()
            .filter(|edge| edge.target_node_id == builder.id)
            .collect::<Vec<_>>();
        assert_eq!(incoming.len(), 3);
        assert_eq!(builder.input_bindings.len(), 3);
        assert!(incoming.iter().all(|edge| {
            matches!(edge.target_handle.as_str(), "html" | "javascript" | "css")
                && edge.source_port.as_deref() == Some("code")
        }));
    }
}
