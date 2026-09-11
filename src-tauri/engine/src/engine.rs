use crate::{
    expressions::{
        resolve_value as resolve_expression_value, ExpressionContext, EXPRESSION_LANGUAGE_VERSION,
    },
    permissions::{require_domain, require_path},
    redaction::{bounded_log, redact_value},
    references::resolve_value,
    validation::{topological_order, validate, ValidationSeverity},
    contract_for, custom_node_fingerprint, CollectionEvidence, DataLineage, Database, EffectLevel, EngineError, ErrorStrategy,
    ExecutionError, ExecutionRecord, ExecutionStatus, InputBinding, NodeExecution, NodeStatus,
    PendingApproval, RetryBackoff, RetrySafety, RuntimeMetadata, ValueType, Workflow, WorkflowItem,
    WorkflowNode,
};
use async_trait::async_trait;
use chrono::Utc;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    process::Command,
    sync::{broadcast, Mutex},
    task::{JoinHandle, JoinSet},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EngineEvent {
    ExecutionUpdated {
        record: ExecutionRecord,
    },
    NodeStarted {
        execution_id: String,
        node_id: String,
    },
}

#[derive(Debug, Clone)]
pub struct PluginHostResult {
    pub output: Value,
    pub diagnostics: Vec<String>,
}

#[async_trait]
pub trait HostServices: Send + Sync {
    async fn desktop_notification(&self, title: &str, message: &str) -> Result<(), EngineError>;
    async fn browser_operation(
        &self,
        _operation: &str,
        _payload: Value,
    ) -> Result<Value, EngineError> {
        Err(EngineError::Node(
            "The managed browser engine is unavailable on this host.".into(),
        ))
    }
    async fn integration_operation(
        &self,
        _operation: &str,
        _payload: Value,
    ) -> Result<Value, EngineError> {
        Err(EngineError::Node(
            "The requested integration is unavailable on this host.".into(),
        ))
    }
    async fn ai_operation(&self, _payload: Value) -> Result<Value, EngineError> {
        Err(EngineError::Node(
            "AI connections are unavailable on this host.".into(),
        ))
    }
    async fn open_local_url(&self, _url: &str) -> Result<(), EngineError> {
        Ok(())
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
            "The sandboxed plugin runtime is unavailable on this host.".into(),
        ))
    }
    async fn approval_requested(&self, _approval: &PendingApproval) -> Result<(), EngineError> {
        Ok(())
    }
}

pub struct LocalHost;
#[async_trait]
impl HostServices for LocalHost {
    async fn desktop_notification(&self, _title: &str, _message: &str) -> Result<(), EngineError> {
        Ok(())
    }
}

#[derive(Clone)]
pub struct Engine {
    db: Database,
    host: Arc<dyn HostServices>,
    active: Arc<Mutex<HashSet<String>>>,
    events: broadcast::Sender<EngineEvent>,
    local_sites: Arc<Mutex<HashMap<String, JoinHandle<()>>>>,
}

impl Engine {
    pub fn new(db: Database, host: Arc<dyn HostServices>) -> Self {
        let (events, _) = broadcast::channel(128);
        Self {
            db,
            host,
            active: Arc::new(Mutex::new(HashSet::new())),
            events,
            local_sites: Arc::new(Mutex::new(HashMap::new())),
        }
    }
    pub fn subscribe(&self) -> broadcast::Receiver<EngineEvent> {
        self.events.subscribe()
    }
    pub fn database(&self) -> &Database {
        &self.db
    }

    pub async fn run(
        &self,
        workflow: Workflow,
        trigger: Value,
        cancellation: CancellationToken,
    ) -> Result<ExecutionRecord, EngineError> {
        self.db.verify_workflow_plugin_pins(&workflow)?;
        {
            let mut active = self.active.lock().await;
            if !active.insert(workflow.id.clone()) {
                let now = Utc::now();
                let record = ExecutionRecord {
                    id: Uuid::new_v4().to_string(),
                    workflow_id: workflow.id.clone(),
                    workflow_version: workflow.schema_version,
                    trigger,
                    status: ExecutionStatus::Skipped,
                    started_at: now,
                    completed_at: Some(now),
                    duration_ms: Some(0),
                    node_executions: vec![],
                    error: None,
                    skip_reason: Some("Previous execution is still running.".into()),
                    recovered_after_crash: false,
                };
                self.db.save_execution(&record)?;
                let _ = self.events.send(EngineEvent::ExecutionUpdated {
                    record: record.clone(),
                });
                return Ok(record);
            }
        }
        let result = self.run_inner(&workflow, trigger, cancellation).await;
        self.active.lock().await.remove(&workflow.id);
        result
    }

    async fn run_inner(
        &self,
        workflow: &Workflow,
        trigger: Value,
        cancellation: CancellationToken,
    ) -> Result<ExecutionRecord, EngineError> {
        let issues = validate(workflow);
        let errors = issues
            .into_iter()
            .filter(|issue| issue.severity == ValidationSeverity::Error)
            .collect::<Vec<_>>();
        if !errors.is_empty() {
            return Err(EngineError::Validation(
                errors
                    .into_iter()
                    .map(|i| i.message)
                    .collect::<Vec<_>>()
                    .join(" "),
            ));
        }
        for node in workflow.nodes.iter().filter(|node| node.node_type == "custom_function" && !node.disabled) {
            let customization = node.customization.as_ref().ok_or_else(|| EngineError::Validation(format!("{} has no custom contract.", node.name)))?;
            let fingerprint = custom_node_fingerprint(customization);
            let verified = self.db.custom_node_verification(&workflow.id, &node.id)?
                .is_some_and(|receipt| receipt.fingerprint == fingerprint
                    && customization.outputs.iter().filter(|port| port.required).all(|port| receipt.output_coverage.contains(&port.key))
                    && customization.branches.iter().all(|port| receipt.branch_coverage.contains(&port.key)));
            if !verified {
                return Err(EngineError::Validation(format!("{} is an unverified ƒx node. Run and save all fixtures after the latest code or contract change.", node.name)));
            }
        }
        let order = topological_order(workflow)?;
        let started = Utc::now();
        let mut record = ExecutionRecord {
            id: Uuid::new_v4().to_string(),
            workflow_id: workflow.id.clone(),
            workflow_version: workflow.schema_version,
            trigger: redact_value(&trigger),
            status: ExecutionStatus::Running,
            started_at: started,
            completed_at: None,
            duration_ms: None,
            node_executions: workflow
                .nodes
                .iter()
                .map(|node| NodeExecution {
                    node_id: node.id.clone(),
                    status: NodeStatus::Waiting,
                    started_at: None,
                    completed_at: None,
                    duration_ms: None,
                    input: Value::Null,
                    output: Value::Null,
                    logs: vec![],
                    retry_count: 0,
                    error: None,
                    skip_reason: None,
                    branch_followed: None,
                    browser_diagnostics: None,
                    input_items: vec![],
                    output_items: vec![],
                    warnings: vec![],
                    lineage: vec![],
                    runtime: None,
                    test_data_source: None,
                    capability_usage: vec![],
                    collection: (node.node_type == "merge").then(|| CollectionEvidence {
                        waiting_for_inputs: node
                            .configuration
                            .get("inputPorts")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .filter_map(|port| {
                                port.get("name")
                                    .or_else(|| port.get("id"))
                                    .and_then(Value::as_str)
                                    .map(str::to_string)
                            })
                            .collect(),
                        ordering_policy: "configured_input_port_order".into(),
                        ..Default::default()
                    }),
                })
                .collect(),
            error: None,
            skip_reason: None,
            recovered_after_crash: false,
        };
        self.publish(&record)?;
        let mut outputs: HashMap<String, Value> = HashMap::new();
        let mut pending_state: HashMap<String, Value> = HashMap::new();
        let mut active_edges: HashMap<String, bool> = workflow
            .edges
            .iter()
            .map(|edge| {
                let routed = edge.source_handle == "error" || workflow
                    .nodes
                    .iter()
                    .find(|n| n.id == edge.source_node_id)
                    .is_some_and(|n| {
                        matches!(
                            n.node_type.as_str(),
                            "condition"
                                | "filter"
                                | "switch"
                                | "split_out"
                                | "loop_over_items"
                                | "remove_duplicates"
                        )
                    });
                (edge.id.clone(), !routed)
            })
            .collect();

        for node_id in order {
            let node = workflow
                .nodes
                .iter()
                .find(|node| node.id == node_id)
                .unwrap();
            let idx = record
                .node_executions
                .iter()
                .position(|execution| execution.node_id == node.id)
                .unwrap();
            // Loop body nodes are executed by their owning Loop Over Items
            // node. Their aggregate execution record is already terminal.
            if record.node_executions[idx].status != NodeStatus::Waiting {
                continue;
            }
            if cancellation.is_cancelled() {
                mark_node(
                    &mut record.node_executions[idx],
                    NodeStatus::Cancelled,
                    "Execution was cancelled.",
                );
                continue;
            }
            if node.node_type == "note" {
                mark_node(
                    &mut record.node_executions[idx],
                    NodeStatus::Skipped,
                    "Canvas note; not executed.",
                );
                continue;
            }
            if node.disabled {
                mark_node(
                    &mut record.node_executions[idx],
                    NodeStatus::Skipped,
                    "Node is disabled.",
                );
                continue;
            }
            let incoming: Vec<_> = workflow
                .edges
                .iter()
                .filter(|edge| edge.target_node_id == node.id)
                .collect();
            let active_incoming: Vec<_> = incoming
                .iter()
                .filter(|edge| *active_edges.get(&edge.id).unwrap_or(&false))
                .collect();
            if node.id != workflow.trigger_node_id && active_incoming.is_empty() {
                let branches = incoming
                    .iter()
                    .filter_map(|edge| {
                        workflow
                            .nodes
                            .iter()
                            .find(|source| source.id == edge.source_node_id)
                            .filter(|source| {
                                matches!(
                                    source.node_type.as_str(),
                                    "condition"
                                        | "filter"
                                        | "switch"
                                        | "split_out"
                                        | "loop_over_items"
                                        | "remove_duplicates"
                                )
                            })
                            .map(|source| format!("{}:{}", source.name, edge.source_handle))
                    })
                    .collect::<Vec<_>>();
                let reason = if branches.is_empty() {
                    "The node was not reached because its branch was not followed.".into()
                } else {
                    format!(
                        "The node was skipped because no item followed {}.",
                        branches.join(", ")
                    )
                };
                mark_node(
                    &mut record.node_executions[idx],
                    NodeStatus::Skipped,
                    &reason,
                );
                continue;
            }
            let failed_dependency = active_incoming.iter().find_map(|edge| {
                record
                    .node_executions
                    .iter()
                    .find(|execution| execution.node_id == edge.source_node_id)
                    .filter(|execution| !matches!(execution.status, NodeStatus::Successful | NodeStatus::Handled))
                    .map(|execution| (edge.source_node_id.as_str(), execution.status))
            });
            if let Some((dependency, status)) = failed_dependency {
                let merge_policy = if node.node_type == "merge" {
                    let key = if matches!(status, NodeStatus::Skipped) {
                        "skippedInputPolicy"
                    } else {
                        "failedInputPolicy"
                    };
                    node.configuration
                        .get(key)
                        .and_then(Value::as_str)
                        .unwrap_or("fail")
                } else {
                    "fail"
                };
                if node.node_type != "merge" || merge_policy == "fail" {
                    let message =
                        format!("Dependency '{dependency}' finished with status {status:?}.");
                    if node.node_type == "merge" {
                        record.node_executions[idx].status = NodeStatus::Failed;
                        record.node_executions[idx].completed_at = Some(Utc::now());
                        record.node_executions[idx].error = Some(ExecutionError {
                            code: "collection_merge_input_failed".into(),
                            message,
                            detail: Some("Merge is configured to fail when an input branch does not succeed.".into()),
                            suggestion: Some("Handle the branch failure or set the matching Merge input policy to treat it as empty.".into()),
                            line: None,
                            column: None,
                        });
                    } else {
                        mark_node(
                            &mut record.node_executions[idx],
                            NodeStatus::Skipped,
                            &message,
                        );
                    }
                    continue;
                }
                record.node_executions[idx].logs.push(format!(
                    "Merge treated input from '{dependency}' ({status:?}) as empty according to {merge_policy}."
                ));
            }
            let dependencies: Map<String, Value> = active_incoming
                .iter()
                .filter_map(|edge| {
                    outputs
                        .get(&edge.source_node_id)
                        .map(|value| (edge.source_node_id.clone(), value.clone()))
                })
                .collect();
            record.node_executions[idx].input = redact_value(&bounded_history_value(
                &json!({"dependencies": dependencies, "trigger": trigger}),
                workflow
                    .settings
                    .collection_limits
                    .max_history_item_previews,
            ));
            record.node_executions[idx].input_items =
                canonical_input_items(workflow, node, &outputs)
                    .into_iter()
                    .take(
                        workflow
                            .settings
                            .collection_limits
                            .max_history_item_previews,
                    )
                    .collect();
            record.node_executions[idx].status = NodeStatus::Running;
            record.node_executions[idx].started_at = Some(Utc::now());
            let _ = self.events.send(EngineEvent::NodeStarted {
                execution_id: record.id.clone(),
                node_id: node.id.clone(),
            });
            self.publish(&record)?;
            let instant = Instant::now();
            let timeout_ms = if node.node_type == "approval" {
                node.configuration
                    .get("expiresInMinutes")
                    .and_then(Value::as_u64)
                    .unwrap_or(60)
                    .clamp(1, 10_080)
                    .saturating_mul(60_000)
                    .saturating_add(5_000)
            } else {
                node.configuration
                    .get("timeoutMs")
                    .and_then(Value::as_u64)
                    .unwrap_or(workflow.settings.default_node_timeout_ms)
                    .clamp(100, 600_000)
            };
            let policy = node.error_policy.clone().unwrap_or_default();
            let retry_allowed = contract_for(&node.node_type).is_some_and(|contract| {
                contract.effect_level != EffectLevel::Destructive && contract.retry_safety == RetrySafety::Safe
            });
            let mut retries_performed = 0u32;
            let execution = loop {
                let attempt = tokio::select! {
                    _ = cancellation.cancelled() => Err(EngineError::Cancelled),
                    result = tokio::time::timeout(Duration::from_millis(timeout_ms), self.execute_node(node, workflow, &record.id, &trigger, &outputs, &pending_state, cancellation.clone())) => {
                        match result { Ok(value) => value, Err(_) => Err(EngineError::Node(format!("{} exceeded its {}-second timeout.", node.name, timeout_ms as f64 / 1000.0))) }
                    }
                };
                match attempt {
                    Ok(mut result) => { result.retry_count = result.retry_count.saturating_add(retries_performed); break Ok(result); }
                    Err(error) if !matches!(error, EngineError::Cancelled) && retry_allowed && retries_performed < policy.max_retries as u32 => {
                        retries_performed += 1;
                        record.node_executions[idx].retry_count = retries_performed;
                        record.node_executions[idx].logs.push(format!("Attempt {} failed; retry {} of {} scheduled.", retries_performed, retries_performed, policy.max_retries));
                        self.publish(&record)?;
                        let multiplier = if policy.backoff == RetryBackoff::Exponential { 1u64.checked_shl(retries_performed.saturating_sub(1)).unwrap_or(u64::MAX) } else { 1 };
                        let delay_ms = policy.retry_delay_ms.saturating_mul(multiplier).min(120_000);
                        tokio::select! {
                            _ = cancellation.cancelled() => break Err(EngineError::Cancelled),
                            _ = tokio::time::sleep(Duration::from_millis(delay_ms)) => {}
                        }
                    }
                    Err(error) => break Err(error),
                }
            };
            let (execution, loop_summaries) = match execution {
                Ok(result) if node.node_type == "loop_over_items" => {
                    match self
                        .run_loop_body(
                            workflow,
                            node,
                            &record.id,
                            &trigger,
                            &outputs,
                            &pending_state,
                            result,
                            cancellation.clone(),
                        )
                        .await
                    {
                        Ok(outcome) => (Ok(outcome.result), outcome.summaries),
                        Err((error, summaries)) => (Err(error), summaries),
                    }
                }
                other => (other, vec![]),
            };
            for summary in loop_summaries {
                if let Some(target) = record
                    .node_executions
                    .iter_mut()
                    .find(|entry| entry.node_id == summary.node_id)
                {
                    *target = summary;
                }
            }
            let completed = Utc::now();
            let node_record = &mut record.node_executions[idx];
            node_record.completed_at = Some(completed);
            node_record.duration_ms = Some(instant.elapsed().as_millis() as u64);
            match execution {
                Ok(result) => {
                    node_record.status = NodeStatus::Successful;
                    node_record.output = redact_value(&bounded_history_value(
                        &result.output,
                        workflow
                            .settings
                            .collection_limits
                            .max_history_item_previews,
                    ));
                    node_record.logs = result.logs.into_iter().map(bounded_log).take(100).collect();
                    node_record.retry_count = result.retry_count;
                    node_record.browser_diagnostics = result.browser_diagnostics;
                    let authoritative_output_count = result
                        .collection
                        .as_ref()
                        .map(|e| e.output_item_count)
                        .unwrap_or(result.output_items.len());
                    let history_limit = workflow
                        .settings
                        .collection_limits
                        .max_history_item_previews;
                    node_record.output_items = result
                        .output_items
                        .iter()
                        .take(history_limit)
                        .cloned()
                        .collect();
                    node_record.warnings = result.warnings;
                    node_record.lineage = result.lineage;
                    node_record.runtime = result.runtime;
                    node_record.capability_usage = result.capability_usage;
                    node_record.collection = result.collection;
                    if authoritative_output_count > node_record.output_items.len() {
                        node_record.warnings.push(format!("Execution history shows {} of {authoritative_output_count} output items; runtime data was not truncated.", node_record.output_items.len()));
                    }
                    if let Some(branch) = result.branch {
                        node_record.branch_followed = Some(branch.clone());
                        for edge in workflow
                            .edges
                            .iter()
                            .filter(|edge| edge.source_node_id == node.id)
                        {
                            active_edges.insert(edge.id.clone(), edge.source_handle == branch);
                        }
                    }
                    if !result.branch_outputs.is_empty() {
                        for edge in workflow
                            .edges
                            .iter()
                            .filter(|edge| edge.source_node_id == node.id)
                        {
                            let branch_items = result.branch_outputs.get(&edge.source_handle);
                            let target_is_merge = workflow
                                .nodes
                                .iter()
                                .find(|candidate| candidate.id == edge.target_node_id)
                                .is_some_and(|candidate| candidate.node_type == "merge");
                            active_edges.insert(
                                edge.id.clone(),
                                branch_items
                                    .is_some_and(|items| !items.is_empty() || target_is_merge),
                            );
                        }
                    }
                    for (key, value) in result.state_updates {
                        pending_state.insert(key, value);
                    }
                    outputs.insert(node.id.clone(), result.output);
                }
                Err(error) => {
                    let execution_error = error.execution_error();
                    node_record.error = Some(execution_error.clone());
                    node_record.retry_count = retries_performed;
                    if let EngineError::Browser { diagnostics, .. } = &error {
                        node_record.browser_diagnostics = diagnostics.clone();
                    }
                    node_record.logs.push(bounded_log(error.to_string()));
                    if matches!(error, EngineError::Cancelled) {
                        node_record.status = NodeStatus::Cancelled;
                    } else {
                        match policy.strategy {
                            ErrorStrategy::Fail => node_record.status = NodeStatus::Failed,
                            ErrorStrategy::Route => {
                                node_record.status = NodeStatus::Handled;
                                let envelope = json!({"error":{"code":execution_error.code,"message":execution_error.message,"detail":execution_error.detail,"suggestion":execution_error.suggestion,"nodeId":node.id,"nodeType":node.node_type,"attempts":retries_performed + 1}});
                                node_record.output = redact_value(&envelope);
                                node_record.output_items = vec![WorkflowItem::json(envelope.clone())];
                                node_record.branch_followed = Some("error".into());
                                for edge in workflow.edges.iter().filter(|edge| edge.source_node_id == node.id) {
                                    active_edges.insert(edge.id.clone(), edge.source_handle == "error");
                                }
                                outputs.insert(node.id.clone(), envelope);
                                node_record.logs.push("Failure routed through the reserved error branch.".into());
                            }
                            ErrorStrategy::Fallback => {
                                node_record.status = NodeStatus::Handled;
                                let fallback = policy.fallback_outputs.clone();
                                node_record.output = redact_value(&fallback);
                                node_record.output_items = vec![WorkflowItem::json(fallback.clone())];
                                outputs.insert(node.id.clone(), fallback);
                                node_record.logs.push("Failure recovered with validated fallback outputs.".into());
                            }
                        }
                    }
                }
            }
            if let Some(diagnostics) = node_record.browser_diagnostics.clone() {
                if let Err(error) = self.db.save_browser_diagnostic(
                    &record.id,
                    &node.id,
                    &diagnostics,
                    Utc::now() + chrono::Duration::days(7),
                ) {
                    node_record.logs.push(bounded_log(format!(
                        "Browser diagnostics could not be indexed for retention: {error}"
                    )));
                }
            }
            self.publish(&record)?;
        }
        let sessions_to_close: HashSet<String> = outputs
            .values()
            .filter(|output| {
                output
                    .get("closeAutomatically")
                    .and_then(Value::as_bool)
                    .unwrap_or(true)
            })
            .filter_map(|output| {
                output
                    .get("browserSession")?
                    .get("sessionId")?
                    .as_str()
                    .map(str::to_string)
            })
            .collect();
        for session_id in sessions_to_close {
            let _ = self
                .host
                .browser_operation("close_browser", json!({"sessionId":session_id}))
                .await;
        }
        let completed = Utc::now();
        record.completed_at = Some(completed);
        record.duration_ms = Some((completed - started).num_milliseconds().max(0) as u64);
        record.status = if cancellation.is_cancelled()
            || record
                .node_executions
                .iter()
                .any(|n| n.status == NodeStatus::Cancelled)
        {
            ExecutionStatus::Cancelled
        } else if record
            .node_executions
            .iter()
            .any(|n| n.status == NodeStatus::Failed)
        {
            ExecutionStatus::Failed
        } else if record
            .node_executions
            .iter()
            .any(|n| n.status == NodeStatus::Handled)
        {
            ExecutionStatus::SuccessfulWithWarnings
        } else {
            ExecutionStatus::Successful
        };
        record.error = record
            .node_executions
            .iter()
            .find_map(|node| node.error.clone());
        if matches!(record.status, ExecutionStatus::Successful | ExecutionStatus::SuccessfulWithWarnings) && !pending_state.is_empty() {
            self.db.set_workflow_states(&workflow.id, &pending_state)?;
        }
        self.publish(&record)?;
        Ok(record)
    }

    pub async fn retry_failed_node(
        &self,
        execution_id: &str,
        node_id: &str,
        cancellation: CancellationToken,
    ) -> Result<ExecutionRecord, EngineError> {
        let previous = self
            .db
            .get_execution(execution_id)?
            .ok_or_else(|| EngineError::Node("Execution no longer exists.".into()))?;
        let workflow = self
            .db
            .get_workflow(&previous.workflow_id)?
            .ok_or_else(|| EngineError::Node("Workflow no longer exists.".into()))?;
        {
            let mut active = self.active.lock().await;
            if !active.insert(workflow.id.clone()) {
                return Err(EngineError::Node(
                    "This workflow already has an active execution.".into(),
                ));
            }
        }
        let result = self
            .retry_failed_node_inner(&workflow, &previous, node_id, cancellation)
            .await;
        self.active.lock().await.remove(&workflow.id);
        result
    }

    async fn retry_failed_node_inner(
        &self,
        workflow: &Workflow,
        previous: &ExecutionRecord,
        node_id: &str,
        cancellation: CancellationToken,
    ) -> Result<ExecutionRecord, EngineError> {
        let node = workflow
            .nodes
            .iter()
            .find(|node| node.id == node_id)
            .ok_or_else(|| EngineError::Node("The failed node no longer exists.".into()))?;
        let previous_node = previous
            .node_executions
            .iter()
            .find(|execution| execution.node_id == node_id)
            .ok_or_else(|| EngineError::Node("The node was not part of this execution.".into()))?;
        if previous_node.status != NodeStatus::Failed {
            return Err(EngineError::Node(
                "Only a failed node can be retried independently.".into(),
            ));
        }

        let outputs: HashMap<String, Value> = previous
            .node_executions
            .iter()
            .filter(|execution| execution.status == NodeStatus::Successful)
            .map(|execution| (execution.node_id.clone(), execution.output.clone()))
            .collect();
        let dependencies: Map<String, Value> = workflow
            .edges
            .iter()
            .filter(|edge| edge.target_node_id == node_id)
            .filter_map(|edge| {
                outputs
                    .get(&edge.source_node_id)
                    .map(|value| (edge.source_node_id.clone(), value.clone()))
            })
            .collect();
        let required_dependencies = workflow
            .edges
            .iter()
            .filter(|edge| edge.target_node_id == node_id)
            .count();
        if node_id != workflow.trigger_node_id && dependencies.len() != required_dependencies {
            return Err(EngineError::Node(
                "The failed node cannot be retried because an upstream dependency did not complete successfully. Retry the entire workflow instead.".into(),
            ));
        }

        let started = Utc::now();
        let input = redact_value(
            &json!({"dependencies": dependencies, "trigger": previous.trigger.clone()}),
        );
        let mut record = ExecutionRecord {
            id: Uuid::new_v4().to_string(),
            workflow_id: workflow.id.clone(),
            workflow_version: workflow.schema_version,
            trigger: previous.trigger.clone(),
            status: ExecutionStatus::Running,
            started_at: started,
            completed_at: None,
            duration_ms: None,
            node_executions: vec![NodeExecution {
                node_id: node.id.clone(),
                status: NodeStatus::Running,
                started_at: Some(started),
                completed_at: None,
                duration_ms: None,
                input,
                output: Value::Null,
                logs: vec![bounded_log(format!(
                    "Retrying failed node from execution {}.",
                    previous.id
                ))],
                retry_count: previous_node.retry_count.saturating_add(1),
                error: None,
                skip_reason: None,
                branch_followed: None,
                browser_diagnostics: None,
                input_items: canonical_input_items(workflow, node, &outputs),
                output_items: vec![],
                warnings: vec![],
                lineage: binding_lineage(node),
                runtime: None,
                test_data_source: Some(format!("execution:{}", previous.id)),
                capability_usage: vec![],
                collection: None,
            }],
            error: None,
            skip_reason: None,
            recovered_after_crash: false,
        };
        self.publish(&record)?;
        let _ = self.events.send(EngineEvent::NodeStarted {
            execution_id: record.id.clone(),
            node_id: node.id.clone(),
        });

        let instant = Instant::now();
        let timeout_ms = node
            .configuration
            .get("timeoutMs")
            .and_then(Value::as_u64)
            .unwrap_or(workflow.settings.default_node_timeout_ms)
            .clamp(100, 600_000);
        let retry_state = HashMap::new();
        let execution = tokio::select! {
            _ = cancellation.cancelled() => Err(EngineError::Cancelled),
            result = tokio::time::timeout(
                Duration::from_millis(timeout_ms),
                self.execute_node(node, workflow, &record.id, &previous.trigger, &outputs, &retry_state, cancellation.clone())
            ) => match result {
                Ok(value) => value,
                Err(_) => Err(EngineError::Node(format!(
                    "{} exceeded its {}-second timeout.",
                    node.name,
                    timeout_ms as f64 / 1000.0
                ))),
            }
        };
        let completed = Utc::now();
        let node_record = &mut record.node_executions[0];
        node_record.completed_at = Some(completed);
        node_record.duration_ms = Some(instant.elapsed().as_millis() as u64);
        match execution {
            Ok(result) => {
                node_record.status = NodeStatus::Successful;
                node_record.output = redact_value(&bounded_history_value(
                    &result.output,
                    workflow
                        .settings
                        .collection_limits
                        .max_history_item_previews,
                ));
                node_record
                    .logs
                    .extend(result.logs.into_iter().map(bounded_log).take(99));
                node_record.branch_followed = result.branch;
                node_record.browser_diagnostics = result.browser_diagnostics;
                node_record.output_items = result
                    .output_items
                    .iter()
                    .take(
                        workflow
                            .settings
                            .collection_limits
                            .max_history_item_previews,
                    )
                    .cloned()
                    .collect();
                node_record.warnings = result.warnings;
                node_record.lineage.extend(result.lineage);
                node_record.runtime = result.runtime;
                node_record.capability_usage = result.capability_usage;
                node_record.collection = result.collection;
                if !result.state_updates.is_empty() {
                    self.db.set_workflow_states(
                        &workflow.id,
                        &result.state_updates.into_iter().collect(),
                    )?;
                }
                record.status = ExecutionStatus::Successful;
            }
            Err(error) => {
                node_record.status = if matches!(error, EngineError::Cancelled) {
                    NodeStatus::Cancelled
                } else {
                    NodeStatus::Failed
                };
                node_record.error = Some(error.execution_error());
                if let EngineError::Browser { diagnostics, .. } = &error {
                    node_record.browser_diagnostics = diagnostics.clone();
                }
                node_record.logs.push(bounded_log(error.to_string()));
                record.status = if matches!(error, EngineError::Cancelled) {
                    ExecutionStatus::Cancelled
                } else {
                    ExecutionStatus::Failed
                };
                record.error = node_record.error.clone();
            }
        }
        if let Some(diagnostics) = node_record.browser_diagnostics.clone() {
            if let Err(error) = self.db.save_browser_diagnostic(
                &record.id,
                &node.id,
                &diagnostics,
                Utc::now() + chrono::Duration::days(7),
            ) {
                node_record.logs.push(bounded_log(format!(
                    "Browser diagnostics could not be indexed for retention: {error}"
                )));
            }
        }
        record.completed_at = Some(completed);
        record.duration_ms = Some((completed - started).num_milliseconds().max(0) as u64);
        self.publish(&record)?;
        Ok(record)
    }

    pub async fn test_node(
        &self,
        workflow: Workflow,
        node_id: &str,
        input_overrides: Value,
        previous_execution_id: Option<&str>,
        allow_side_effects: bool,
        cancellation: CancellationToken,
    ) -> Result<ExecutionRecord, EngineError> {
        self.db.verify_workflow_plugin_pins(&workflow)?;
        let mut node = workflow
            .nodes
            .iter()
            .find(|node| node.id == node_id)
            .cloned()
            .ok_or_else(|| EngineError::Node("The selected node no longer exists.".into()))?;
        let loop_body_side_effect = node.node_type == "loop_over_items"
            && loop_body_order(&workflow, &node.id)
                .iter()
                .filter_map(|id| workflow.nodes.iter().find(|candidate| candidate.id == *id))
                .any(|candidate| node_has_side_effect(&candidate.node_type));
        if (node_has_side_effect(&node.node_type) || loop_body_side_effect) && !allow_side_effects {
            return Err(EngineError::Permission(
                "Testing this node can change external state. Confirm side effects before running the test.".into(),
            ));
        }
        let overrides = input_overrides.as_object().ok_or_else(|| {
            EngineError::Validation("Node test input overrides must be a JSON object.".into())
        })?;
        let configuration = node.configuration.as_object_mut().ok_or_else(|| {
            EngineError::Validation("Node configuration must be a JSON object.".into())
        })?;
        for (key, value) in overrides {
            configuration.insert(key.clone(), value.clone());
        }

        let previous = previous_execution_id
            .map(|id| self.db.get_execution(id))
            .transpose()?
            .flatten();
        if previous.is_none() {
            if let Some(pinned) = node
                .configuration
                .get("pinnedData")
                .cloned()
                .filter(|value| !value.is_null())
            {
                if let Some(configuration) = node.configuration.as_object_mut() {
                    if node.node_type == "merge" && pinned.is_object() {
                        configuration.insert("namedTestInputs".into(), pinned);
                    } else {
                        configuration
                            .insert("input".into(), json!({"items": fixture_items(&pinned)}));
                    }
                }
            }
        }
        if previous
            .as_ref()
            .is_some_and(|record| record.workflow_id != workflow.id)
        {
            return Err(EngineError::Validation(
                "The selected execution snapshot belongs to another workflow.".into(),
            ));
        }
        let mut outputs: HashMap<String, Value> = previous
            .as_ref()
            .map(|record| {
                record
                    .node_executions
                    .iter()
                    .filter(|execution| execution.status == NodeStatus::Successful)
                    .map(|execution| (execution.node_id.clone(), execution.output.clone()))
                    .collect()
            })
            .unwrap_or_default();
        if previous.is_none() {
            for candidate in &workflow.nodes {
                if let Some(pinned) = candidate.configuration.get("pinnedData") {
                    outputs.insert(
                        candidate.id.clone(),
                        json!({"items": fixture_items(pinned)}),
                    );
                }
            }
        }
        let trigger = previous
            .as_ref()
            .map(|record| record.trigger.clone())
            .unwrap_or_else(|| json!({"type":"node_test"}));
        let started = Utc::now();
        let mut record = ExecutionRecord {
            id: Uuid::new_v4().to_string(),
            workflow_id: workflow.id.clone(),
            workflow_version: workflow.schema_version,
            trigger: trigger.clone(),
            status: ExecutionStatus::Running,
            started_at: started,
            completed_at: None,
            duration_ms: None,
            node_executions: vec![NodeExecution {
                node_id: node.id.clone(),
                status: NodeStatus::Running,
                started_at: Some(started),
                completed_at: None,
                duration_ms: None,
                input: redact_value(
                    &json!({"snapshotExecutionId":previous_execution_id,"overrides":overrides}),
                ),
                output: Value::Null,
                logs: vec![
                    "Testing only this node; upstream and downstream nodes will not run.".into(),
                ],
                retry_count: 0,
                error: None,
                skip_reason: None,
                branch_followed: None,
                browser_diagnostics: None,
                input_items: canonical_input_items(&workflow, &node, &outputs),
                output_items: vec![],
                warnings: vec![],
                lineage: binding_lineage(&node),
                runtime: None,
                test_data_source: previous_execution_id
                    .map(|id| format!("execution:{id}"))
                    .or_else(|| (!outputs.is_empty()).then_some("pinned_data".into())),
                capability_usage: vec![],
                collection: None,
            }],
            error: None,
            skip_reason: None,
            recovered_after_crash: false,
        };
        self.publish(&record)?;
        let instant = Instant::now();
        let pending_state = HashMap::new();
        let result = self
            .execute_node(
                &node,
                &workflow,
                &record.id,
                &trigger,
                &outputs,
                &pending_state,
                cancellation.clone(),
            )
            .await;
        let mut test_summaries = Vec::new();
        let result = if node.node_type == "loop_over_items" {
            match result {
                Ok(prepared) => match self
                    .run_loop_body(
                        &workflow,
                        &node,
                        &record.id,
                        &trigger,
                        &outputs,
                        &pending_state,
                        prepared,
                        cancellation.clone(),
                    )
                    .await
                {
                    Ok(outcome) => {
                        test_summaries = outcome.summaries;
                        Ok(outcome.result)
                    }
                    Err((error, summaries)) => {
                        test_summaries = summaries;
                        Err(error)
                    }
                },
                failure => failure,
            }
        } else {
            result
        };
        let completed = Utc::now();
        let node_record = &mut record.node_executions[0];
        node_record.completed_at = Some(completed);
        node_record.duration_ms = Some(instant.elapsed().as_millis() as u64);
        match result {
            Ok(result) => {
                node_record.status = NodeStatus::Successful;
                node_record.output = redact_value(&bounded_history_value(
                    &result.output,
                    workflow
                        .settings
                        .collection_limits
                        .max_history_item_previews,
                ));
                node_record
                    .logs
                    .extend(result.logs.into_iter().map(bounded_log));
                node_record.branch_followed = result.branch;
                node_record.browser_diagnostics = result.browser_diagnostics;
                node_record.output_items = result
                    .output_items
                    .into_iter()
                    .take(
                        workflow
                            .settings
                            .collection_limits
                            .max_history_item_previews,
                    )
                    .collect();
                node_record.warnings = result.warnings;
                node_record.lineage.extend(result.lineage);
                node_record.runtime = result.runtime;
                node_record.capability_usage = result.capability_usage;
                node_record.collection = result.collection;
                if !result.state_updates.is_empty() {
                    node_record.logs.push(
                        "Workflow state changes were previewed but not committed by this node test."
                            .into(),
                    );
                }
                record.status = ExecutionStatus::Successful;
            }
            Err(error) => {
                node_record.status = if matches!(error, EngineError::Cancelled) {
                    NodeStatus::Cancelled
                } else {
                    NodeStatus::Failed
                };
                node_record.error = Some(error.execution_error());
                node_record.logs.push(bounded_log(error.to_string()));
                record.error = node_record.error.clone();
                record.status = if matches!(error, EngineError::Cancelled) {
                    ExecutionStatus::Cancelled
                } else {
                    ExecutionStatus::Failed
                };
            }
        }
        record.completed_at = Some(completed);
        record.duration_ms = Some((completed - started).num_milliseconds().max(0) as u64);
        record.node_executions.extend(test_summaries);
        self.publish(&record)?;
        Ok(record)
    }

    fn publish(&self, record: &ExecutionRecord) -> Result<(), EngineError> {
        self.db.save_execution(record)?;
        let _ = self.events.send(EngineEvent::ExecutionUpdated {
            record: record.clone(),
        });
        Ok(())
    }

    async fn execute_node(
        &self,
        node: &WorkflowNode,
        workflow: &Workflow,
        execution_id: &str,
        trigger: &Value,
        outputs: &HashMap<String, Value>,
        pending_state: &HashMap<String, Value>,
        cancellation: CancellationToken,
    ) -> Result<NodeResult, EngineError> {
        let mut resolved_node = resolve_node_bindings(node, trigger, outputs)?;
        let input_items = canonical_input_items(workflow, &resolved_node, outputs);
        let input = input_items
            .first()
            .map(|item| item.data.clone())
            .unwrap_or(Value::Null);
        let item_values = input_items
            .iter()
            .map(|item| item.data.clone())
            .collect::<Vec<_>>();
        let workflow_meta = json!({"id":workflow.id,"name":workflow.name,"description":workflow.description,"schemaVersion":workflow.schema_version});
        let execution_meta = json!({"id":execution_id,"startedAt":Utc::now(),"attempt":1});
        let mut environment = Map::new();
        for name in &workflow.settings.permissions.approved_environment_variables {
            if let Ok(value) = std::env::var(name) {
                environment.insert(name.clone(), Value::String(value));
            }
        }
        let context = ExpressionContext {
            input: &input,
            items: &item_values,
            trigger,
            outputs,
            workflow: &workflow_meta,
            execution: &execution_meta,
            environment: &environment,
        };
        resolved_node.configuration =
            resolve_configuration_expressions(&resolved_node.configuration, &context)?;
        if resolved_node.node_type == "custom_function" {
            let customization = resolved_node.customization.as_ref().ok_or_else(|| EngineError::Validation("Custom function contract is missing.".into()))?;
            let custom_configuration = resolved_node.configuration.clone();
            resolved_node.configuration = json!({
                "language": customization.language,
                "sourceCode": customization.source_code,
                "executionMode": "run",
                "itemMode": "all_items",
                "runtimeVersion": customization.runtime_requirement,
                "helperLanguageVersion": EXPRESSION_LANGUAGE_VERSION,
                "dependencies": [],
                "timeoutMs": 30_000,
                "customConfiguration": custom_configuration
            });
        }
        if resolved_node.node_type == "merge" {
            let mut successful = workflow
                .edges
                .iter()
                .filter(|edge| {
                    edge.target_node_id == resolved_node.id
                        && outputs.contains_key(&edge.source_node_id)
                })
                .map(|edge| {
                    edge.target_port
                        .as_deref()
                        .unwrap_or(&edge.target_handle)
                        .to_string()
                })
                .collect::<Vec<_>>();
            successful.extend(
                resolved_node
                    .configuration
                    .get("namedTestInputs")
                    .and_then(Value::as_object)
                    .into_iter()
                    .flat_map(|inputs| inputs.keys().cloned()),
            );
            successful.sort();
            successful.dedup();
            if let Some(configuration) = resolved_node.configuration.as_object_mut() {
                configuration.insert("successfulInputPorts".into(), json!(successful));
            }
        }
        let node = &resolved_node;
        match node.node_type.as_str() {
            "manual_trigger"
            | "schedule_trigger"
            | "file_watch_trigger"
            | "gmail_new_email_trigger"
            | "google.calendar.event_changed"
            | "google.drive.file_changed"
            | "google.sheets.row_added"
            | "slack.channel_message_posted"
            | "notion.data_source_page_changed"
            | "github.issue_or_pull_request_changed"
            | "github.workflow_run_completed" => Ok(NodeResult::new(
                json!({"executionTime":Utc::now(),"workflowId":workflow.id,"triggerType":node.node_type,"event":trigger}),
            )),
            "condition" => execute_condition(node, trigger, outputs),
            "filter" | "switch" | "split_out" | "loop_over_items" | "aggregate"
            | "remove_duplicates" | "merge" => {
                let named_inputs = canonical_named_inputs(workflow, node, outputs);
                let stored = if node.node_type == "remove_duplicates"
                    && node.configuration.get("scope").and_then(Value::as_str)
                        == Some("workflow_state")
                {
                    self.db
                        .get_workflow_state(&workflow.id, &format!("__stage2_dedupe:{}", node.id))?
                } else {
                    None
                };
                let collection = crate::collection::execute_collection_node(
                    &node.node_type,
                    &node.id,
                    &node.configuration,
                    input_items,
                    named_inputs,
                    &workflow.settings.collection_limits,
                    stored,
                )?;
                let mut result = NodeResult::new(collection.output);
                result.output_items = collection.output_items;
                result.branch_outputs = collection.branch_outputs;
                result.collection = Some(collection.evidence);
                result.logs = collection.logs;
                result.warnings = collection.warnings;
                if let Some(update) = collection.state_update {
                    result.state_updates.push(update);
                }
                Ok(result)
            }
            "set_data" => Ok(NodeResult::new(resolve_value(
                node.configuration.get("values").unwrap_or(&json!({})),
                trigger,
                outputs,
            )?)
            .log("Constructed a new data object.")),
            "delay" => {
                let amount = node
                    .configuration
                    .get("amount")
                    .and_then(Value::as_f64)
                    .unwrap_or(1.0)
                    .max(0.0);
                let multiplier =
                    if node.configuration.get("unit").and_then(Value::as_str) == Some("minutes") {
                        60.0
                    } else {
                        1.0
                    };
                let duration = Duration::from_millis((amount * multiplier * 1000.0) as u64);
                tokio::select! { _ = cancellation.cancelled() => Err(EngineError::Cancelled), _ = tokio::time::sleep(duration) => Ok(NodeResult::new(json!({"delayedMs":duration.as_millis()})).log(format!("Waited for {:.1} seconds.", duration.as_secs_f64()))) }
            }
            "http_request" => {
                self.execute_http(node, workflow, trigger, outputs, cancellation)
                    .await
            }
            "desktop_notification" => {
                let config = resolve_value(&node.configuration, trigger, outputs)?;
                let title = config
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("sndbox");
                let message = config.get("message").and_then(Value::as_str).unwrap_or("");
                self.host.desktop_notification(title, message).await?;
                Ok(NodeResult::new(json!({"delivered":true,"title":title}))
                    .log("Desktop notification delivered."))
            }
            "move_file" => execute_move(node, workflow, trigger, outputs).await,
            "read_file" => execute_read_file(node, workflow, trigger, outputs).await,
            "write_file" => execute_write_file(node, workflow, trigger, outputs).await,
            "copy_path" => execute_copy_path(node, workflow, trigger, outputs).await,
            "delete_path" => execute_delete_path(node, workflow, trigger, outputs).await,
            "list_folder" => execute_list_folder(node, workflow, trigger, outputs).await,
            "parse_csv" => execute_parse_csv(node, workflow, trigger, outputs).await,
            "parse_json" => execute_parse_json(node, workflow, trigger, outputs).await,
            "parse_text" => execute_parse_text(node, workflow, trigger, outputs).await,
            "get_workflow_state" | "set_workflow_state" | "compare_previous" => {
                self.execute_workflow_state(node, workflow, trigger, outputs, pending_state)
            }
            "run_command" => execute_command(node, workflow, trigger, outputs, cancellation).await,
            "ai_prompt" => self.execute_ai_prompt(node, cancellation).await,
            "code" | "javascript_code" | "python_code" | "custom_function" => {
                let result = execute_code(
                    node,
                    workflow,
                    execution_id,
                    &input,
                    &input_items,
                    trigger,
                    outputs,
                    cancellation,
                )
                .await?;
                if node.node_type == "custom_function" { normalize_custom_function_result(node, result) } else { Ok(result) }
            }
            "web_builder" => {
                self.execute_web_builder(node, workflow, trigger, outputs)
                    .await
            }
            "open_browser" | "navigate" | "click_element" | "fill_field" | "select_option"
            | "press_key" | "wait_for" | "extract_data" | "screenshot" | "download_file"
            | "upload_file" | "close_browser" => {
                self.execute_browser(node, workflow, trigger, outputs).await
            }
            "gmail_get_email" | "gmail_create_draft" | "gmail_send_email" | "gmail_add_label"
            | "discord_webhook" | "discord_embed" | "slack_webhook" => {
                self.execute_integration(node, workflow, trigger, outputs)
                    .await
            }
            "approval" => {
                self.execute_approval(node, workflow, execution_id, trigger, outputs, cancellation)
                    .await
            }
            _ if node.plugin.is_some() => {
                let pin = node.plugin.as_ref().expect("guarded plugin pin");
                let input = resolve_value(&pin.input, trigger, outputs)?;
                let mut resolved_node = node.clone();
                resolved_node.configuration = resolve_value(&node.configuration, trigger, outputs)?;
                let result = self
                    .host
                    .plugin_operation(workflow, &resolved_node, execution_id, input, cancellation)
                    .await?;
                let mut node_result = NodeResult::new(result.output).log(format!(
                    "{} completed through its pinned sandbox package.",
                    node.name
                ));
                node_result.logs.extend(result.diagnostics);
                Ok(node_result)
            }
            other => Err(EngineError::Node(format!(
                "Node type '{other}' is not supported by this runner."
            ))),
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_loop_body(
        &self,
        workflow: &Workflow,
        loop_node: &WorkflowNode,
        execution_id: &str,
        trigger: &Value,
        base_outputs: &HashMap<String, Value>,
        pending_state: &HashMap<String, Value>,
        mut loop_result: NodeResult,
        cancellation: CancellationToken,
    ) -> Result<LoopBodyOutcome, (EngineError, Vec<NodeExecution>)> {
        let body_order = loop_body_order(workflow, &loop_node.id);
        if body_order.is_empty() {
            return Err((
                EngineError::Node("Loop Over Items requires a connected Loop body.".into()),
                vec![],
            ));
        }
        let batch_size = loop_node
            .configuration
            .get("batchSize")
            .and_then(Value::as_u64)
            .unwrap_or(1)
            .max(1) as usize;
        let concurrency = loop_node
            .configuration
            .get("concurrency")
            .and_then(Value::as_u64)
            .unwrap_or(1)
            .max(1) as usize;
        let retry_limit = loop_node
            .configuration
            .get("iterationRetryCount")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(10) as u32;
        let timeout = loop_node
            .configuration
            .get("perItemTimeoutMs")
            .and_then(Value::as_u64)
            .unwrap_or(workflow.settings.default_node_timeout_ms)
            .clamp(100, 600_000);
        let continue_failures = loop_node
            .configuration
            .get("failurePolicy")
            .and_then(Value::as_str)
            == Some("continue_handled");
        let batches = loop_result
            .output_items
            .chunks(batch_size)
            .enumerate()
            .map(|(index, items)| (index, items.to_vec()))
            .collect::<Vec<_>>();
        let mut outcomes = Vec::with_capacity(batches.len());
        if concurrency == 1 {
            let mut iteration_state = pending_state.clone();
            for (index, batch) in batches {
                let outcome = self
                    .execute_loop_iteration(
                        workflow.clone(),
                        body_order.clone(),
                        loop_node.id.clone(),
                        execution_id.into(),
                        index,
                        batch,
                        trigger.clone(),
                        base_outputs.clone(),
                        iteration_state.clone(),
                        retry_limit,
                        timeout,
                        cancellation.clone(),
                    )
                    .await;
                if outcome.error.is_none() {
                    for result in outcome.node_results.values() {
                        for (key, value) in &result.state_updates {
                            iteration_state.insert(key.clone(), value.clone());
                        }
                    }
                }
                let failed = outcome.error.is_some();
                outcomes.push(outcome);
                if failed && !continue_failures {
                    break;
                }
            }
        } else {
            let semaphore = Arc::new(tokio::sync::Semaphore::new(concurrency));
            let mut tasks = JoinSet::new();
            for (index, batch) in batches {
                let engine = self.clone();
                let permit = semaphore.clone();
                let workflow = workflow.clone();
                let order = body_order.clone();
                let loop_id = loop_node.id.clone();
                let execution_id = execution_id.to_string();
                let trigger = trigger.clone();
                let outputs = base_outputs.clone();
                let state = pending_state.clone();
                let cancellation = cancellation.clone();
                tasks.spawn(async move {
                    let _permit = permit.acquire_owned().await.expect("loop semaphore open");
                    engine
                        .execute_loop_iteration(
                            workflow,
                            order,
                            loop_id,
                            execution_id,
                            index,
                            batch,
                            trigger,
                            outputs,
                            state,
                            retry_limit,
                            timeout,
                            cancellation,
                        )
                        .await
                });
            }
            while let Some(joined) = tasks.join_next().await {
                match joined {
                    Ok(outcome) => outcomes.push(outcome),
                    Err(error) => {
                        return Err((
                            EngineError::Node(format!("Loop iteration task failed: {error}")),
                            vec![],
                        ))
                    }
                }
            }
            outcomes.sort_by_key(|outcome| outcome.index);
        }
        let summaries =
            loop_iteration_summaries(workflow, &body_order, &outcomes, continue_failures);
        if outcomes
            .iter()
            .any(|outcome| matches!(outcome.error, Some(EngineError::Cancelled)))
        {
            return Err((EngineError::Cancelled, summaries));
        }
        if !continue_failures {
            if let Some(failed) = outcomes.iter().find(|outcome| outcome.error.is_some()) {
                return Err((
                    EngineError::Node(format!(
                        "Loop stopped at iteration {}: {}",
                        failed.index,
                        failed
                            .error
                            .as_ref()
                            .map(ToString::to_string)
                            .unwrap_or_else(|| "item failed".into())
                    )),
                    summaries,
                ));
            }
        }
        let mut successful = vec![];
        let mut failed = vec![];
        for outcome in &outcomes {
            if outcome.error.is_some() {
                for mut item in outcome.batch.clone() {
                    item.status = "failed".into();
                    failed.push(item);
                }
            } else {
                successful.extend(outcome.terminal_items.clone());
            }
            for result in outcome.node_results.values() {
                loop_result
                    .state_updates
                    .extend(result.state_updates.clone());
            }
        }
        let mut done = successful.clone();
        if continue_failures {
            done.extend(failed.clone());
        }
        for (position, item) in done.iter_mut().enumerate() {
            item.current_position = Some(position);
            item.branch = Some("done".into());
            item.branch_history.push("done".into());
        }
        let loop_items = loop_result
            .branch_outputs
            .get("loop")
            .cloned()
            .unwrap_or_else(|| loop_result.output_items.clone());
        loop_result.output_items = done.clone();
        loop_result
            .branch_outputs
            .insert("loop".into(), loop_items.clone());
        loop_result
            .branch_outputs
            .insert("done".into(), done.clone());
        loop_result.output = json!({"items":done,"successfulResults":successful,"failedResults":failed,"branches":{"loop":{"items":loop_items},"done":{"items":done}}});
        if let Some(evidence) = loop_result.collection.as_mut() {
            evidence.output_item_count = done.len();
            evidence.rejected_item_count = failed.len();
            evidence.iteration_count = outcomes.len();
            evidence.batch_count = outcomes.len();
            evidence.branch_counts.insert("done".into(), done.len());
            evidence.ordering_policy = if concurrency == 1 {
                "stable_iteration_order"
            } else {
                "stable iteration index; completion may differ"
            }
            .into();
            evidence.stop_reason = Some(
                if failed.is_empty() {
                    "collection_exhausted"
                } else {
                    "completed_with_handled_failures"
                }
                .into(),
            );
            evidence.sample_items = done
                .iter()
                .take(
                    workflow
                        .settings
                        .collection_limits
                        .max_history_item_previews,
                )
                .cloned()
                .collect();
            evidence.preview_truncated = done.len()
                > workflow
                    .settings
                    .collection_limits
                    .max_history_item_previews;
        }
        loop_result.logs.push(format!(
            "Loop completed {} iteration(s): {} successful result(s), {} handled failure(s).",
            outcomes.len(),
            successful.len(),
            failed.len()
        ));
        if concurrency > 1 {
            loop_result.warnings.push("Concurrent loop iterations can complete side effects out of order. Iteration IDs and retry attempts remain stable.".into());
        }
        Ok(LoopBodyOutcome {
            result: loop_result,
            summaries,
        })
    }

    #[allow(clippy::too_many_arguments)]
    async fn execute_loop_iteration(
        &self,
        workflow: Workflow,
        body_order: Vec<String>,
        loop_id: String,
        execution_id: String,
        index: usize,
        original_batch: Vec<WorkflowItem>,
        trigger: Value,
        base_outputs: HashMap<String, Value>,
        pending_state: HashMap<String, Value>,
        retry_limit: u32,
        per_item_timeout_ms: u64,
        cancellation: CancellationToken,
    ) -> LoopIterationOutcome {
        let body: HashSet<&str> = body_order.iter().map(String::as_str).collect();
        let batch_hash = format!(
            "sha256:{:x}",
            Sha256::digest(serde_json::to_vec(&original_batch).unwrap_or_default())
        );
        let mut attempt = 0u32;
        loop {
            let mut batch = original_batch.clone();
            for item in &mut batch {
                item.loop_iteration = Some(index);
                item.execution_attempt = attempt + 1;
                item.correlations
                    .insert("iterationId".into(), format!("{loop_id}:{index:08}"));
            }
            if let Err(error) = self.db.save_loop_iteration_checkpoint(
                &execution_id,
                &loop_id,
                &format!("{index:08}"),
                attempt + 1,
                "active",
                &batch_hash,
                &json!({"inputItemCount":batch.len(),"attempt":attempt+1}),
            ) {
                return LoopIterationOutcome {
                    index,
                    batch,
                    node_results: Default::default(),
                    terminal_items: vec![],
                    error: Some(error),
                    attempts: attempt + 1,
                };
            }
            let mut outputs = base_outputs.clone();
            outputs.insert(
                loop_id.clone(),
                json!({"items":batch,"branches":{"loop":{"items":batch}}}),
            );
            let mut active: HashMap<String, bool> = workflow
                .edges
                .iter()
                .filter(|edge| {
                    body.contains(edge.target_node_id.as_str())
                        && (edge.source_node_id == loop_id
                            || body.contains(edge.source_node_id.as_str()))
                })
                .map(|edge| {
                    (
                        edge.id.clone(),
                        edge.source_node_id == loop_id && edge.source_handle == "loop",
                    )
                })
                .collect();
            let mut node_results = std::collections::BTreeMap::new();
            let mut error = None;
            for node_id in &body_order {
                if cancellation.is_cancelled() {
                    error = Some(EngineError::Cancelled);
                    break;
                }
                let node = workflow
                    .nodes
                    .iter()
                    .find(|node| node.id == *node_id)
                    .expect("validated loop body node");
                let reached = workflow.edges.iter().any(|edge| {
                    edge.target_node_id == node.id
                        && (edge.source_node_id == loop_id
                            || body.contains(edge.source_node_id.as_str()))
                        && *active.get(&edge.id).unwrap_or(&false)
                });
                if !reached {
                    continue;
                }
                let execution = tokio::select! {
                    _ = cancellation.cancelled() => Err(EngineError::Cancelled),
                    value = tokio::time::timeout(Duration::from_millis(per_item_timeout_ms), self.execute_node(node, &workflow, &execution_id, &trigger, &outputs, &pending_state, cancellation.clone())) => value.unwrap_or_else(|_|Err(EngineError::Node(format!("{} exceeded the loop per-item timeout.",node.name))))
                };
                match execution {
                    Ok(result) => {
                        for edge in workflow.edges.iter().filter(|edge| {
                            edge.source_node_id == node.id
                                && body.contains(edge.target_node_id.as_str())
                        }) {
                            let enabled = if let Some(branch) = &result.branch {
                                edge.source_handle == *branch
                            } else if !result.branch_outputs.is_empty() {
                                result
                                    .branch_outputs
                                    .get(&edge.source_handle)
                                    .is_some_and(|items| !items.is_empty())
                            } else {
                                true
                            };
                            active.insert(edge.id.clone(), enabled);
                        }
                        outputs.insert(node.id.clone(), result.output.clone());
                        node_results.insert(node.id.clone(), result);
                    }
                    Err(failure) => {
                        error = Some(failure);
                        break;
                    }
                }
            }
            if error.is_some() && attempt < retry_limit && !cancellation.is_cancelled() {
                attempt += 1;
                continue;
            }
            let terminal_items = body_order
                .iter()
                .filter(|node_id| {
                    !workflow.edges.iter().any(|edge| {
                        edge.source_node_id.as_str() == node_id.as_str()
                            && body.contains(edge.target_node_id.as_str())
                    })
                })
                .filter_map(|node_id| outputs.get(node_id))
                .flat_map(canonicalize_output)
                .collect::<Vec<_>>();
            let status = if error.is_none() {
                "completed"
            } else if cancellation.is_cancelled() {
                "uncertain"
            } else {
                "failed"
            };
            let checkpoint = json!({"items":terminal_items,"error":error.as_ref().map(ToString::to_string),"attempt":attempt+1});
            if let Err(checkpoint_error) = self.db.save_loop_iteration_checkpoint(
                &execution_id,
                &loop_id,
                &format!("{index:08}"),
                attempt + 1,
                status,
                &batch_hash,
                &checkpoint,
            ) {
                error = Some(checkpoint_error);
            }
            return LoopIterationOutcome {
                index,
                batch,
                node_results,
                terminal_items,
                error,
                attempts: attempt + 1,
            };
        }
    }

    fn execute_workflow_state(
        &self,
        node: &WorkflowNode,
        workflow: &Workflow,
        trigger: &Value,
        outputs: &HashMap<String, Value>,
        pending_state: &HashMap<String, Value>,
    ) -> Result<NodeResult, EngineError> {
        let config = resolve_value(&node.configuration, trigger, outputs)?;
        let key = config
            .get("key")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|key| !key.is_empty())
            .ok_or_else(|| EngineError::Node("Workflow state requires a key.".into()))?;
        let stored = pending_state
            .get(key)
            .cloned()
            .or(self.db.get_workflow_state(&workflow.id, key)?);
        match node.node_type.as_str() {
            "get_workflow_state" => {
                let found = stored.is_some();
                let value = stored
                    .unwrap_or_else(|| config.get("defaultValue").cloned().unwrap_or(Value::Null));
                Ok(
                    NodeResult::new(json!({"key":key,"found":found,"value":value}))
                        .log(format!("Read workflow state '{key}'.")),
                )
            }
            "set_workflow_state" => {
                let value = config.get("value").cloned().unwrap_or(Value::Null);
                Ok(
                    NodeResult::new(json!({"key":key,"previous":stored,"value":value}))
                        .with_state_update(key, value)
                        .log(format!(
                            "Prepared workflow state '{key}' for commit after success."
                        )),
                )
            }
            "compare_previous" => {
                let current = config.get("value").cloned().unwrap_or(Value::Null);
                let normalization = config
                    .get("normalization")
                    .and_then(Value::as_str)
                    .unwrap_or("trim");
                let changed = stored.as_ref().is_some_and(|previous| {
                    normalize_state_value(previous, normalization)
                        != normalize_state_value(&current, normalization)
                });
                Ok(NodeResult::new(json!({"key":key,"changed":changed,"firstObservation":stored.is_none(),"previous":stored,"current":current}))
                    .with_state_update(key, current)
                    .log(if changed { format!("Detected a change in workflow state '{key}'.") } else { format!("Workflow state '{key}' is unchanged.") }))
            }
            _ => unreachable!("state dispatcher only receives state nodes"),
        }
    }

    async fn execute_ai_prompt(
        &self,
        node: &WorkflowNode,
        cancellation: CancellationToken,
    ) -> Result<NodeResult, EngineError> {
        let connection_id = node
            .configuration
            .get("connectionId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| EngineError::Node("AI requires a connected model.".into()))?;
        let prompt = node
            .configuration
            .get("prompt")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| EngineError::Node("AI requires an instruction.".into()))?;
        if prompt.chars().count() > 100_000 {
            return Err(EngineError::Node(
                "AI instructions are limited to 100,000 characters.".into(),
            ));
        }
        let timeout_ms = node
            .configuration
            .get("timeoutMs")
            .and_then(Value::as_u64)
            .unwrap_or(90_000)
            .clamp(1_000, 300_000);
        let request = self.host.ai_operation(node.configuration.clone());
        let output = tokio::select! {
            _ = cancellation.cancelled() => return Err(EngineError::Cancelled),
            result = tokio::time::timeout(Duration::from_millis(timeout_ms), request) => {
                result.map_err(|_| EngineError::Node(format!("AI did not respond within {} seconds.", timeout_ms / 1_000)))??
            }
        };
        Ok(NodeResult::new(output).log(format!(
            "Received a response from AI connection {}.",
            &connection_id[..connection_id.len().min(8)]
        )))
    }

    async fn execute_web_builder(
        &self,
        node: &WorkflowNode,
        workflow: &Workflow,
        trigger: &Value,
        outputs: &HashMap<String, Value>,
    ) -> Result<NodeResult, EngineError> {
        let configuration = resolve_value(&node.configuration, trigger, outputs)?;
        let html = required_source(&configuration, "html", "Web Builder requires HTML input.")?;
        let javascript = required_source(
            &configuration,
            "javascript",
            "Web Builder requires JavaScript input.",
        )?;
        let css = required_source(&configuration, "css", "Web Builder requires CSS input.")?;
        let total_bytes = html.len() + javascript.len() + css.len();
        if total_bytes > 4 * 1024 * 1024 {
            return Err(EngineError::Node(
                "Web Builder source is limited to 4 MB in total.".into(),
            ));
        }
        let port = node
            .configuration
            .get("port")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        if port > u16::MAX as u64 {
            return Err(EngineError::Node(
                "Web Builder port must be between 0 and 65535.".into(),
            ));
        }
        let site_key = format!("{}:{}", workflow.id, node.id);
        if let Some(previous) = self.local_sites.lock().await.remove(&site_key) {
            previous.abort();
        }
        let listener = TcpListener::bind(("127.0.0.1", port as u16))
            .await
            .map_err(|error| {
                EngineError::Node(format!(
                    "Web Builder could not bind localhost port {port}: {error}"
                ))
            })?;
        let bound_port = listener
            .local_addr()
            .map_err(|error| {
                EngineError::Node(format!(
                    "Web Builder could not read its local address: {error}"
                ))
            })?
            .port();
        let page = Arc::new(compose_local_site(html, javascript, css));
        let page_bytes = page.len();
        let handle = tokio::spawn(serve_local_site(listener, page));
        self.local_sites.lock().await.insert(site_key, handle);
        let url = format!("http://127.0.0.1:{bound_port}/");
        let mut result = NodeResult::new(json!({
            "url": url,
            "port": bound_port,
            "status": "serving",
            "htmlBytes": page_bytes,
        }))
        .log(format!("Local site is serving at {url}"));
        if node
            .configuration
            .get("openBrowser")
            .and_then(Value::as_bool)
            .unwrap_or(true)
        {
            match self.host.open_local_url(&url).await {
                Ok(()) => result
                    .logs
                    .push("Opened the localhost site in the default browser.".into()),
                Err(error) => result.logs.push(format!(
                    "The site is running, but could not be opened automatically: {error}"
                )),
            }
        }
        Ok(result)
    }

    async fn execute_approval(
        &self,
        node: &WorkflowNode,
        workflow: &Workflow,
        execution_id: &str,
        trigger: &Value,
        outputs: &HashMap<String, Value>,
        cancellation: CancellationToken,
    ) -> Result<NodeResult, EngineError> {
        let action = resolve_value(&node.configuration, trigger, outputs)?;
        let expires_minutes = action
            .get("expiresInMinutes")
            .and_then(Value::as_i64)
            .unwrap_or(60)
            .clamp(1, 10_080);
        let approval = PendingApproval {
            id: Uuid::new_v4().to_string(),
            execution_id: execution_id.to_string(),
            workflow_id: workflow.id.clone(),
            node_id: node.id.clone(),
            action: redact_value(&action),
            status: "pending".into(),
            created_at: Utc::now(),
            expires_at: Utc::now() + chrono::Duration::minutes(expires_minutes),
            resolved_at: None,
        };
        self.db.save_pending_approval(&approval)?;
        self.host.approval_requested(&approval).await?;
        loop {
            tokio::select! {
                _ = cancellation.cancelled() => return Err(EngineError::Cancelled),
                _ = tokio::time::sleep(Duration::from_millis(400)) => {}
            }
            let current = self.db.get_pending_approval(&approval.id)?.ok_or_else(|| {
                EngineError::Node("The pending approval record was removed.".into())
            })?;
            match current.status.as_str() {
                "approved" => return Ok(NodeResult::new(json!({"approved":true,"approvalId":current.id,"resolvedAt":current.resolved_at})).log("The local action was approved.")),
                "rejected" => return Err(EngineError::Node("The proposed action was rejected locally.".into())),
                _ if Utc::now() >= current.expires_at => return Err(EngineError::Node("The local approval expired before it was reviewed.".into())),
                _ => {}
            }
        }
    }

    async fn execute_integration(
        &self,
        node: &WorkflowNode,
        workflow: &Workflow,
        trigger: &Value,
        outputs: &HashMap<String, Value>,
    ) -> Result<NodeResult, EngineError> {
        let mut payload = resolve_value(&node.configuration, trigger, outputs)?;
        let mutating = matches!(
            node.node_type.as_str(),
            "gmail_create_draft"
                | "gmail_send_email"
                | "gmail_add_label"
                | "discord_webhook"
                | "discord_embed"
                | "slack_webhook"
        );
        if mutating
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
        if node.node_type == "gmail_send_email"
            && workflow
                .settings
                .permissions
                .communication_approval_revision
                .is_none()
        {
            return Err(EngineError::Permission(
                "Send Email requires approval for this workflow version and recipient logic."
                    .into(),
            ));
        }
        let object = payload.as_object_mut().ok_or_else(|| {
            EngineError::Node("Integration node configuration must be an object.".into())
        })?;
        object.insert("workflowId".into(), Value::String(workflow.id.clone()));
        object.insert("nodeId".into(), Value::String(node.id.clone()));
        let output = self
            .host
            .integration_operation(&node.node_type, payload)
            .await?;
        Ok(NodeResult::new(output).log(format!(
            "{} completed through the secure integration host.",
            node.name
        )))
    }

    async fn execute_browser(
        &self,
        node: &WorkflowNode,
        workflow: &Workflow,
        trigger: &Value,
        outputs: &HashMap<String, Value>,
    ) -> Result<NodeResult, EngineError> {
        if !workflow.settings.permissions.browser_automation_permitted {
            return Err(EngineError::Permission(
                "Browser automation requires approval before this workflow can run.".into(),
            ));
        }
        let mut payload = resolve_value(&node.configuration, trigger, outputs)?;
        let object = payload.as_object_mut().ok_or_else(|| {
            EngineError::Node("Browser node configuration must be an object.".into())
        })?;
        object.insert("workflowId".into(), Value::String(workflow.id.clone()));
        object.insert("nodeId".into(), Value::String(node.id.clone()));
        if node.node_type == "open_browser" {
            let profile_id = object
                .get("profileId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    EngineError::Node("Open Browser requires a browser profile.".into())
                })?;
            if !workflow
                .settings
                .permissions
                .approved_browser_profile_ids
                .iter()
                .any(|approved| approved == profile_id)
            {
                return Err(EngineError::Permission(format!(
                    "Browser profile '{profile_id}' has not been approved for this workflow."
                )));
            }
            if !object.contains_key("headed") {
                object.insert(
                    "headed".into(),
                    Value::Bool(trigger.get("type").and_then(Value::as_str) == Some("manual")),
                );
            }
            if object
                .get("keepOpenAfterManualTest")
                .and_then(Value::as_bool)
                == Some(true)
                && trigger.get("type").and_then(Value::as_str) == Some("manual")
            {
                object.insert("closeAutomatically".into(), Value::Bool(false));
            }
        } else {
            let session_id =
                browser_session_id(object.get("sessionNodeId").and_then(Value::as_str), outputs)?;
            object.insert("sessionId".into(), Value::String(session_id));
        }
        if node.node_type == "download_file" {
            if let Some(folder) = object.get("destinationFolder").and_then(Value::as_str) {
                require_path(Path::new(folder), &workflow.settings.permissions)?;
            }
        }
        if node.node_type == "upload_file" {
            if let Some(file) = object.get("file").and_then(Value::as_str) {
                require_path(Path::new(file), &workflow.settings.permissions)?;
            }
        }
        match self.host.browser_operation(&node.node_type, payload).await {
            Ok(output) => {
                let diagnostics = browser_diagnostics_from_output(&output);
                Ok(NodeResult::new(output)
                    .with_browser_diagnostics(diagnostics)
                    .log(format!(
                        "{} completed through the managed Chromium sidecar.",
                        node.name
                    )))
            }
            Err(error) => Err(error),
        }
    }

    async fn execute_http(
        &self,
        node: &WorkflowNode,
        workflow: &Workflow,
        trigger: &Value,
        outputs: &HashMap<String, Value>,
        cancellation: CancellationToken,
    ) -> Result<NodeResult, EngineError> {
        let config = resolve_value(&node.configuration, trigger, outputs)?;
        let url = config
            .get("url")
            .and_then(Value::as_str)
            .ok_or_else(|| EngineError::Node("HTTP Request requires a URL.".into()))?;
        require_domain(url, &workflow.settings.permissions)?;
        let method = Method::from_bytes(
            config
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or("GET")
                .as_bytes(),
        )
        .map_err(|_| EngineError::Node("HTTP Request method is invalid.".into()))?;
        let retries = config
            .get("retryCount")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(5) as u32;
        let timeout_ms = config
            .get("timeoutMs")
            .and_then(Value::as_u64)
            .unwrap_or(30_000)
            .clamp(100, 120_000);
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(timeout_ms))
            .redirect(reqwest::redirect::Policy::limited(10))
            .build()
            .map_err(|e| EngineError::Node(e.to_string()))?;
        let mut last_error = None;
        for attempt in 0..=retries {
            if cancellation.is_cancelled() {
                return Err(EngineError::Cancelled);
            }
            let mut request = client.request(method.clone(), url);
            if let Some(query) = config.get("query").and_then(Value::as_object) {
                request = request.query(&query);
            }
            if let Some(headers) = config.get("headers").and_then(Value::as_object) {
                for (key, value) in headers {
                    if let Some(value) = value.as_str() {
                        request = request.header(key, value);
                    }
                }
            }
            if !matches!(method, Method::GET | Method::DELETE) {
                if let Some(body) = config.get("body") {
                    request = request.json(body);
                }
            }
            let started = Instant::now();
            match request.send().await {
                Ok(response) => {
                    let status = response.status().as_u16();
                    let final_url = response.url().to_string();
                    let headers: Map<String, Value> = response
                        .headers()
                        .iter()
                        .map(|(k, v)| {
                            (
                                k.to_string(),
                                Value::String(v.to_str().unwrap_or("<binary>").to_string()),
                            )
                        })
                        .collect();
                    let bytes = response.bytes().await.map_err(|e| {
                        EngineError::Node(format!("HTTP Request could not read its response: {e}"))
                    })?;
                    if bytes.len() > 1_048_576 {
                        return Err(EngineError::Node(
                            "HTTP Request response exceeded the 1 MB output limit.".into(),
                        ));
                    }
                    let body = serde_json::from_slice(&bytes).unwrap_or_else(|_| {
                        Value::String(String::from_utf8_lossy(&bytes).to_string())
                    });
                    return Ok(NodeResult::new(json!({"status":status,"headers":headers,"body":body,"durationMs":started.elapsed().as_millis(),"finalUrl":final_url}))
                        .log(format!(
                            "{} {} completed with status {}.",
                            method, final_url, status
                        ))
                        .with_retry_count(attempt));
                }
                Err(error) => {
                    last_error = Some(error);
                    if attempt < retries {
                        tokio::time::sleep(Duration::from_millis(250 * 2u64.pow(attempt))).await;
                    }
                }
            }
        }
        let error = last_error.unwrap();
        let message = if error.is_timeout() {
            format!(
                "HTTP Request exceeded its {}-second timeout.",
                timeout_ms as f64 / 1000.0
            )
        } else {
            format!("HTTP Request to '{url}' failed: {error}")
        };
        Err(EngineError::Node(message))
    }
}

#[derive(Debug)]
struct NodeResult {
    output: Value,
    output_items: Vec<WorkflowItem>,
    logs: Vec<String>,
    warnings: Vec<String>,
    lineage: Vec<DataLineage>,
    runtime: Option<RuntimeMetadata>,
    capability_usage: Vec<String>,
    retry_count: u32,
    branch: Option<String>,
    browser_diagnostics: Option<crate::BrowserDiagnostics>,
    state_updates: Vec<(String, Value)>,
    branch_outputs: std::collections::BTreeMap<String, Vec<WorkflowItem>>,
    collection: Option<CollectionEvidence>,
}

struct LoopBodyOutcome {
    result: NodeResult,
    summaries: Vec<NodeExecution>,
}

struct LoopIterationOutcome {
    index: usize,
    batch: Vec<WorkflowItem>,
    node_results: std::collections::BTreeMap<String, NodeResult>,
    terminal_items: Vec<WorkflowItem>,
    error: Option<EngineError>,
    attempts: u32,
}

fn loop_body_order(workflow: &Workflow, loop_node_id: &str) -> Vec<String> {
    let done_starts = workflow
        .edges
        .iter()
        .filter(|edge| edge.source_node_id == loop_node_id && edge.source_handle == "done")
        .map(|edge| edge.target_node_id.clone())
        .collect::<Vec<_>>();
    let mut done_reachable: HashSet<String> = done_starts.iter().cloned().collect();
    let mut pending = done_starts;
    while let Some(source) = pending.pop() {
        for edge in workflow
            .edges
            .iter()
            .filter(|edge| edge.source_node_id == source)
        {
            if done_reachable.insert(edge.target_node_id.clone()) {
                pending.push(edge.target_node_id.clone());
            }
        }
    }
    let mut body = HashSet::new();
    let mut pending = workflow
        .edges
        .iter()
        .filter(|edge| edge.source_node_id == loop_node_id && edge.source_handle == "loop")
        .map(|edge| edge.target_node_id.clone())
        .collect::<Vec<_>>();
    while let Some(node_id) = pending.pop() {
        if done_reachable.contains(&node_id) || !body.insert(node_id.clone()) {
            continue;
        }
        for edge in workflow
            .edges
            .iter()
            .filter(|edge| edge.source_node_id == node_id)
        {
            pending.push(edge.target_node_id.clone());
        }
    }
    topological_order(workflow)
        .unwrap_or_default()
        .into_iter()
        .filter(|id| body.contains(id))
        .collect()
}

fn loop_iteration_summaries(
    workflow: &Workflow,
    body_order: &[String],
    outcomes: &[LoopIterationOutcome],
    continue_failures: bool,
) -> Vec<NodeExecution> {
    let failed_node = outcomes.iter().find_map(|outcome| {
        outcome.error.as_ref().and_then(|error| {
            body_order
                .iter()
                .find(|id| !outcome.node_results.contains_key(*id))
                .map(|id| (id.clone(), error.execution_error()))
        })
    });
    body_order
        .iter()
        .map(|node_id| {
            let node = workflow
                .nodes
                .iter()
                .find(|node| node.id == *node_id)
                .expect("loop body node");
            let results = outcomes
                .iter()
                .filter_map(|outcome| outcome.node_results.get(node_id))
                .collect::<Vec<_>>();
            let total = results
                .iter()
                .map(|result| result.output_items.len())
                .sum::<usize>();
            let output_items = results
                .iter()
                .flat_map(|result| result.output_items.iter().cloned())
                .take(
                    workflow
                        .settings
                        .collection_limits
                        .max_history_item_previews,
                )
                .collect::<Vec<_>>();
            let handled = outcomes
                .iter()
                .filter(|outcome| outcome.error.is_some())
                .count();
            let is_failed =
                !continue_failures && failed_node.as_ref().is_some_and(|(id, _)| id == node_id);
            let status = if is_failed {
                NodeStatus::Failed
            } else if results.is_empty() {
                NodeStatus::Skipped
            } else {
                NodeStatus::Successful
            };
            NodeExecution {
                node_id: node.id.clone(),
                status,
                started_at: None,
                completed_at: Some(Utc::now()),
                duration_ms: None,
                input: json!({"iterations":outcomes.len()}),
                output: json!({"items":output_items}),
                logs: results
                    .iter()
                    .flat_map(|result| result.logs.iter().cloned())
                    .take(100)
                    .collect(),
                retry_count: outcomes
                    .iter()
                    .map(|outcome| outcome.attempts.saturating_sub(1))
                    .max()
                    .unwrap_or(0),
                error: if is_failed {
                    failed_node.as_ref().map(|(_, error)| error.clone())
                } else {
                    None
                },
                skip_reason: (status == NodeStatus::Skipped)
                    .then_some("No loop iteration selected this body node.".into()),
                branch_followed: None,
                browser_diagnostics: None,
                input_items: vec![],
                output_items: output_items.clone(),
                warnings: if handled > 0 && continue_failures {
                    vec![format!(
                        "{handled} iteration failure(s) were handled by Loop Over Items."
                    )]
                } else {
                    vec![]
                },
                lineage: vec![],
                runtime: None,
                test_data_source: None,
                capability_usage: vec![],
                collection: Some(CollectionEvidence {
                    input_item_count: outcomes.len(),
                    output_item_count: total,
                    rejected_item_count: handled,
                    branch_counts: Default::default(),
                    iteration_count: outcomes.len(),
                    batch_count: outcomes.len(),
                    sample_items: output_items,
                    preview_truncated: total
                        > workflow
                            .settings
                            .collection_limits
                            .max_history_item_previews,
                    runtime_data_truncated: false,
                    ordering_policy: "iteration_index".into(),
                    stop_reason: None,
                    waiting_for_inputs: vec![],
                }),
            }
        })
        .collect()
}
impl NodeResult {
    fn new(output: Value) -> Self {
        Self {
            output_items: canonicalize_output(&output),
            output,
            logs: vec![],
            warnings: vec![],
            lineage: vec![],
            runtime: None,
            capability_usage: vec![],
            retry_count: 0,
            branch: None,
            browser_diagnostics: None,
            state_updates: vec![],
            branch_outputs: Default::default(),
            collection: None,
        }
    }
    fn log(mut self, message: impl Into<String>) -> Self {
        self.logs.push(message.into());
        self
    }
    fn with_runtime(mut self, runtime: RuntimeMetadata) -> Self {
        self.runtime = Some(runtime);
        self
    }
    fn with_logs(mut self, logs: Vec<String>) -> Self {
        self.logs.extend(logs);
        self
    }
    fn with_capability(mut self, capability: impl Into<String>) -> Self {
        self.capability_usage.push(capability.into());
        self
    }
    fn with_retry_count(mut self, retry_count: u32) -> Self {
        self.retry_count = retry_count;
        self
    }
    fn with_branch(mut self, branch: impl Into<String>) -> Self {
        self.branch = Some(branch.into());
        self
    }
    fn with_browser_diagnostics(mut self, diagnostics: Option<crate::BrowserDiagnostics>) -> Self {
        self.browser_diagnostics = diagnostics;
        self
    }
    fn with_state_update(mut self, key: impl Into<String>, value: Value) -> Self {
        self.state_updates.push((key.into(), value));
        self
    }
}

fn canonicalize_output(output: &Value) -> Vec<WorkflowItem> {
    if let Some(items) = output.get("items").and_then(Value::as_array) {
        return items.iter().map(workflow_item_from_value).collect();
    }
    vec![WorkflowItem::json(output.clone())]
}

fn bounded_history_value(value: &Value, maximum_items: usize) -> Value {
    match value {
        Value::Array(values) => Value::Array(
            values
                .iter()
                .take(maximum_items)
                .map(|value| bounded_history_value(value, maximum_items))
                .collect(),
        ),
        Value::Object(object) => {
            let mut bounded = Map::new();
            for (key, value) in object {
                if key == "items"
                    && value
                        .as_array()
                        .is_some_and(|items| items.len() > maximum_items)
                {
                    let items = value.as_array().unwrap();
                    bounded.insert(
                        key.clone(),
                        Value::Array(
                            items
                                .iter()
                                .take(maximum_items)
                                .map(|item| bounded_history_value(item, maximum_items))
                                .collect(),
                        ),
                    );
                    bounded.insert("previewTruncated".into(), Value::Bool(true));
                    bounded.insert("authoritativeItemCount".into(), json!(items.len()));
                } else {
                    bounded.insert(key.clone(), bounded_history_value(value, maximum_items));
                }
            }
            Value::Object(bounded)
        }
        other => other.clone(),
    }
}

fn workflow_item_from_value(value: &Value) -> WorkflowItem {
    let is_canonical = value.as_object().is_some_and(|object| {
        object.contains_key("data")
            || object.contains_key("binary")
            || object.contains_key("sourceNodeId")
            || object.contains_key("source_node_id")
            || object.contains_key("sourceItemIndex")
            || object.contains_key("source_item_index")
            || object.contains_key("branch")
    });
    if is_canonical {
        serde_json::from_value::<WorkflowItem>(value.clone())
            .unwrap_or_else(|_| WorkflowItem::json(value.clone()))
    } else {
        WorkflowItem::json(value.clone())
    }
}

fn resolve_configuration_expressions(
    configuration: &Value,
    context: &ExpressionContext<'_>,
) -> Result<Value, EngineError> {
    let Some(object) = configuration.as_object() else {
        return Err(EngineError::Validation(
            "Node configuration must be a JSON object.".into(),
        ));
    };
    let mut resolved = object.clone();
    // Source, package metadata, fixtures, credential references and local
    // permission identifiers are data, never expression-bearing fields.
    for (key, value) in object {
        if matches!(
            key.as_str(),
            "sourceCode"
                | "dependencies"
                | "runtimeVersion"
                | "helperLanguageVersion"
                | "pinnedData"
                | "credentialId"
                | "connectionId"
                | "profileId"
        ) {
            continue;
        }
        resolved.insert(key.clone(), resolve_expression_value(value, context)?);
    }
    Ok(Value::Object(resolved))
}

fn fixture_items(value: &Value) -> Vec<WorkflowItem> {
    match value {
        Value::Array(values) => values.iter().map(workflow_item_from_value).collect(),
        other => canonicalize_output(other),
    }
}

fn canonical_input_items(
    workflow: &Workflow,
    node: &WorkflowNode,
    outputs: &HashMap<String, Value>,
) -> Vec<WorkflowItem> {
    if let Some(value) = node.configuration.get("input") {
        let mut items = canonicalize_output(value);
        for (index, item) in items.iter_mut().enumerate() {
            ensure_item_identity(item, &node.id, index);
        }
        return items;
    }
    let mut items = Vec::new();
    for edge in workflow
        .edges
        .iter()
        .filter(|edge| edge.target_node_id == node.id)
    {
        if let Some(output) = outputs
            .get(&edge.source_node_id)
            .and_then(|output| output_for_handle(output, &edge.source_handle))
        {
            for (index, mut item) in canonicalize_output(output).into_iter().enumerate() {
                item.source_node_id = Some(edge.source_node_id.clone());
                item.source_item_index = Some(index);
                item.branch = Some(edge.source_handle.clone());
                ensure_item_identity(&mut item, &edge.source_node_id, index);
                items.push(item);
            }
        }
    }
    items
}

fn ensure_item_identity(item: &mut WorkflowItem, source: &str, index: usize) {
    if item.item_id.is_empty() {
        item.item_id = format!("{source}:{index}");
    }
    if item.origin_item_id.is_none() {
        item.origin_item_id = Some(item.item_id.clone());
    }
    item.original_position.get_or_insert(index);
    item.current_position.get_or_insert(index);
}

fn canonical_named_inputs(
    workflow: &Workflow,
    node: &WorkflowNode,
    outputs: &HashMap<String, Value>,
) -> std::collections::BTreeMap<String, Vec<WorkflowItem>> {
    let mut named = std::collections::BTreeMap::new();
    if node.node_type == "merge" {
        if let Some(test_inputs) = node
            .configuration
            .get("namedTestInputs")
            .and_then(Value::as_object)
        {
            for (port, value) in test_inputs {
                let mut items = fixture_items(value);
                for (index, item) in items.iter_mut().enumerate() {
                    ensure_item_identity(item, &format!("{}:{port}", node.id), index);
                }
                named.insert(port.clone(), items);
            }
        }
    }
    for edge in workflow
        .edges
        .iter()
        .filter(|edge| edge.target_node_id == node.id)
    {
        let port = edge
            .target_port
            .as_deref()
            .unwrap_or(&edge.target_handle)
            .to_string();
        let target = named.entry(port).or_insert_with(Vec::new);
        if let Some(output) = outputs
            .get(&edge.source_node_id)
            .and_then(|output| output_for_handle(output, &edge.source_handle))
        {
            for (index, mut item) in canonicalize_output(output).into_iter().enumerate() {
                item.source_node_id = Some(edge.source_node_id.clone());
                item.source_item_index = Some(index);
                item.branch = Some(edge.source_handle.clone());
                item.branch_history.push(edge.source_handle.clone());
                ensure_item_identity(&mut item, &edge.source_node_id, index);
                target.push(item);
            }
        }
    }
    // Configured Merge inputs remain visible even when an upstream branch is empty.
    if node.node_type == "merge" {
        if let Some(ports) = node
            .configuration
            .get("inputPorts")
            .and_then(Value::as_array)
        {
            for port in ports
                .iter()
                .filter_map(|port| port.get("id").and_then(Value::as_str))
            {
                named.entry(port.to_string()).or_default();
            }
        }
    }
    named
}

fn output_for_handle<'a>(output: &'a Value, handle: &str) -> Option<&'a Value> {
    output
        .get("branches")
        .and_then(|branches| branches.get(handle))
        .or_else(|| (handle == "output").then_some(output))
}

fn binding_lineage(node: &WorkflowNode) -> Vec<DataLineage> {
    node.input_bindings
        .iter()
        .filter_map(|(field, binding)| match binding {
            InputBinding::NodeOutput { node_id, path } => Some(DataLineage {
                source: format!("node:{node_id}"),
                path: path.clone(),
                target_field: field.clone(),
            }),
            InputBinding::Template { .. } => Some(DataLineage {
                source: "expression".into(),
                path: vec![],
                target_field: field.clone(),
            }),
            InputBinding::ProtectedVariable { name } => Some(DataLineage {
                source: format!("environment:{name}"),
                path: vec![],
                target_field: field.clone(),
            }),
            _ => None,
        })
        .collect()
}

fn resolve_node_bindings(
    node: &WorkflowNode,
    _trigger: &Value,
    outputs: &HashMap<String, Value>,
) -> Result<WorkflowNode, EngineError> {
    if node.input_bindings.is_empty() {
        return Ok(node.clone());
    }
    let mut resolved = node.clone();
    let configuration = resolved.configuration.as_object_mut().ok_or_else(|| {
        EngineError::Validation("Node configuration must be a JSON object.".into())
    })?;
    for (field, binding) in &node.input_bindings {
        let value = match binding {
            InputBinding::Literal { value } => value.clone(),
            InputBinding::NodeOutput { node_id, path } => {
                let output = outputs.get(node_id).ok_or_else(|| {
                    EngineError::Node(format!(
                        "Input '{field}' requires output from node '{node_id}', but no successful output is available."
                    ))
                })?;
                value_at_path(output, path).cloned().ok_or_else(|| {
                    EngineError::Node(format!(
                        "Input '{field}' could not find output path '{}' on node '{node_id}'.",
                        path.join(".")
                    ))
                })?
            }
            InputBinding::Template { template } => Value::String(template.clone()),
            InputBinding::ProtectedVariable { name } => {
                Value::String(format!("{{{{ env.{name} }}}}"))
            }
            InputBinding::Connection { connection_id } => Value::String(connection_id.clone()),
        };
        configuration.insert(field.clone(), value);
    }
    Ok(resolved)
}

fn value_at_path<'a>(value: &'a Value, path: &[String]) -> Option<&'a Value> {
    let mut current = value;
    for segment in path {
        current = match current {
            Value::Object(object) => object.get(segment)?,
            Value::Array(array) => array.get(segment.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(current)
}

fn node_has_side_effect(node_type: &str) -> bool {
    matches!(
        node_type,
        "desktop_notification"
            | "move_file"
            | "write_file"
            | "copy_path"
            | "delete_path"
            | "run_command"
            | "code"
            | "javascript_code"
            | "python_code"
            | "web_builder"
            | "gmail_create_draft"
            | "gmail_send_email"
            | "gmail_add_label"
            | "discord_webhook"
            | "discord_embed"
            | "slack_webhook"
            | "approval"
            | "set_workflow_state"
            | "compare_previous"
    )
}

fn normalize_state_value(value: &Value, normalization: &str) -> Value {
    let Value::String(text) = value else {
        return value.clone();
    };
    match normalization {
        "lowercase" => Value::String(text.trim().to_lowercase()),
        "collapse_whitespace" => {
            Value::String(text.split_whitespace().collect::<Vec<_>>().join(" "))
        }
        "none" => value.clone(),
        _ => Value::String(text.trim().to_string()),
    }
}

fn required_source<'a>(
    configuration: &'a Value,
    key: &str,
    message: &str,
) -> Result<&'a str, EngineError> {
    configuration
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| EngineError::Node(message.into()))
}

fn compose_local_site(html: &str, javascript: &str, css: &str) -> String {
    let style = format!("<style data-sndbox-web-builder>\n{css}\n</style>");
    let script = format!("<script data-sndbox-web-builder>\n{javascript}\n</script>");
    let lower = html.to_ascii_lowercase();
    if lower.contains("<html") {
        let mut page = html.to_string();
        if let Some(index) = page.to_ascii_lowercase().rfind("</head>") {
            page.insert_str(index, &style);
        } else {
            page.insert_str(0, &style);
        }
        if let Some(index) = page.to_ascii_lowercase().rfind("</body>") {
            page.insert_str(index, &script);
        } else {
            page.push_str(&script);
        }
        page
    } else {
        format!(
            "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">{style}</head><body>{html}{script}</body></html>"
        )
    }
}

async fn serve_local_site(listener: TcpListener, page: Arc<String>) {
    loop {
        let Ok((mut stream, _)) = listener.accept().await else {
            break;
        };
        let page = page.clone();
        tokio::spawn(async move {
            let mut request = [0u8; 8_192];
            let Ok(read) = stream.read(&mut request).await else {
                return;
            };
            let request_line = String::from_utf8_lossy(&request[..read]);
            let head_only = request_line.starts_with("HEAD ");
            let health = request_line.starts_with("GET /health ")
                || request_line.starts_with("HEAD /health ");
            let (status, content_type, body) = if health {
                (
                    "200 OK",
                    "application/json; charset=utf-8",
                    "{\"status\":\"ok\"}".to_string(),
                )
            } else if request_line.starts_with("GET / ") || request_line.starts_with("HEAD / ") {
                (
                    "200 OK",
                    "text/html; charset=utf-8",
                    page.as_str().to_string(),
                )
            } else {
                (
                    "404 Not Found",
                    "text/plain; charset=utf-8",
                    "Not found".to_string(),
                )
            };
            let header = format!(
                "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(header.as_bytes()).await;
            if !head_only {
                let _ = stream.write_all(body.as_bytes()).await;
            }
            let _ = stream.shutdown().await;
        });
    }
}

async fn execute_code(
    node: &WorkflowNode,
    workflow: &Workflow,
    execution_id: &str,
    input: &Value,
    input_items: &[WorkflowItem],
    trigger: &Value,
    outputs: &HashMap<String, Value>,
    cancellation: CancellationToken,
) -> Result<NodeResult, EngineError> {
    let language = node
        .configuration
        .get("language")
        .and_then(Value::as_str)
        .unwrap_or("javascript");
    if !matches!(language, "python" | "html" | "javascript" | "css") {
        return Err(EngineError::Node(format!(
            "Code language '{language}' is not supported."
        )));
    }
    let source = node
        .configuration
        .get("sourceCode")
        .and_then(Value::as_str)
        .unwrap_or("");
    if source.len() > 2 * 1024 * 1024 {
        return Err(EngineError::Node("Code source is limited to 2 MB.".into()));
    }
    let mode = node
        .configuration
        .get("executionMode")
        .and_then(Value::as_str)
        .unwrap_or("source");
    if mode != "run" || matches!(language, "html" | "css") {
        return Ok(NodeResult::new(json!({
            "language": language,
            "code": source,
            "result": source,
            "stdout": "",
        }))
        .log(format!("Provided {} source to downstream nodes.", language)));
    }
    if node.node_type != "custom_function" && (!workflow.settings.permissions.command_execution_permitted
        || workflow.settings.permissions.approval_revision.is_none()
    ) {
        return Err(EngineError::Permission(
            "Executing a Code node requires command execution approval.".into(),
        ));
    }
    let runtime_requirement = node
        .configuration
        .get("runtimeVersion")
        .and_then(Value::as_str)
        .unwrap_or(if language == "python" {
            ">=3.11"
        } else {
            ">=20"
        });
    let execution_mode = node
        .configuration
        .get("itemMode")
        .and_then(Value::as_str)
        .unwrap_or("all_items");
    if !matches!(execution_mode, "all_items" | "each_item") {
        return Err(EngineError::Validation(
            "Code itemMode must be 'all_items' or 'each_item'.".into(),
        ));
    }
    let dependencies = node
        .configuration
        .get("dependencies")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !dependencies.is_empty() {
        return Err(EngineError::Permission("Code packages are not installed during execution. Managed runtimes currently provide only the documented built-in helper library.".into()));
    }
    let (executable, extension, wrapper) = if language == "python" {
        ("python", "py", PYTHON_CODE_WRAPPER)
    } else {
        ("node", "js", JAVASCRIPT_CODE_WRAPPER)
    };
    let runtime_version = installed_runtime_version(executable).ok_or_else(|| {
        EngineError::Node(format!(
            "Code could not inspect the installed {language} runtime."
        ))
    })?;
    if !runtime_requirement_met(runtime_requirement, &runtime_version) {
        return Err(EngineError::Validation(format!("{language} runtime {runtime_version} does not satisfy the saved requirement {runtime_requirement}.")));
    }
    let code_directory = std::env::temp_dir().join("sndbox-code");
    tokio::fs::create_dir_all(&code_directory)
        .await
        .map_err(|error| {
            EngineError::Node(format!(
                "Code could not prepare its temporary directory: {error}"
            ))
        })?;
    let script_path = code_directory.join(format!("{}.{}", Uuid::new_v4(), extension));
    tokio::fs::write(&script_path, wrapper)
        .await
        .map_err(|error| {
            EngineError::Node(format!("Code could not prepare the script: {error}"))
        })?;
    let payload = json!({
        "source": source,
        "input": input,
        "items": input_items,
        "nodes": outputs,
        "trigger": trigger,
        "workflow": {"id":workflow.id,"name":workflow.name,"schemaVersion":workflow.schema_version},
        "execution": {"id":execution_id,"attempt":1},
        "configuration": node.configuration.get("customConfiguration").cloned().unwrap_or_else(|| json!({})),
        "mode": execution_mode,
    });
    let mut command = Command::new(executable);
    if language == "python" {
        command.arg("-I").arg("-B").arg(&script_path);
    } else {
        command
            .arg("--max-old-space-size=128")
            .arg(node_permission_flag())
            .arg(format!("--allow-fs-read={}", script_path.display()))
            .arg(&script_path);
    }
    command
        .env_clear()
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Windows' runtime loader and CSPRNG require these OS bootstrap paths.
    // They are not exposed to user code (the wrapper shadows `process`) and
    // no user or workflow environment variables are inherited.
    #[cfg(windows)]
    for name in ["SystemRoot", "WINDIR"] {
        if let Ok(value) = std::env::var(name) {
            command.env(name, value);
        }
    }
    let mut child = command.spawn().map_err(|error| {
        EngineError::Node(format!(
            "Code could not start {executable}. Install it or switch this node to source mode: {error}"
        ))
    })?;
    let mut stdin = child.stdin.take().expect("piped stdin");
    let encoded_payload = serde_json::to_vec(&payload)
        .map_err(|error| EngineError::Node(format!("Code input could not be encoded: {error}")))?;
    tokio::spawn(async move {
        let _ = stdin.write_all(&encoded_payload).await;
    });
    let stdout_task = tokio::spawn(read_bounded_to(
        child.stdout.take().expect("piped stdout"),
        1_048_576,
    ));
    let stderr_task = tokio::spawn(read_bounded(child.stderr.take().expect("piped stderr")));
    let timeout_ms = node
        .configuration
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(30_000)
        .clamp(100, 120_000);
    let status = tokio::select! {
        _ = cancellation.cancelled() => {
            let _ = child.kill().await;
            let _ = tokio::fs::remove_file(&script_path).await;
            return Err(EngineError::Cancelled);
        },
        result = tokio::time::timeout(Duration::from_millis(timeout_ms), child.wait()) => {
            match result {
                Ok(status) => status.map_err(|error| EngineError::Node(format!("Code could not await the script: {error}")))?,
                Err(_) => {
                    let _ = child.kill().await;
                    let _ = tokio::fs::remove_file(&script_path).await;
                    return Err(EngineError::Node(format!("Code exceeded its {} ms timeout.", timeout_ms)));
                }
            }
        }
    };
    let stdout_bytes = stdout_task.await.unwrap_or_default();
    let stdout = String::from_utf8_lossy(&stdout_bytes).to_string();
    let stderr = String::from_utf8_lossy(&stderr_task.await.unwrap_or_default()).to_string();
    let _ = tokio::fs::remove_file(&script_path).await;
    if !status.success() {
        return Err(EngineError::Node(format!(
            "Code exited with status {}. {}",
            status
                .code()
                .map(|code| code.to_string())
                .unwrap_or_else(|| "unknown".into()),
            bounded_log(&stderr)
        )));
    }
    if stdout_bytes.len() >= 1_048_576 {
        return Err(EngineError::Node(
            "Code output exceeded the 1 MiB limit.".into(),
        ));
    }
    let protocol: Value = serde_json::from_str(stdout.trim()).map_err(|_| {
        EngineError::Node(format!(
            "Code runtime returned an invalid output contract. {}",
            bounded_log(&stderr)
        ))
    })?;
    let result = protocol.get("result").cloned().unwrap_or(Value::Null);
    let logs = protocol
        .get("logs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(bounded_log)
        .take(100)
        .collect::<Vec<_>>();
    let output = json!({"language":language,"runtimeVersion":runtime_version,"runtimeRequirement":runtime_requirement,"helperLanguageVersion":EXPRESSION_LANGUAGE_VERSION,"items":result,"result":result,"exitCode":status.code()});
    let log_bytes = logs.iter().map(String::len).sum::<usize>() as u64;
    let dependency_environment_id =
        format!("builtin:{language}:{runtime_version}:helpers-v{EXPRESSION_LANGUAGE_VERSION}");
    Ok(NodeResult::new(output)
        .with_logs(logs)
        .log(format!(
            "Executed {language} in {execution_mode} mode and validated its item contract."
        ))
        .with_runtime(RuntimeMetadata {
            runtime: language.into(),
            runtime_version: runtime_version.clone(),
            helper_language_version: EXPRESSION_LANGUAGE_VERSION,
            dependency_environment_id,
            execution_mode: execution_mode.into(),
            output_bytes: stdout_bytes.len() as u64,
            log_bytes,
        })
        .with_capability("code.execute"))
}

fn normalize_custom_function_result(node: &WorkflowNode, mut result: NodeResult) -> Result<NodeResult, EngineError> {
    let customization = node.customization.as_ref().ok_or_else(|| EngineError::Validation("Custom function contract is missing.".into()))?;
    let returned = result.output.pointer("/result/0/data").cloned().unwrap_or(Value::Null);
    let object = returned.as_object().ok_or_else(|| EngineError::Node("Custom functions must return { outputs, branches? }.".into()))?;
    let outputs = object.get("outputs").and_then(Value::as_object).ok_or_else(|| EngineError::Node("Custom functions must return an outputs object.".into()))?;
    for port in &customization.outputs {
        let value = outputs.get(&port.key);
        if port.required && value.is_none() {
            return Err(EngineError::Node(format!("Custom function did not return required output '{}'.", port.key)));
        }
        if let Some(value) = value {
            let valid = match port.value_type {
                ValueType::Any => true,
                ValueType::String | ValueType::Path | ValueType::Connection => value.is_string(),
                ValueType::Number => value.is_number(), ValueType::Boolean => value.is_boolean(),
                ValueType::Object => value.is_object(), ValueType::Array => value.is_array(),
            };
            if !valid { return Err(EngineError::Node(format!("Custom output '{}' does not match its declared {:?} type.", port.key, port.value_type))); }
        }
    }
    if outputs.keys().any(|key| !customization.outputs.iter().any(|port| &port.key == key)) {
        return Err(EngineError::Node("Custom function returned an undeclared output.".into()));
    }
    let declared_branches = customization.branches.iter().map(|port| port.key.as_str()).collect::<HashSet<_>>();
    let branches = object.get("branches").and_then(Value::as_object).cloned().unwrap_or_default();
    if branches.keys().any(|key| !declared_branches.contains(key.as_str())) {
        return Err(EngineError::Node("Custom function returned an undeclared branch.".into()));
    }
    result.branch_outputs = branches.into_iter().map(|(key, value)| {
        let values = value.as_array().cloned().unwrap_or_else(|| vec![value]);
        (key.clone(), values.into_iter().enumerate().map(|(index, value)| {
            let mut item = WorkflowItem::json(value);
            item.source_node_id = Some(node.id.clone()); item.source_item_index = Some(index); item.branch = Some(key.clone()); item
        }).collect())
    }).collect();
    result.collection = Some(CollectionEvidence {
        input_item_count: 0,
        output_item_count: 1,
        branch_counts: result.branch_outputs.iter().map(|(key, items)| (key.clone(), items.len())).collect(),
        ordering_policy: "declared_custom_branch_order".into(),
        ..Default::default()
    });
    result.output = Value::Object(outputs.clone());
    result.output_items = vec![WorkflowItem::json(result.output.clone())];
    result.logs.push("Validated custom ƒx outputs and branch correspondence.".into());
    Ok(result)
}

const JAVASCRIPT_CODE_WRAPPER: &str = r#"'use strict';
const nativeProcess = process;
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
let raw=''; nativeProcess.stdin.setEncoding('utf8');
nativeProcess.stdin.on('data', c => raw += c);
nativeProcess.stdin.on('end', async () => {
  const payload=JSON.parse(raw), logs=[]; let logBytes=0,logsTruncated=false;
  const pushLog=value=>{if(logsTruncated)return;const text=String(value),remaining=65536-logBytes;if(remaining<=0){logs.push('[logs truncated]');logsTruncated=true;return;}logs.push(text.slice(0,remaining));logBytes+=Math.min(text.length,remaining);if(text.length>remaining){logs.push('[logs truncated]');logsTruncated=true;}};
  const safeConsole=Object.freeze({log:(...v)=>pushLog(v.map(x=>typeof x==='string'?x:JSON.stringify(x)).join(' ')),warn:(...v)=>pushLog('[warn] '+v.join(' ')),error:(...v)=>pushLog('[error] '+v.join(' '))});
  const helpers=Object.freeze({json:Object.freeze({parse:JSON.parse,stringify:JSON.stringify}),string:Object.freeze({trim:v=>String(v).trim(),lower:v=>String(v).toLowerCase(),upper:v=>String(v).toUpperCase()}),number:v=>{const n=Number(v);if(!Number.isFinite(n))throw new TypeError('number() conversion failed');return n;},boolean:v=>v===true||v==='true'||(typeof v==='number'&&v!==0),array:Object.freeze({first:v=>v?.[0]??null,last:v=>v?.[v.length-1]??null,length:v=>Array.isArray(v)?v.length:0}),object:Object.freeze({keys:Object.keys,values:Object.values}),date:Object.freeze({iso:v=>new Date(v).toISOString()})});
  let seed=2166136261; Math.random=()=>((seed=Math.imul(seed^seed>>>15,1|seed))>>>0)/4294967296; const NativeDate=Date,fixed=NativeDate.now(); globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[fixed]));}static now(){return fixed;}};
  try { delete globalThis.process; delete globalThis.fetch; } catch {}
  const run=async (input,items)=>{ const fn=new AsyncFunction('ctx','input','items','nodes','trigger','workflow','execution','helpers','console','require','process','fetch','"use strict";\n'+payload.source); return await fn(Object.freeze({input,inputs:payload.configuration.fixtureInputs??input,items,configuration:payload.configuration,upstream:payload.nodes,nodes:payload.nodes,trigger:payload.trigger,workflow:payload.workflow,execution:payload.execution,helpers,log:safeConsole.log}),input,items,payload.nodes,payload.trigger,payload.workflow,payload.execution,helpers,safeConsole,undefined,undefined,undefined); };
  try { let value;if(payload.mode==='each_item'){value=[];for(const item of payload.items)value.push(await run(item.data,[item]));}else value=await run(payload.input,payload.items); if(value===undefined)value=null; const items=Array.isArray(value)?value:(value&&Array.isArray(value.items)?value.items:[value]); nativeProcess.stdout.write(JSON.stringify({result:items.map((v,i)=>v&&Object.prototype.hasOwnProperty.call(v,'data')?v:{data:v,sourceItemIndex:i}),logs})); } catch(error){ nativeProcess.stderr.write(String(error?.stack||error)); nativeProcess.exitCode=1; }
});"#;

const PYTHON_CODE_WRAPPER: &str = r#"import sys,json,io,traceback,builtins,math,re,statistics,collections,itertools,functools,decimal
payload=json.load(sys.stdin); logs=[]; log_bytes=0; logs_truncated=False
def record_log(value):
 global log_bytes,logs_truncated
 if logs_truncated: return
 text=str(value); remaining=65536-log_bytes
 if remaining<=0: logs.append('[logs truncated]');logs_truncated=True;return
 logs.append(text[:remaining]);log_bytes+=min(len(text),remaining)
 if len(text)>remaining: logs.append('[logs truncated]');logs_truncated=True
class Log(io.StringIO):
 def write(self,s):
  if s.strip(): record_log(s.rstrip())
  return len(s)
safe={'json','math','re','statistics','collections','itertools','functools','decimal'}
native_import=builtins.__import__
def limited_import(name,*args,**kwargs):
 if name.split('.')[0] not in safe: raise PermissionError("module access is not permitted: "+name)
 return native_import(name,*args,**kwargs)
builtins.__import__=limited_import
def audit(event,args):
 if event.startswith(('open','socket.','subprocess.','os.system','ctypes.')): raise PermissionError("host capability is not permitted: "+event)
sys.addaudithook(audit)
helpers={'string':{'trim':lambda v:str(v).strip(),'lower':lambda v:str(v).lower(),'upper':lambda v:str(v).upper()},'array':{'first':lambda v:v[0] if v else None,'last':lambda v:v[-1] if v else None}}
def run(inp,items):
 scope={'ctx':{'input':inp,'inputs':payload['configuration'].get('fixtureInputs',inp),'items':items,'configuration':payload['configuration'],'upstream':payload['nodes'],'nodes':payload['nodes'],'trigger':payload['trigger'],'workflow':payload['workflow'],'execution':payload['execution'],'helpers':helpers,'log':record_log},'input':inp,'items':items,'nodes':payload['nodes'],'trigger':payload['trigger'],'workflow':payload['workflow'],'execution':payload['execution'],'helpers':helpers,'result':None,'print':lambda *v,**k:record_log(' '.join(map(str,v)))}
 exec(compile(payload['source'],'user_code.py','exec'),{'__builtins__':dict(vars(builtins),open=None,exec=None,eval=None,compile=None,input=None)},scope)
 if callable(scope.get('main')): return scope['main'](scope['ctx'])
 return scope.get('result')
try:
 value=[run(item.get('data'),[item]) for item in payload['items']] if payload['mode']=='each_item' else run(payload['input'],payload['items'])
 values=value if isinstance(value,list) else (value.get('items') if isinstance(value,dict) and isinstance(value.get('items'),list) else [value])
 print(json.dumps({'result':[v if isinstance(v,dict) and 'data' in v else {'data':v,'sourceItemIndex':i} for i,v in enumerate(values)],'logs':logs},separators=(',',':')),file=sys.__stdout__)
except BaseException:
 traceback.print_exc(file=sys.__stderr__);sys.exit(1)
"#;

fn node_permission_flag() -> &'static str {
    let major = std::process::Command::new("node")
        .arg("--version")
        .output()
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .and_then(|value| {
            value
                .trim()
                .trim_start_matches('v')
                .split('.')
                .next()?
                .parse::<u32>()
                .ok()
        })
        .unwrap_or(20);
    if major >= 23 {
        "--permission"
    } else {
        "--experimental-permission"
    }
}

fn installed_runtime_version(executable: &str) -> Option<String> {
    let output = std::process::Command::new(executable)
        .arg("--version")
        .output()
        .ok()?;
    let value = if output.stdout.is_empty() {
        output.stderr
    } else {
        output.stdout
    };
    let text = String::from_utf8(value).ok()?;
    text.split_whitespace()
        .find(|part| part.chars().any(|character| character.is_ascii_digit()))
        .map(|part| part.trim_start_matches('v').to_string())
}
fn runtime_requirement_met(requirement: &str, actual: &str) -> bool {
    let actual_parts = actual
        .split('.')
        .filter_map(|part| part.parse::<u32>().ok())
        .collect::<Vec<_>>();
    let expected = requirement
        .trim_start_matches(">=")
        .split('.')
        .filter_map(|part| part.parse::<u32>().ok())
        .collect::<Vec<_>>();
    if actual_parts.is_empty() || expected.is_empty() {
        return false;
    }
    if requirement.starts_with(">=") {
        actual_parts >= expected
    } else {
        actual_parts.starts_with(&expected)
    }
}

fn execute_condition(
    node: &WorkflowNode,
    trigger: &Value,
    outputs: &HashMap<String, Value>,
) -> Result<NodeResult, EngineError> {
    let left = resolve_value(
        node.configuration
            .get("left")
            .ok_or_else(|| EngineError::Node("Condition has no value to compare.".into()))?,
        trigger,
        outputs,
    )?;
    let right = resolve_value(
        node.configuration.get("right").unwrap_or(&Value::Null),
        trigger,
        outputs,
    )?;
    let operator = node
        .configuration
        .get("operator")
        .and_then(Value::as_str)
        .unwrap_or("equals");
    let result = match operator {
        "equals" => left == right,
        "not_equals" => left != right,
        "contains" => contains(&left, &right),
        "not_contains" => !contains(&left, &right),
        "greater_than" => numbers(&left, &right).is_some_and(|(a, b)| a > b),
        "less_than" => numbers(&left, &right).is_some_and(|(a, b)| a < b),
        "exists" => !left.is_null(),
        "not_exists" => left.is_null(),
        "starts_with" => strings(&left, &right).is_some_and(|(a, b)| a.starts_with(b)),
        "ends_with" => strings(&left, &right).is_some_and(|(a, b)| a.ends_with(b)),
        "is_null" => left.is_null(),
        "is_not_null" => !left.is_null(),
        "is_empty"
        | "is_not_empty"
        | "greater_than_or_equal"
        | "less_than_or_equal"
        | "matches_regex"
        | "is_one_of"
        | "is_not_one_of"
        | "array_contains"
        | "date_before"
        | "date_after"
        | "date_between" => crate::collection::evaluate_operator(
            operator,
            crate::collection::PathValue::Present(&left),
            &right,
        )?,
        _ => {
            return Err(EngineError::Node(format!(
                "Condition operator '{operator}' is not supported."
            )))
        }
    };
    let branch = if result { "true" } else { "false" }.to_string();
    Ok(
        NodeResult::new(json!({"result":result,"left":left,"right":right,"operator":operator}))
            .log(format!(
                "Condition evaluated to {result}; followed the {branch} branch."
            ))
            .with_branch(branch),
    )
}
fn contains(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::String(a), Value::String(b)) => a.contains(b),
        (Value::Array(a), b) => a.contains(b),
        _ => false,
    }
}

fn browser_session_id(
    selected_node_id: Option<&str>,
    outputs: &HashMap<String, Value>,
) -> Result<String, EngineError> {
    let candidates: Vec<_> = outputs
        .iter()
        .filter(|(node_id, _)| selected_node_id.is_none_or(|selected| selected == node_id.as_str()))
        .filter_map(|(_, output)| {
            output
                .get("browserSession")
                .and_then(|session| session.get("sessionId"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect();
    match candidates.as_slice() {
        [session_id] => Ok(session_id.clone()),
        [] => Err(EngineError::Node(
            "This browser node has no active upstream browser session. Connect it after Open Browser or another browser node.".into(),
        )),
        _ => Err(EngineError::Node(
            "Multiple browser sessions are available. Select the session source in this node's configuration.".into(),
        )),
    }
}

fn browser_diagnostics_from_output(output: &Value) -> Option<crate::BrowserDiagnostics> {
    if output.get("locatorAttempts").is_none() && output.get("currentUrl").is_none() {
        return None;
    }
    serde_json::from_value(json!({
        "currentUrl": output.get("currentUrl").cloned().unwrap_or_else(|| json!("")),
        "pageTitle": output.get("pageTitle").cloned().unwrap_or_else(|| json!("")),
        "locatorAttempts": output.get("locatorAttempts").cloned().unwrap_or_else(|| json!([])),
        "successfulLocator": output.get("successfulLocator").cloned().unwrap_or(Value::Null),
        "matchCount": output.get("matchCount").cloned().unwrap_or_else(|| json!(0)),
        "consoleErrors": output.get("consoleErrors").cloned().unwrap_or_else(|| json!([])),
        "failedNetworkRequests": output.get("failedNetworkRequests").cloned().unwrap_or_else(|| json!([])),
        "screenshotPath": if output.get("includedInHistory").and_then(Value::as_bool).unwrap_or(false) { output.get("path").cloned().unwrap_or(Value::Null) } else { Value::Null },
        "tracePath": output.get("tracePath").cloned().unwrap_or(Value::Null),
        "unexpectedNavigation": output.get("navigated").cloned().unwrap_or_else(|| json!(false)),
        "rerecordAvailable": true
    }))
    .ok()
}
fn strings<'a>(left: &'a Value, right: &'a Value) -> Option<(&'a str, &'a str)> {
    Some((left.as_str()?, right.as_str()?))
}
fn numbers(left: &Value, right: &Value) -> Option<(f64, f64)> {
    Some((left.as_f64()?, right.as_f64()?))
}

async fn resolved_text_source(
    config: &Value,
    workflow: &Workflow,
    node_name: &str,
) -> Result<(String, Option<PathBuf>), EngineError> {
    if let Some(content) = config
        .get("content")
        .and_then(Value::as_str)
        .filter(|content| !content.is_empty())
    {
        return Ok((content.to_string(), None));
    }
    let path = config
        .get("path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .ok_or_else(|| {
            EngineError::Node(format!(
                "{node_name} requires mapped content or an approved file path."
            ))
        })?;
    let path = require_path(Path::new(path), &workflow.settings.permissions)?;
    let metadata = tokio::fs::metadata(&path).await.map_err(|error| {
        EngineError::Node(format!(
            "{node_name} could not inspect '{}': {error}",
            path.display()
        ))
    })?;
    let maximum = config
        .get("maximumBytes")
        .and_then(Value::as_u64)
        .unwrap_or(10_485_760)
        .clamp(1, 104_857_600);
    if metadata.len() > maximum {
        return Err(EngineError::Node(format!(
            "{node_name} refused '{}' because it exceeds the configured {} byte limit.",
            path.display(),
            maximum
        )));
    }
    let bytes = tokio::fs::read(&path).await.map_err(|error| {
        EngineError::Node(format!(
            "{node_name} could not read '{}': {error}",
            path.display()
        ))
    })?;
    let text = String::from_utf8(bytes).map_err(|_| {
        EngineError::Node(format!(
            "{node_name} supports UTF-8 text files. '{}' is not valid UTF-8.",
            path.display()
        ))
    })?;
    Ok((text, Some(path)))
}

async fn execute_read_file(
    node: &WorkflowNode,
    workflow: &Workflow,
    trigger: &Value,
    outputs: &HashMap<String, Value>,
) -> Result<NodeResult, EngineError> {
    let config = resolve_value(&node.configuration, trigger, outputs)?;
    let (content, path) = resolved_text_source(&config, workflow, "Read File").await?;
    let path = path.ok_or_else(|| EngineError::Node("Read File requires a file path.".into()))?;
    let bytes = content.len();
    Ok(
        NodeResult::new(json!({"path":path,"content":content,"bytes":bytes}))
            .log(format!("Read {bytes} bytes from '{}'.", path.display())),
    )
}

async fn execute_write_file(
    node: &WorkflowNode,
    workflow: &Workflow,
    trigger: &Value,
    outputs: &HashMap<String, Value>,
) -> Result<NodeResult, EngineError> {
    let config = resolve_value(&node.configuration, trigger, outputs)?;
    let path = config
        .get("path")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| EngineError::Node("Write File requires a target path.".into()))?;
    let path = require_path(&path, &workflow.settings.permissions)?;
    let content = config
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| EngineError::Node("Write File requires text content.".into()))?;
    let overwrite = config
        .get("overwrite")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if path.exists() && !overwrite {
        return Err(EngineError::Node(format!(
            "Write File cannot overwrite '{}'. Enable overwrite or choose another path.",
            path.display()
        )));
    }
    if config
        .get("createParents")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|error| {
                EngineError::Node(format!(
                    "Write File could not create '{}': {error}",
                    parent.display()
                ))
            })?;
        }
    }
    tokio::fs::write(&path, content.as_bytes())
        .await
        .map_err(|error| {
            EngineError::Node(format!(
                "Write File could not write '{}': {error}",
                path.display()
            ))
        })?;
    Ok(
        NodeResult::new(json!({"path":path,"bytes":content.len()})).log(format!(
            "Wrote {} bytes to '{}'.",
            content.len(),
            path.display()
        )),
    )
}

async fn execute_copy_path(
    node: &WorkflowNode,
    workflow: &Workflow,
    trigger: &Value,
    outputs: &HashMap<String, Value>,
) -> Result<NodeResult, EngineError> {
    let config = resolve_value(&node.configuration, trigger, outputs)?;
    let source = config
        .get("source")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| EngineError::Node("Copy File or Folder requires a source.".into()))?;
    let destination = config
        .get("destination")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| EngineError::Node("Copy File or Folder requires a destination.".into()))?;
    let source = require_path(&source, &workflow.settings.permissions)?;
    let destination = require_path(&destination, &workflow.settings.permissions)?;
    let overwrite = config
        .get("overwrite")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if destination.exists() && !overwrite {
        return Err(EngineError::Node(format!(
            "Copy File or Folder cannot overwrite '{}'.",
            destination.display()
        )));
    }
    let source_for_copy = source.clone();
    let destination_for_copy = destination.clone();
    let copied = tokio::task::spawn_blocking(move || {
        copy_path_sync(&source_for_copy, &destination_for_copy, overwrite)
    })
    .await
    .map_err(|error| EngineError::Node(format!("Copy worker failed: {error}")))??;
    Ok(
        NodeResult::new(json!({"source":source,"destination":destination,"entries":copied}))
            .log(format!("Copied {copied} file system entries.")),
    )
}

fn copy_path_sync(source: &Path, destination: &Path, overwrite: bool) -> Result<u64, EngineError> {
    if source.is_file() {
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                EngineError::Node(format!("Could not create '{}': {error}", parent.display()))
            })?;
        }
        if destination.exists() && overwrite {
            if destination.is_dir() {
                std::fs::remove_dir_all(destination).map_err(|error| {
                    EngineError::Node(format!(
                        "Could not replace '{}': {error}",
                        destination.display()
                    ))
                })?;
            }
        }
        std::fs::copy(source, destination).map_err(|error| {
            EngineError::Node(format!(
                "Could not copy '{}' to '{}': {error}",
                source.display(),
                destination.display()
            ))
        })?;
        return Ok(1);
    }
    if !source.is_dir() {
        return Err(EngineError::Node(format!(
            "Copy source '{}' does not exist.",
            source.display()
        )));
    }
    if destination.exists() && overwrite {
        if destination.is_dir() {
            std::fs::remove_dir_all(destination).map_err(|error| {
                EngineError::Node(format!(
                    "Could not replace '{}': {error}",
                    destination.display()
                ))
            })?;
        } else {
            std::fs::remove_file(destination).map_err(|error| {
                EngineError::Node(format!(
                    "Could not replace '{}': {error}",
                    destination.display()
                ))
            })?;
        }
    }
    std::fs::create_dir_all(destination).map_err(|error| {
        EngineError::Node(format!(
            "Could not create '{}': {error}",
            destination.display()
        ))
    })?;
    let mut copied = 1;
    for entry in std::fs::read_dir(source).map_err(|error| {
        EngineError::Node(format!("Could not list '{}': {error}", source.display()))
    })? {
        let entry = entry.map_err(|error| EngineError::Node(error.to_string()))?;
        copied += copy_path_sync(
            &entry.path(),
            &destination.join(entry.file_name()),
            overwrite,
        )?;
    }
    Ok(copied)
}

async fn execute_delete_path(
    node: &WorkflowNode,
    workflow: &Workflow,
    trigger: &Value,
    outputs: &HashMap<String, Value>,
) -> Result<NodeResult, EngineError> {
    let config = resolve_value(&node.configuration, trigger, outputs)?;
    let path = config
        .get("path")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| EngineError::Node("Delete File or Folder requires a path.".into()))?;
    let path = require_path(&path, &workflow.settings.permissions)?;
    if path.is_dir() {
        if !config
            .get("recursive")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return Err(EngineError::Node(
                "Deleting a folder requires the recursive option.".into(),
            ));
        }
        tokio::fs::remove_dir_all(&path).await.map_err(|error| {
            EngineError::Node(format!("Could not delete '{}': {error}", path.display()))
        })?;
    } else {
        tokio::fs::remove_file(&path).await.map_err(|error| {
            EngineError::Node(format!("Could not delete '{}': {error}", path.display()))
        })?;
    }
    Ok(NodeResult::new(json!({"path":path,"deleted":true}))
        .log(format!("Deleted '{}'.", path.display())))
}

async fn execute_list_folder(
    node: &WorkflowNode,
    workflow: &Workflow,
    trigger: &Value,
    outputs: &HashMap<String, Value>,
) -> Result<NodeResult, EngineError> {
    let config = resolve_value(&node.configuration, trigger, outputs)?;
    let folder = config
        .get("folder")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| EngineError::Node("List Folder requires a folder.".into()))?;
    let folder = require_path(&folder, &workflow.settings.permissions)?;
    if !folder.is_dir() {
        return Err(EngineError::Node(format!(
            "List Folder expected '{}' to be a folder.",
            folder.display()
        )));
    }
    let recursive = config
        .get("recursive")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let pattern = config
        .get("pattern")
        .and_then(Value::as_str)
        .unwrap_or("*")
        .to_string();
    let root = folder.clone();
    let entries = tokio::task::spawn_blocking(move || list_folder_sync(&root, recursive, &pattern))
        .await
        .map_err(|error| EngineError::Node(format!("Folder listing worker failed: {error}")))??;
    Ok(
        NodeResult::new(json!({"folder":folder,"count":entries.len(),"entries":entries}))
            .log(format!("Listed {} matching entries.", entries.len())),
    )
}

fn list_folder_sync(
    folder: &Path,
    recursive: bool,
    pattern: &str,
) -> Result<Vec<Value>, EngineError> {
    let matcher = globset::Glob::new(pattern)
        .map_err(|error| EngineError::Node(format!("Folder pattern is invalid: {error}")))?
        .compile_matcher();
    let mut pending = vec![folder.to_path_buf()];
    let mut entries = Vec::new();
    while let Some(current) = pending.pop() {
        for entry in std::fs::read_dir(&current).map_err(|error| {
            EngineError::Node(format!("Could not list '{}': {error}", current.display()))
        })? {
            let entry = entry.map_err(|error| EngineError::Node(error.to_string()))?;
            let path = entry.path();
            let metadata = entry
                .metadata()
                .map_err(|error| EngineError::Node(error.to_string()))?;
            let relative = path.strip_prefix(folder).unwrap_or(&path);
            if matcher.is_match(relative) || matcher.is_match(entry.file_name()) {
                entries.push(json!({
                    "name":entry.file_name().to_string_lossy(),
                    "path":path,
                    "relativePath":relative,
                    "isDirectory":metadata.is_dir(),
                    "bytes":if metadata.is_file(){Some(metadata.len())}else{None},
                }));
            }
            if recursive && metadata.is_dir() {
                pending.push(path);
            }
            if entries.len() >= 10_000 {
                return Err(EngineError::Node(
                    "List Folder exceeded the 10,000 entry safety limit.".into(),
                ));
            }
        }
    }
    entries.sort_by(|left, right| {
        left["relativePath"]
            .as_str()
            .cmp(&right["relativePath"].as_str())
    });
    Ok(entries)
}

async fn execute_parse_csv(
    node: &WorkflowNode,
    workflow: &Workflow,
    trigger: &Value,
    outputs: &HashMap<String, Value>,
) -> Result<NodeResult, EngineError> {
    let config = resolve_value(&node.configuration, trigger, outputs)?;
    let (content, path) = resolved_text_source(&config, workflow, "Parse CSV").await?;
    let delimiter_text = config
        .get("delimiter")
        .and_then(Value::as_str)
        .unwrap_or(",");
    let mut delimiter_chars = delimiter_text.chars();
    let delimiter = delimiter_chars
        .next()
        .filter(|_| delimiter_chars.next().is_none())
        .ok_or_else(|| EngineError::Node("CSV delimiter must be one character.".into()))?;
    let trim = config.get("trim").and_then(Value::as_bool).unwrap_or(true);
    let mut records = parse_csv_records(&content, delimiter, trim)?;
    let has_headers = config
        .get("hasHeaders")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let headers = if has_headers && !records.is_empty() {
        unique_headers(records.remove(0))
    } else {
        vec![]
    };
    let rows: Vec<Value> = if has_headers {
        records
            .into_iter()
            .map(|record| {
                Value::Object(
                    headers
                        .iter()
                        .enumerate()
                        .map(|(index, header)| {
                            (
                                header.clone(),
                                Value::String(record.get(index).cloned().unwrap_or_default()),
                            )
                        })
                        .collect(),
                )
            })
            .collect()
    } else {
        records.into_iter().map(|record| json!(record)).collect()
    };
    Ok(
        NodeResult::new(json!({"path":path,"headers":headers,"rows":rows,"rowCount":rows.len()}))
            .log(format!("Parsed {} CSV data rows.", rows.len())),
    )
}

fn parse_csv_records(
    content: &str,
    delimiter: char,
    trim: bool,
) -> Result<Vec<Vec<String>>, EngineError> {
    let mut records = Vec::new();
    let mut record = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut characters = content.chars().peekable();
    while let Some(character) = characters.next() {
        match character {
            '"' if quoted && characters.peek() == Some(&'"') => {
                field.push('"');
                characters.next();
            }
            '"' => quoted = !quoted,
            value if value == delimiter && !quoted => {
                record.push(if trim {
                    field.trim().to_string()
                } else {
                    std::mem::take(&mut field)
                });
                field.clear();
            }
            '\n' if !quoted => {
                record.push(if trim {
                    field.trim().to_string()
                } else {
                    std::mem::take(&mut field)
                });
                field.clear();
                if record.iter().any(|value| !value.is_empty()) {
                    records.push(std::mem::take(&mut record));
                } else {
                    record.clear();
                }
            }
            '\r' if !quoted && characters.peek() == Some(&'\n') => {}
            value => field.push(value),
        }
    }
    if quoted {
        return Err(EngineError::Node(
            "CSV input ended inside a quoted field.".into(),
        ));
    }
    if !field.is_empty() || !record.is_empty() {
        record.push(if trim {
            field.trim().to_string()
        } else {
            field
        });
        records.push(record);
    }
    Ok(records)
}

fn unique_headers(headers: Vec<String>) -> Vec<String> {
    let mut counts = HashMap::<String, usize>::new();
    headers
        .into_iter()
        .enumerate()
        .map(|(index, header)| {
            let base = if header.trim().is_empty() {
                format!("column_{}", index + 1)
            } else {
                header
            };
            let count = counts.entry(base.clone()).or_insert(0);
            *count += 1;
            if *count == 1 {
                base
            } else {
                format!("{base}_{}", *count)
            }
        })
        .collect()
}

async fn execute_parse_json(
    node: &WorkflowNode,
    workflow: &Workflow,
    trigger: &Value,
    outputs: &HashMap<String, Value>,
) -> Result<NodeResult, EngineError> {
    let config = resolve_value(&node.configuration, trigger, outputs)?;
    let (content, path) = resolved_text_source(&config, workflow, "Parse JSON").await?;
    let value: Value = serde_json::from_str(&content)
        .map_err(|error| EngineError::Node(format!("JSON input is invalid: {error}")))?;
    Ok(NodeResult::new(json!({"path":path,"value":value})).log("Parsed JSON input."))
}

async fn execute_parse_text(
    node: &WorkflowNode,
    workflow: &Workflow,
    trigger: &Value,
    outputs: &HashMap<String, Value>,
) -> Result<NodeResult, EngineError> {
    let config = resolve_value(&node.configuration, trigger, outputs)?;
    let (mut content, path) = resolved_text_source(&config, workflow, "Parse Text").await?;
    if config.get("trim").and_then(Value::as_bool).unwrap_or(true) {
        content = content.trim().to_string();
    }
    let remove_empty = config
        .get("removeEmptyLines")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let lines: Vec<String> = content
        .lines()
        .filter(|line| !remove_empty || !line.trim().is_empty())
        .map(str::to_string)
        .collect();
    Ok(NodeResult::new(json!({"path":path,"text":content,"lines":lines,"lineCount":lines.len(),"characterCount":content.chars().count()}))
        .log(format!("Parsed {} lines of text.", lines.len())))
}

async fn execute_move(
    node: &WorkflowNode,
    workflow: &Workflow,
    trigger: &Value,
    outputs: &HashMap<String, Value>,
) -> Result<NodeResult, EngineError> {
    let config = resolve_value(&node.configuration, trigger, outputs)?;
    let source = PathBuf::from(
        config
            .get("source")
            .and_then(Value::as_str)
            .ok_or_else(|| EngineError::Node("Move File requires a source path.".into()))?,
    );
    let destination = PathBuf::from(
        config
            .get("destinationFolder")
            .and_then(Value::as_str)
            .ok_or_else(|| EngineError::Node("Move File requires a destination folder.".into()))?,
    );
    let source = require_path(&source, &workflow.settings.permissions)?;
    let destination = require_path(&destination, &workflow.settings.permissions)?;
    let name = config
        .get("renameTo")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| source.file_name().map(|s| s.to_string_lossy().to_string()))
        .ok_or_else(|| EngineError::Node("Move File could not determine the file name.".into()))?;
    let target = destination.join(name);
    require_path(&target, &workflow.settings.permissions)?;
    if target.exists()
        && !config
            .get("overwrite")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        return Err(EngineError::Node(format!(
            "Move File cannot overwrite '{}'. Enable overwrite or choose another name.",
            target.display()
        )));
    }
    if target.exists() {
        tokio::fs::remove_file(&target).await.map_err(|e| {
            EngineError::Node(format!(
                "Move File could not replace '{}': {e}",
                target.display()
            ))
        })?;
    }
    tokio::fs::rename(&source, &target).await.map_err(|e| {
        EngineError::Node(format!(
            "Move File could not move '{}' to '{}': {e}",
            source.display(),
            target.display()
        ))
    })?;
    Ok(
        NodeResult::new(json!({"source":source,"destination":target})).log(format!(
            "Moved '{}' to '{}'.",
            source.display(),
            target.display()
        )),
    )
}

async fn execute_command(
    node: &WorkflowNode,
    workflow: &Workflow,
    trigger: &Value,
    outputs: &HashMap<String, Value>,
    cancellation: CancellationToken,
) -> Result<NodeResult, EngineError> {
    if !workflow.settings.permissions.command_execution_permitted
        || workflow.settings.permissions.approval_revision.is_none()
    {
        return Err(EngineError::Permission(
            "Run Command requires approval before it can run in the background.".into(),
        ));
    }
    let config = resolve_value(&node.configuration, trigger, outputs)?;
    let executable = config
        .get("executable")
        .and_then(Value::as_str)
        .ok_or_else(|| EngineError::Node("Run Command requires an executable.".into()))?;
    let args: Vec<String> = config
        .get("arguments")
        .and_then(Value::as_array)
        .map(|v| {
            v.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let mut command = Command::new(executable);
    command
        .args(&args)
        .kill_on_drop(true)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = config
        .get("workingDirectory")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        command.current_dir(require_path(
            Path::new(dir),
            &workflow.settings.permissions,
        )?);
    }
    let mut child = command.spawn().map_err(|e| {
        EngineError::Node(format!("Run Command could not start '{executable}': {e}"))
    })?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let stdout_task = tokio::spawn(read_bounded(stdout));
    let stderr_task = tokio::spawn(read_bounded(stderr));
    let output = tokio::select! { _=cancellation.cancelled()=>{ let _=child.kill().await; return Err(EngineError::Cancelled); }, status=child.wait()=>status.map_err(|e|EngineError::Node(format!("Run Command could not wait for '{executable}': {e}")))? };
    let out = stdout_task.await.unwrap_or_default();
    let err = stderr_task.await.unwrap_or_default();
    let stdout = String::from_utf8_lossy(&out).to_string();
    let stderr = String::from_utf8_lossy(&err).to_string();
    if !output.success() {
        return Err(EngineError::Node(format!(
            "Run Command exited with code {}. {}",
            output
                .code()
                .map(|v| v.to_string())
                .unwrap_or_else(|| "unknown".into()),
            bounded_log(&stderr)
        )));
    }
    Ok(
        NodeResult::new(json!({"exitCode":output.code(),"stdout":stdout,"stderr":stderr})).log(
            format!("Executed '{}' with {} argument(s).", executable, args.len()),
        ),
    )
}

async fn read_bounded<R: tokio::io::AsyncRead + Unpin>(mut reader: R) -> Vec<u8> {
    read_bounded_to(&mut reader, 65_536).await
}

async fn read_bounded_to<R: tokio::io::AsyncRead + Unpin>(
    mut reader: R,
    maximum: usize,
) -> Vec<u8> {
    let mut kept = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                let remaining = maximum.saturating_sub(kept.len());
                kept.extend_from_slice(&chunk[..count.min(remaining)]);
            }
        }
    }
    kept
}

fn mark_node(node: &mut NodeExecution, status: NodeStatus, reason: &str) {
    let now = Utc::now();
    node.status = status;
    node.completed_at = Some(now);
    node.duration_ms = Some(0);
    node.skip_reason = Some(reason.into());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Position, WorkflowEdge, WorkflowSettings};
    use serde_json::json;
    use wiremock::{
        matchers::{method, path},
        Mock, MockServer, ResponseTemplate,
    };
    struct TestHost(Arc<std::sync::Mutex<Vec<String>>>);
    #[async_trait]
    impl HostServices for TestHost {
        async fn desktop_notification(
            &self,
            title: &str,
            message: &str,
        ) -> Result<(), EngineError> {
            self.0.lock().unwrap().push(format!("{title}:{message}"));
            Ok(())
        }
    }
    struct FlakyIntegrationHost(std::sync::atomic::AtomicUsize);
    #[async_trait]
    impl HostServices for FlakyIntegrationHost {
        async fn desktop_notification(
            &self,
            _title: &str,
            _message: &str,
        ) -> Result<(), EngineError> {
            Ok(())
        }
        async fn integration_operation(
            &self,
            _operation: &str,
            _payload: Value,
        ) -> Result<Value, EngineError> {
            if self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                Err(EngineError::Node("transient test failure".into()))
            } else {
                Ok(json!({"message":"ok"}))
            }
        }
    }
    struct AiTestHost;
    #[async_trait]
    impl HostServices for AiTestHost {
        async fn desktop_notification(
            &self,
            _title: &str,
            _message: &str,
        ) -> Result<(), EngineError> {
            Ok(())
        }

        async fn ai_operation(&self, payload: Value) -> Result<Value, EngineError> {
            assert_eq!(payload["prompt"], "Summarise the uptime result");
            Ok(
                json!({"response":"All services are healthy.","model":"test-model","usage":{"total_tokens":12}}),
            )
        }
    }
    struct PluginDispatchHost(Arc<std::sync::Mutex<Vec<Value>>>);
    #[async_trait]
    impl HostServices for PluginDispatchHost {
        async fn desktop_notification(
            &self,
            _title: &str,
            _message: &str,
        ) -> Result<(), EngineError> {
            Ok(())
        }

        async fn plugin_operation(
            &self,
            _workflow: &Workflow,
            node: &WorkflowNode,
            execution_id: &str,
            input: Value,
            _cancellation: CancellationToken,
        ) -> Result<PluginHostResult, EngineError> {
            self.0
                .lock()
                .unwrap()
                .push(json!({"configuration":node.configuration,"input":input,"executionId":execution_id}));
            Ok(PluginHostResult {
                output: json!({"dispatched":true}),
                diagnostics: vec!["sandbox: isolated".into()],
            })
        }
    }
    fn node(id: &str, node_type: &str, config: Value) -> WorkflowNode {
        WorkflowNode {
            id: id.into(),
            node_type: node_type.into(),
            version: 1,
            name: id.replace('_', " "),
            position: Position { x: 0., y: 0. },
            configuration: config,
            disabled: false,
            input_bindings: Default::default(),
            plugin: None,
            customization: None,
            error_policy: None,
        }
    }
    fn edge(id: &str, s: &str, handle: &str, t: &str) -> WorkflowEdge {
        WorkflowEdge {
            id: id.into(),
            source_node_id: s.into(),
            source_handle: handle.into(),
            target_node_id: t.into(),
            target_handle: "input".into(),
            kind: "control".into(),
            source_port: Some(handle.into()),
            target_port: Some("input".into()),
        }
    }
    fn base(nodes: Vec<WorkflowNode>, edges: Vec<WorkflowEdge>) -> Workflow {
        let now = Utc::now();
        Workflow {
            id: Uuid::new_v4().to_string(),
            schema_version: crate::model::CURRENT_SCHEMA_VERSION,
            owner: Default::default(),
            name: "Test".into(),
            description: "".into(),
            enabled: true,
            trigger_node_id: "trigger".into(),
            nodes,
            edges,
            settings: WorkflowSettings {
                permissions: crate::PermissionSummary {
                    approved_network_domains: vec!["127.0.0.1".into()],
                    ..Default::default()
                },
                ..Default::default()
            },
            created_at: now,
            updated_at: now,
        }
    }
    #[tokio::test]
    async fn condition_follows_true_and_skips_false() {
        let host = Arc::new(TestHost(Arc::new(std::sync::Mutex::new(vec![]))));
        let engine = Engine::new(Database::in_memory().unwrap(), host);
        let wf = base(
            vec![
                node("trigger", "manual_trigger", json!({})),
                node(
                    "condition",
                    "condition",
                    json!({"left":5,"operator":"greater_than","right":2}),
                ),
                node("yes", "set_data", json!({"values":{"path":"yes"}})),
                node("no", "set_data", json!({"values":{"path":"no"}})),
            ],
            vec![
                edge("a", "trigger", "output", "condition"),
                edge("b", "condition", "true", "yes"),
                edge("c", "condition", "false", "no"),
            ],
        );
        engine.database().save_workflow(wf.clone()).unwrap();
        let run = engine
            .run(wf, json!({}), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(run.status, ExecutionStatus::Successful);
        assert_eq!(
            run.node_executions
                .iter()
                .find(|n| n.node_id == "yes")
                .unwrap()
                .status,
            NodeStatus::Successful
        );
        assert_eq!(
            run.node_executions
                .iter()
                .find(|n| n.node_id == "no")
                .unwrap()
                .status,
            NodeStatus::Skipped
        );
    }

    #[tokio::test]
    async fn loop_runs_body_per_item_and_collects_done_results() {
        let host = Arc::new(TestHost(Arc::new(std::sync::Mutex::new(vec![]))));
        let engine = Engine::new(Database::in_memory().unwrap(), host);
        let wf = base(
            vec![
                node("trigger", "manual_trigger", json!({})),
                node(
                    "seed",
                    "set_data",
                    json!({"values":{"items":[{"id":1},{"id":2},{"id":3}]}}),
                ),
                node(
                    "loop",
                    "loop_over_items",
                    json!({"batchSize":1,"concurrency":2,"maxIterations":10,"failurePolicy":"stop","perItemTimeoutMs":5000}),
                ),
                node("body", "aggregate", json!({"operation":"count"})),
                node("done", "aggregate", json!({"operation":"count"})),
            ],
            vec![
                edge("a", "trigger", "output", "seed"),
                edge("b", "seed", "output", "loop"),
                edge("c", "loop", "loop", "body"),
                edge("d", "loop", "done", "done"),
            ],
        );
        engine.database().save_workflow(wf.clone()).unwrap();
        let run = engine
            .run(wf, json!({}), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(run.status, ExecutionStatus::Successful);
        let loop_run = run
            .node_executions
            .iter()
            .find(|entry| entry.node_id == "loop")
            .unwrap();
        assert_eq!(loop_run.collection.as_ref().unwrap().iteration_count, 3);
        assert_eq!(loop_run.collection.as_ref().unwrap().output_item_count, 3);
        let body_run = run
            .node_executions
            .iter()
            .find(|entry| entry.node_id == "body")
            .unwrap();
        assert_eq!(body_run.collection.as_ref().unwrap().iteration_count, 3);
        let done_run = run
            .node_executions
            .iter()
            .find(|entry| entry.node_id == "done")
            .unwrap();
        assert_eq!(done_run.output.get("value"), Some(&json!(3)));
    }

    #[tokio::test]
    async fn loop_handles_or_stops_item_failures_by_policy() {
        let engine = Engine::new(
            Database::in_memory().unwrap(),
            Arc::new(TestHost(Arc::new(std::sync::Mutex::new(vec![])))),
        );
        let make = |policy: &str| {
            base(
                vec![
                    node("trigger", "manual_trigger", json!({})),
                    node(
                        "seed",
                        "set_data",
                        json!({"values":{"items":[{"id":1},{"id":2}]}}),
                    ),
                    node(
                        "loop",
                        "loop_over_items",
                        json!({"batchSize":1,"concurrency":1,"maxIterations":5,"failurePolicy":policy}),
                    ),
                    node(
                        "body",
                        "split_out",
                        json!({"fieldPath":"missing","invalidInputPolicy":"fail"}),
                    ),
                    node("done", "aggregate", json!({"operation":"count"})),
                ],
                vec![
                    edge("a", "trigger", "output", "seed"),
                    edge("b", "seed", "output", "loop"),
                    edge("c", "loop", "loop", "body"),
                    edge("d", "loop", "done", "done"),
                ],
            )
        };
        let continued = make("continue_handled");
        engine.database().save_workflow(continued.clone()).unwrap();
        let run = engine
            .run(continued, json!({}), CancellationToken::new())
            .await
            .unwrap();
        let looped = run
            .node_executions
            .iter()
            .find(|entry| entry.node_id == "loop")
            .unwrap();
        assert_eq!(run.status, ExecutionStatus::Successful);
        assert_eq!(looped.collection.as_ref().unwrap().rejected_item_count, 2);
        assert_eq!(
            looped.collection.as_ref().unwrap().stop_reason.as_deref(),
            Some("completed_with_handled_failures")
        );
        let stopped = make("stop");
        engine.database().save_workflow(stopped.clone()).unwrap();
        let run = engine
            .run(stopped, json!({}), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(run.status, ExecutionStatus::Failed);
        assert!(run
            .node_executions
            .iter()
            .find(|entry| entry.node_id == "loop")
            .unwrap()
            .error
            .as_ref()
            .unwrap()
            .message
            .contains("iteration 0"));
    }

    #[tokio::test]
    async fn loop_cancellation_reaches_the_active_iteration() {
        let engine = Engine::new(
            Database::in_memory().unwrap(),
            Arc::new(TestHost(Arc::new(std::sync::Mutex::new(vec![])))),
        );
        let wf = base(
            vec![
                node("trigger", "manual_trigger", json!({})),
                node("seed", "set_data", json!({"values":{"items":[1,2]}})),
                node(
                    "loop",
                    "loop_over_items",
                    json!({"batchSize":1,"concurrency":1,"maxIterations":5}),
                ),
                node("body", "delay", json!({"amount":2,"unit":"seconds"})),
                node("done", "aggregate", json!({"operation":"count"})),
            ],
            vec![
                edge("a", "trigger", "output", "seed"),
                edge("b", "seed", "output", "loop"),
                edge("c", "loop", "loop", "body"),
                edge("d", "loop", "done", "done"),
            ],
        );
        engine.database().save_workflow(wf.clone()).unwrap();
        let cancellation = CancellationToken::new();
        let cancel = cancellation.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            cancel.cancel();
        });
        let run = engine.run(wf, json!({}), cancellation).await.unwrap();
        assert_eq!(run.status, ExecutionStatus::Cancelled);
        assert_eq!(
            run.node_executions
                .iter()
                .find(|entry| entry.node_id == "loop")
                .unwrap()
                .status,
            NodeStatus::Cancelled
        );
    }

    #[tokio::test]
    async fn loop_retries_one_iteration_with_stable_checkpoint_identity() {
        let engine = Engine::new(
            Database::in_memory().unwrap(),
            Arc::new(FlakyIntegrationHost(std::sync::atomic::AtomicUsize::new(0))),
        );
        let wf = base(
            vec![
                node("trigger", "manual_trigger", json!({})),
                node("seed", "set_data", json!({"values":{"items":[{"id":1}]}})),
                node(
                    "loop",
                    "loop_over_items",
                    json!({"batchSize":1,"concurrency":1,"maxIterations":2,"iterationRetryCount":1}),
                ),
                node(
                    "body",
                    "gmail_get_email",
                    json!({"credentialId":"connection","messageId":"message"}),
                ),
                node("done", "aggregate", json!({"operation":"count"})),
            ],
            vec![
                edge("a", "trigger", "output", "seed"),
                edge("b", "seed", "output", "loop"),
                edge("c", "loop", "loop", "body"),
                edge("d", "loop", "done", "done"),
            ],
        );
        engine.database().save_workflow(wf.clone()).unwrap();
        let run = engine
            .run(wf, json!({}), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(run.status, ExecutionStatus::Successful);
        let body = run
            .node_executions
            .iter()
            .find(|entry| entry.node_id == "body")
            .unwrap();
        assert_eq!(body.retry_count, 1);
        let checkpoints = engine
            .database()
            .loop_iteration_checkpoints(&run.id, "loop")
            .unwrap();
        assert_eq!(checkpoints.len(), 1);
        assert_eq!(checkpoints[0].0, "00000000");
        assert_eq!(checkpoints[0].1, 2);
        assert_eq!(checkpoints[0].2, "completed");
    }

    #[tokio::test]
    async fn collection_node_tests_use_pinned_and_named_inputs_without_committing_them() {
        let engine = Engine::new(
            Database::in_memory().unwrap(),
            Arc::new(TestHost(Arc::new(std::sync::Mutex::new(vec![])))),
        );
        let wf = base(
            vec![
                node("trigger", "manual_trigger", json!({})),
                node(
                    "filter",
                    "filter",
                    json!({"rules":[{"field":"active","operator":"equals","value":true}],"pinnedData":[{"active":true},{"active":false}]}),
                ),
                node(
                    "merge",
                    "merge",
                    json!({"mode":"append","inputPorts":[{"id":"left"},{"id":"right"}],"pinnedData":{"left":[{"id":1}],"right":[{"id":2}]}}),
                ),
            ],
            vec![],
        );
        engine.database().save_workflow(wf.clone()).unwrap();
        let filtered = engine
            .test_node(
                wf.clone(),
                "filter",
                json!({}),
                None,
                false,
                CancellationToken::new(),
            )
            .await
            .unwrap();
        let filter_run = &filtered.node_executions[0];
        assert_eq!(filter_run.collection.as_ref().unwrap().input_item_count, 2);
        assert_eq!(filter_run.collection.as_ref().unwrap().output_item_count, 1);
        assert_eq!(filter_run.test_data_source.as_deref(), Some("pinned_data"));
        let merged = engine
            .test_node(
                wf,
                "merge",
                json!({}),
                None,
                false,
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(
            merged.node_executions[0]
                .collection
                .as_ref()
                .unwrap()
                .branch_counts
                .get("left"),
            Some(&1)
        );
        assert_eq!(
            merged.node_executions[0]
                .collection
                .as_ref()
                .unwrap()
                .branch_counts
                .get("right"),
            Some(&1)
        );
    }

    #[tokio::test]
    async fn loop_node_test_requires_confirmation_for_a_side_effecting_body() {
        let engine = Engine::new(
            Database::in_memory().unwrap(),
            Arc::new(TestHost(Arc::new(std::sync::Mutex::new(vec![])))),
        );
        let wf = base(
            vec![
                node("trigger", "manual_trigger", json!({})),
                node(
                    "loop",
                    "loop_over_items",
                    json!({"pinnedData":[{"id":1}],"batchSize":1,"maxIterations":2}),
                ),
                node(
                    "state",
                    "set_workflow_state",
                    json!({"key":"seen","value":true}),
                ),
                node("done", "aggregate", json!({"operation":"count"})),
            ],
            vec![
                edge("a", "loop", "loop", "state"),
                edge("b", "loop", "done", "done"),
            ],
        );
        engine.database().save_workflow(wf.clone()).unwrap();
        let error = engine
            .test_node(wf, "loop", json!({}), None, false, CancellationToken::new())
            .await
            .unwrap_err();
        assert_eq!(error.execution_error().code, "permission_required");
    }

    #[tokio::test]
    async fn merge_treats_skipped_branch_by_explicit_policy_not_arrival() {
        let engine = Engine::new(
            Database::in_memory().unwrap(),
            Arc::new(TestHost(Arc::new(std::sync::Mutex::new(vec![])))),
        );
        let mut left = edge("d", "left", "output", "merge");
        left.target_handle = "input_a".into();
        left.target_port = Some("input_a".into());
        let mut right = edge("e", "right", "output", "merge");
        right.target_handle = "input_b".into();
        right.target_port = Some("input_b".into());
        let wf = base(
            vec![
                node("trigger", "manual_trigger", json!({})),
                node(
                    "route",
                    "condition",
                    json!({"left":false,"operator":"equals","right":true}),
                ),
                node("left", "set_data", json!({"values":{"side":"left"}})),
                node("right", "set_data", json!({"values":{"side":"right"}})),
                node(
                    "merge",
                    "merge",
                    json!({"mode":"append","inputPorts":[{"id":"input_a"},{"id":"input_b"}],"skippedInputPolicy":"empty","failedInputPolicy":"fail"}),
                ),
            ],
            vec![
                edge("a", "trigger", "output", "route"),
                edge("b", "route", "true", "left"),
                edge("c", "route", "false", "right"),
                left,
                right,
            ],
        );
        engine.database().save_workflow(wf.clone()).unwrap();
        let run = engine
            .run(wf, json!({}), CancellationToken::new())
            .await
            .unwrap();
        let merged = run
            .node_executions
            .iter()
            .find(|entry| entry.node_id == "merge")
            .unwrap();
        assert_eq!(merged.status, NodeStatus::Successful);
        assert_eq!(
            merged
                .collection
                .as_ref()
                .unwrap()
                .branch_counts
                .get("input_a"),
            Some(&0)
        );
        assert_eq!(
            merged
                .collection
                .as_ref()
                .unwrap()
                .branch_counts
                .get("input_b"),
            Some(&1)
        );
    }

    #[tokio::test]
    async fn cross_run_deduplication_commits_only_after_complete_success() {
        let engine = Engine::new(
            Database::in_memory().unwrap(),
            Arc::new(TestHost(Arc::new(std::sync::Mutex::new(vec![])))),
        );
        let mut wf = base(
            vec![
                node("trigger", "manual_trigger", json!({})),
                node(
                    "seed",
                    "set_data",
                    json!({"values":{"items":[{"email":"a@example.com"}]}}),
                ),
                node(
                    "dedupe",
                    "remove_duplicates",
                    json!({"fields":["email"],"scope":"workflow_state"}),
                ),
                node(
                    "fail",
                    "run_command",
                    json!({"executable":"definitely-not-used"}),
                ),
            ],
            vec![
                edge("a", "trigger", "output", "seed"),
                edge("b", "seed", "output", "dedupe"),
                edge("c", "dedupe", "output", "fail"),
            ],
        );
        engine.database().save_workflow(wf.clone()).unwrap();
        let failed = engine
            .run(wf.clone(), json!({}), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(failed.status, ExecutionStatus::Failed);
        assert!(engine
            .database()
            .get_workflow_state(&wf.id, "__stage2_dedupe:dedupe")
            .unwrap()
            .is_none());
        wf.nodes.retain(|node| node.id != "fail");
        wf.edges.retain(|edge| edge.target_node_id != "fail");
        let first = engine
            .run(wf.clone(), json!({}), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(first.status, ExecutionStatus::Successful);
        assert!(engine
            .database()
            .get_workflow_state(&wf.id, "__stage2_dedupe:dedupe")
            .unwrap()
            .is_some());
        let second = engine
            .run(wf, json!({}), CancellationToken::new())
            .await
            .unwrap();
        let dedupe = second
            .node_executions
            .iter()
            .find(|entry| entry.node_id == "dedupe")
            .unwrap();
        assert_eq!(dedupe.collection.as_ref().unwrap().output_item_count, 0);
        assert_eq!(dedupe.collection.as_ref().unwrap().rejected_item_count, 1);
    }

    #[tokio::test]
    async fn collection_nodes_execute_end_to_end_through_the_real_scheduler() {
        let engine = Engine::new(
            Database::in_memory().unwrap(),
            Arc::new(TestHost(Arc::new(std::sync::Mutex::new(vec![])))),
        );
        let mut ready_merge = edge("h", "ready_count", "output", "merge");
        ready_merge.target_handle = "input_a".into();
        ready_merge.target_port = Some("input_a".into());
        let mut other_merge = edge("i", "other_count", "output", "merge");
        other_merge.target_handle = "input_b".into();
        other_merge.target_port = Some("input_b".into());
        let wf = base(
            vec![
                node("trigger", "manual_trigger", json!({})),
                node(
                    "seed",
                    "set_data",
                    json!({"values":{"records":[{"email":"A@example.com","active":true,"status":"ready"},{"email":"a@example.com","active":true,"status":"ready"},{"email":"b@example.com","active":true,"status":"other"},{"email":"c@example.com","active":false,"status":"ready"}]}}),
                ),
                node(
                    "split",
                    "split_out",
                    json!({"fieldPath":"records","destinationField":"row","keepParentFields":false}),
                ),
                node(
                    "filter",
                    "filter",
                    json!({"rules":[{"field":"row.active","operator":"equals","value":true}]}),
                ),
                node(
                    "dedupe",
                    "remove_duplicates",
                    json!({"fields":["row.email"],"caseSensitive":false}),
                ),
                node(
                    "switch",
                    "switch",
                    json!({"routingMode":"value","valuePath":"row.status","cases":[{"id":"ready","name":"Ready","value":"ready"}],"fallbackBranchId":"other","mode":"first_match"}),
                ),
                node("ready_count", "aggregate", json!({"operation":"count"})),
                node("other_count", "aggregate", json!({"operation":"count"})),
                node(
                    "merge",
                    "merge",
                    json!({"mode":"append","inputPorts":[{"id":"input_a"},{"id":"input_b"}],"skippedInputPolicy":"empty","failedInputPolicy":"fail"}),
                ),
                node("final", "aggregate", json!({"operation":"count"})),
            ],
            vec![
                edge("a", "trigger", "output", "seed"),
                edge("b", "seed", "output", "split"),
                edge("c", "split", "output", "filter"),
                edge("d", "filter", "output", "dedupe"),
                edge("e", "dedupe", "output", "switch"),
                edge("f", "switch", "ready", "ready_count"),
                edge("g", "switch", "other", "other_count"),
                ready_merge,
                other_merge,
                edge("j", "merge", "output", "final"),
            ],
        );
        engine.database().save_workflow(wf.clone()).unwrap();
        let run = engine
            .run(wf, json!({}), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(run.status, ExecutionStatus::Successful);
        let evidence = |id: &str| {
            run.node_executions
                .iter()
                .find(|entry| entry.node_id == id)
                .unwrap()
                .collection
                .as_ref()
                .unwrap()
        };
        assert_eq!(evidence("split").output_item_count, 4);
        assert_eq!(evidence("filter").output_item_count, 3);
        assert_eq!(evidence("dedupe").output_item_count, 2);
        assert_eq!(evidence("switch").branch_counts.get("ready"), Some(&1));
        assert_eq!(evidence("switch").branch_counts.get("other"), Some(&1));
        assert_eq!(evidence("merge").output_item_count, 2);
        assert_eq!(
            run.node_executions
                .iter()
                .find(|entry| entry.node_id == "final")
                .unwrap()
                .output["value"],
            json!(2)
        );
    }

    #[tokio::test]
    async fn plugin_nodes_resolve_input_and_dispatch_only_through_host() {
        let calls = Arc::new(std::sync::Mutex::new(vec![]));
        let engine = Engine::new(
            Database::in_memory().unwrap(),
            Arc::new(PluginDispatchHost(calls.clone())),
        );
        let mut plugin = node(
            "plugin",
            "example.echo",
            json!({"label":"{{trigger.label}}"}),
        );
        plugin.plugin = Some(crate::PluginNodePin {
            plugin_id: "com.example.echo".into(),
            plugin_version: "1.0.0".into(),
            package_integrity: format!("sha256:{}", "a".repeat(64)),
            publisher_id: "com.example".into(),
            input: json!({"value":"{{trigger.value}}"}),
            credential_references: Default::default(),
        });
        let workflow = base(
            vec![node("trigger", "manual_trigger", json!({})), plugin.clone()],
            vec![edge("plugin-edge", "trigger", "output", "plugin")],
        );
        let result = engine
            .execute_node(
                &plugin,
                &workflow,
                "run-plugin",
                &json!({"label":"resolved","value":42}),
                &HashMap::new(),
                &HashMap::new(),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(result.output["dispatched"], true);
        assert!(result.logs.iter().any(|log| log.contains("sandbox")));
        assert_eq!(
            calls.lock().unwrap()[0]["configuration"]["label"],
            "resolved"
        );
        assert_eq!(calls.lock().unwrap()[0]["input"]["value"], 42);
    }

    #[tokio::test]
    async fn ai_node_awaits_and_returns_host_response() {
        let engine = Engine::new(Database::in_memory().unwrap(), Arc::new(AiTestHost));
        let ai = node(
            "ai",
            "ai_prompt",
            json!({"connectionId":"connection-1234","prompt":"Summarise the uptime result","timeoutMs":1000}),
        );
        let workflow = base(
            vec![node("trigger", "manual_trigger", json!({})), ai.clone()],
            vec![],
        );
        let result = engine
            .execute_node(
                &ai,
                &workflow,
                "run-ai",
                &json!({}),
                &HashMap::new(),
                &HashMap::new(),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(result.output["response"], "All services are healthy.");
        assert_eq!(result.output["usage"]["total_tokens"], 12);
    }

    #[tokio::test]
    async fn code_source_is_available_to_downstream_nodes_without_execution() {
        let engine = Engine::new(Database::in_memory().unwrap(), Arc::new(LocalHost));
        let code = node(
            "code",
            "code",
            json!({"language":"javascript","sourceCode":"document.body.dataset.ready = 'true';","executionMode":"source"}),
        );
        let workflow = base(
            vec![node("trigger", "manual_trigger", json!({})), code.clone()],
            vec![],
        );
        let result = engine
            .execute_node(
                &code,
                &workflow,
                "run-code",
                &json!({}),
                &HashMap::new(),
                &HashMap::new(),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(result.output["language"], "javascript");
        assert_eq!(
            result.output["code"],
            "document.body.dataset.ready = 'true';"
        );
    }

    fn executable_available(name: &str) -> bool {
        std::process::Command::new(name)
            .arg("--version")
            .output()
            .is_ok()
    }

    #[tokio::test]
    async fn javascript_code_uses_items_logs_and_restricted_host_access() {
        if !executable_available("node") {
            return;
        }
        let engine = Engine::new(Database::in_memory().unwrap(), Arc::new(LocalHost));
        let code = node(
            "js",
            "javascript_code",
            json!({"language":"javascript","sourceCode":"console.log('count', items.length); console.log('x'.repeat(70000)); return items.map(item => ({value:item.data.value * 2}));","executionMode":"run","itemMode":"all_items","runtimeVersion":">=20","input":{"items":[{"data":{"value":2}},{"data":{"value":4}}]},"timeoutMs":20000}),
        );
        let mut workflow = base(
            vec![node("trigger", "manual_trigger", json!({})), code.clone()],
            vec![],
        );
        workflow.settings.permissions.command_execution_permitted = true;
        workflow.settings.permissions.approval_revision = Some("approved".into());
        let result = engine
            .execute_node(
                &code,
                &workflow,
                "run-js",
                &json!({}),
                &HashMap::new(),
                &HashMap::new(),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(result.output["items"][0]["data"]["value"], 4);
        assert!(result.logs.iter().any(|line| line.contains("count 2")));
        assert!(result
            .logs
            .iter()
            .any(|line| line.contains("logs truncated")));
        let escape = node(
            "escape",
            "javascript_code",
            json!({"language":"javascript","sourceCode":"return process.env;","executionMode":"run","runtimeVersion":">=20","timeoutMs":5000}),
        );
        assert!(engine
            .execute_node(
                &escape,
                &workflow,
                "run-escape",
                &json!({}),
                &HashMap::new(),
                &HashMap::new(),
                CancellationToken::new()
            )
            .await
            .is_err());
    }

    #[tokio::test]
    async fn python_code_uses_the_same_item_contract_and_blocks_files() {
        if !executable_available("python") {
            return;
        }
        let engine = Engine::new(Database::in_memory().unwrap(), Arc::new(LocalHost));
        let code = node(
            "py",
            "python_code",
            json!({"language":"python","sourceCode":"print('received', len(items))\nresult = [{'value': item['data']['value'] + 1} for item in items]","executionMode":"run","itemMode":"all_items","runtimeVersion":">=3.11","input":{"items":[{"data":{"value":1}},{"data":{"value":2}}]},"timeoutMs":20000}),
        );
        let mut workflow = base(
            vec![node("trigger", "manual_trigger", json!({})), code.clone()],
            vec![],
        );
        workflow.settings.permissions.command_execution_permitted = true;
        workflow.settings.permissions.approval_revision = Some("approved".into());
        let result = engine
            .execute_node(
                &code,
                &workflow,
                "run-py",
                &json!({}),
                &HashMap::new(),
                &HashMap::new(),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(result.output["items"][1]["data"]["value"], 3);
        assert!(result.logs.iter().any(|line| line.contains("received 2")));
        let escape = node(
            "escape",
            "python_code",
            json!({"language":"python","sourceCode":"result = open('secret.txt').read()","executionMode":"run","runtimeVersion":">=3.11","timeoutMs":5000}),
        );
        assert!(engine
            .execute_node(
                &escape,
                &workflow,
                "run-escape",
                &json!({}),
                &HashMap::new(),
                &HashMap::new(),
                CancellationToken::new()
            )
            .await
            .is_err());
    }

    #[tokio::test]
    async fn code_timeout_and_pinned_manual_data_are_recorded() {
        if !executable_available("node") {
            return;
        }
        let engine = Engine::new(Database::in_memory().unwrap(), Arc::new(LocalHost));
        let timeout = node(
            "timeout",
            "javascript_code",
            json!({"language":"javascript","sourceCode":"while(true) {}","executionMode":"run","runtimeVersion":">=20","timeoutMs":100}),
        );
        let mut workflow = base(
            vec![
                node("trigger", "manual_trigger", json!({})),
                timeout.clone(),
            ],
            vec![],
        );
        workflow.settings.permissions.command_execution_permitted = true;
        workflow.settings.permissions.approval_revision = Some("approved".into());
        let error = engine
            .execute_node(
                &timeout,
                &workflow,
                "run-timeout",
                &json!({}),
                &HashMap::new(),
                &HashMap::new(),
                CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("timeout"));
        let pinned = node(
            "pinned",
            "javascript_code",
            json!({"language":"javascript","sourceCode":"return items.map(item => item.data);","executionMode":"run","runtimeVersion":">=20","pinnedData":[{"answer":42}],"timeoutMs":20000}),
        );
        assert_eq!(
            fixture_items(&json!([{"answer":42}]))[0].data,
            json!({"answer":42})
        );
        workflow.nodes = vec![node("trigger", "manual_trigger", json!({})), pinned.clone()];
        engine.database().save_workflow(workflow.clone()).unwrap();
        let record = engine
            .test_node(
                workflow,
                "pinned",
                json!({}),
                None,
                true,
                CancellationToken::new(),
            )
            .await
            .unwrap();
        let execution = &record.node_executions[0];
        assert_eq!(execution.test_data_source.as_deref(), Some("pinned_data"));
        assert_eq!(
            execution.output_items[0].data,
            json!({"answer":42}),
            "{execution:#?}"
        );
    }

    #[tokio::test]
    async fn web_builder_serves_combined_sources_on_loopback() {
        let engine = Engine::new(Database::in_memory().unwrap(), Arc::new(LocalHost));
        let builder = node(
            "builder",
            "web_builder",
            json!({
                "html":"<main id=\"status\">Uptime</main>",
                "javascript":"document.querySelector('#status').dataset.ready = 'true';",
                "css":"#status { color: green; }",
                "port":0,
                "openBrowser":false
            }),
        );
        let workflow = base(
            vec![
                node("trigger", "manual_trigger", json!({})),
                builder.clone(),
            ],
            vec![],
        );
        let result = engine
            .execute_node(
                &builder,
                &workflow,
                "run-builder",
                &json!({}),
                &HashMap::new(),
                &HashMap::new(),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        let url = result.output["url"].as_str().unwrap();
        assert!(url.starts_with("http://127.0.0.1:"));
        let page = reqwest::get(url).await.unwrap().text().await.unwrap();
        assert!(page.contains("Uptime"));
        assert!(page.contains("#status { color: green; }"));
        assert!(page.contains("document.querySelector"));
    }
    #[tokio::test]
    async fn condition_follows_false_branch() {
        let engine = Engine::new(Database::in_memory().unwrap(), Arc::new(LocalHost));
        let wf = base(
            vec![
                node("trigger", "manual_trigger", json!({})),
                node(
                    "condition",
                    "condition",
                    json!({"left":1,"operator":"greater_than","right":2}),
                ),
                node("yes", "set_data", json!({"values":{"path":"yes"}})),
                node("no", "set_data", json!({"values":{"path":"no"}})),
            ],
            vec![
                edge("a", "trigger", "output", "condition"),
                edge("b", "condition", "true", "yes"),
                edge("c", "condition", "false", "no"),
            ],
        );
        engine.database().save_workflow(wf.clone()).unwrap();
        let run = engine
            .run(wf, json!({}), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(
            run.node_executions
                .iter()
                .find(|n| n.node_id == "yes")
                .unwrap()
                .status,
            NodeStatus::Skipped
        );
        assert_eq!(
            run.node_executions
                .iter()
                .find(|n| n.node_id == "no")
                .unwrap()
                .status,
            NodeStatus::Successful
        );
    }
    #[tokio::test]
    async fn failed_node_skips_dependents_and_keeps_diagnostics() {
        let engine = Engine::new(Database::in_memory().unwrap(), Arc::new(LocalHost));
        let mut wf = base(
            vec![
                node("trigger", "manual_trigger", json!({})),
                node(
                    "http",
                    "http_request",
                    json!({"method":"GET","url":"https://not-approved.example","timeoutMs":1000}),
                ),
                node("after", "set_data", json!({"values":{"ok":true}})),
            ],
            vec![
                edge("a", "trigger", "output", "http"),
                edge("b", "http", "output", "after"),
            ],
        );
        wf.settings.permissions.approved_network_domains.clear();
        engine.database().save_workflow(wf.clone()).unwrap();
        let run = engine
            .run(wf, json!({}), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(run.status, ExecutionStatus::Failed);
        assert_eq!(
            run.node_executions
                .iter()
                .find(|n| n.node_id == "http")
                .unwrap()
                .status,
            NodeStatus::Failed
        );
        let skipped = run
            .node_executions
            .iter()
            .find(|n| n.node_id == "after")
            .unwrap();
        assert_eq!(skipped.status, NodeStatus::Skipped);
        assert!(skipped
            .skip_reason
            .as_deref()
            .unwrap()
            .contains("Dependency"));
    }
    #[tokio::test]
    async fn full_manual_http_condition_notification_vertical_slice() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/health"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"service":"up"})))
            .mount(&server)
            .await;
        let delivered = Arc::new(std::sync::Mutex::new(vec![]));
        let engine = Engine::new(
            Database::in_memory().unwrap(),
            Arc::new(TestHost(delivered.clone())),
        );
        let wf = base(
            vec![
                node("trigger", "manual_trigger", json!({})),
                node(
                    "http",
                    "http_request",
                    json!({"method":"GET","url":format!("{}/health",server.uri()),"timeoutMs":3000}),
                ),
                node(
                    "condition",
                    "condition",
                    json!({"left":"{{nodes.http.output.status}}","operator":"equals","right":200}),
                ),
                node(
                    "notify",
                    "desktop_notification",
                    json!({"title":"Healthy","message":"Status {{nodes.http.output.status}}"}),
                ),
            ],
            vec![
                edge("a", "trigger", "output", "http"),
                edge("b", "http", "output", "condition"),
                edge("c", "condition", "true", "notify"),
            ],
        );
        engine.database().save_workflow(wf.clone()).unwrap();
        let run = engine
            .run(wf, json!({"type":"manual"}), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(run.status, ExecutionStatus::Successful);
        assert_eq!(run.node_executions.len(), 4);
        assert_eq!(delivered.lock().unwrap().as_slice(), ["Healthy:Status 200"]);
    }
    #[tokio::test]
    async fn cancellation_marks_delay() {
        let engine = Engine::new(Database::in_memory().unwrap(), Arc::new(LocalHost));
        let wf = base(
            vec![
                node("trigger", "manual_trigger", json!({})),
                node("delay", "delay", json!({"amount":10,"unit":"seconds"})),
            ],
            vec![edge("a", "trigger", "output", "delay")],
        );
        engine.database().save_workflow(wf.clone()).unwrap();
        let token = CancellationToken::new();
        let cancel = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            cancel.cancel();
        });
        let run = engine.run(wf, json!({}), token).await.unwrap();
        assert_eq!(run.status, ExecutionStatus::Cancelled);
    }
    #[tokio::test]
    async fn node_timeout_is_recorded() {
        let engine = Engine::new(Database::in_memory().unwrap(), Arc::new(LocalHost));
        let mut wf = base(
            vec![
                node("trigger", "manual_trigger", json!({})),
                node(
                    "delay",
                    "delay",
                    json!({"amount":1,"unit":"seconds","timeoutMs":100}),
                ),
            ],
            vec![edge("a", "trigger", "output", "delay")],
        );
        wf.settings.default_node_timeout_ms = 100;
        engine.database().save_workflow(wf.clone()).unwrap();
        let run = engine
            .run(wf, json!({}), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(run.status, ExecutionStatus::Failed);
        assert!(run.error.unwrap().message.contains("timeout"));
    }

    #[tokio::test]
    async fn retries_only_the_failed_node_with_recorded_inputs() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.txt");
        let destination = directory.path().join("moved");
        std::fs::write(&source, "retry me").unwrap();
        std::fs::create_dir(&destination).unwrap();
        let engine = Engine::new(Database::in_memory().unwrap(), Arc::new(LocalHost));
        let mut wf = base(
            vec![
                node("trigger", "manual_trigger", json!({})),
                node(
                    "move",
                    "move_file",
                    json!({
                        "source": source,
                        "destinationFolder": destination,
                        "overwrite": false
                    }),
                ),
            ],
            vec![edge("a", "trigger", "output", "move")],
        );
        wf.settings.permissions.approved_folders.clear();
        engine.database().save_workflow(wf.clone()).unwrap();
        let first = engine
            .run(
                wf.clone(),
                json!({"type":"manual"}),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(first.status, ExecutionStatus::Failed);

        wf.settings.permissions.approved_folders =
            vec![directory.path().to_string_lossy().to_string()];
        engine.database().save_workflow(wf).unwrap();
        let retried = engine
            .retry_failed_node(&first.id, "move", CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(retried.status, ExecutionStatus::Successful);
        assert_eq!(retried.node_executions.len(), 1);
        assert_eq!(retried.node_executions[0].retry_count, 1);
        assert!(destination.join("source.txt").exists());
    }
}
