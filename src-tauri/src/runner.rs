use crate::AppState;
use chrono::{DateTime, Utc};
use notify::{EventKind, RecursiveMode, Watcher};
use sandbox_engine::{schedule::next_run, Workflow};
use serde_json::json;
use std::{
    collections::{hash_map::Entry, HashSet},
    path::Path,
    sync::{atomic::Ordering, Arc},
    time::Duration,
};
use tauri::{
    menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    App, AppHandle, Emitter, Manager,
};
use tokio_util::sync::CancellationToken;

pub fn create_tray(app: &mut App, state: &AppState) -> tauri::Result<()> {
    let open = MenuItemBuilder::with_id("open", "Open sndbox").build(app)?;
    let approvals = MenuItemBuilder::with_id("approvals", "Pending Approvals").build(app)?;
    let pause = CheckMenuItemBuilder::with_id("pause", "Pause Automations").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[&open, &approvals, &pause, &quit])
        .build()?;
    let paused = state.paused.clone();
    let pause_control = pause.clone();
    let quitting = state.quitting.clone();
    let mut builder = TrayIconBuilder::with_id("runner")
        .menu(&menu)
        .tooltip("sndbox runner · Active")
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "open" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "approvals" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = app.emit("navigate", "approvals");
                }
            }
            "pause" => {
                let next = !paused.load(Ordering::SeqCst);
                paused.store(next, Ordering::SeqCst);
                let _ = pause_control.set_checked(next);
                let _ = app.emit("runner-status-changed", json!({"paused":next}));
                if let Some(tray) = app.tray_by_id("runner") {
                    let _ = tray.set_tooltip(Some(if next {
                        "sndbox runner · Paused"
                    } else {
                        "sndbox runner · Active"
                    }));
                }
            }
            "quit" => {
                quitting.store(true, Ordering::SeqCst);
                app.exit(0);
            }
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

pub fn start_background_services(app: AppHandle, state: &AppState) {
    let retention_engine = state.engine.clone();
    let artifact_root = state.data_dir.join("artifacts");
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60 * 60));
        loop {
            interval.tick().await;
            let Ok(paths) = retention_engine
                .database()
                .take_expired_browser_artifacts(Utc::now())
            else {
                continue;
            };
            for path in paths {
                let candidate = std::path::PathBuf::from(path);
                if candidate.is_file() && candidate.starts_with(&artifact_root) {
                    let _ = tokio::fs::remove_file(candidate).await;
                }
            }
        }
    });
    let engine = state.engine.clone();
    let paused = state.paused.clone();
    let cancellations = state.cancellations.clone();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(15));
        loop {
            interval.tick().await;
            if paused.load(Ordering::SeqCst) {
                continue;
            }
            for (workflow, scheduled_at) in due_schedule_workflows(&engine, Utc::now()) {
                spawn_run(
                    engine.clone(),
                    cancellations.clone(),
                    workflow,
                    json!({"type":"schedule","scheduledAt":scheduled_at}),
                );
            }
        }
    });
    let gmail_engine = state.engine.clone();
    let gmail_paused = state.paused.clone();
    let gmail_cancellations = state.cancellations.clone();
    let gmail_vault = state.credential_vault.clone();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        loop {
            interval.tick().await;
            if gmail_paused.load(Ordering::SeqCst) {
                continue;
            }
            let Ok(workflows) = gmail_engine.database().list_workflows() else {
                continue;
            };
            for summary in workflows {
                let workflow = summary.workflow;
                if !workflow.enabled
                    || !workflow.settings.permissions.background_execution_permitted
                {
                    continue;
                }
                let Some(trigger) = workflow.nodes.iter().find(|node| {
                    node.id == workflow.trigger_node_id
                        && node.node_type == "gmail_new_email_trigger"
                }) else {
                    continue;
                };
                let poll_minutes = trigger
                    .configuration
                    .get("pollIntervalMinutes")
                    .and_then(|value| value.as_i64())
                    .unwrap_or(5)
                    .clamp(1, 60);
                let last = gmail_engine
                    .database()
                    .get_last_integration_poll(&workflow.id)
                    .ok()
                    .flatten();
                if last.is_some_and(|value| {
                    Utc::now() - value < chrono::Duration::minutes(poll_minutes)
                }) {
                    continue;
                }
                let _ = gmail_engine
                    .database()
                    .set_last_integration_poll(&workflow.id, Utc::now());
                if let Ok(messages) = crate::integrations::poll_gmail(
                    &workflow.id,
                    &trigger.configuration,
                    gmail_engine.database(),
                    gmail_vault.clone(),
                )
                .await
                {
                    for message in messages {
                        spawn_run(
                            gmail_engine.clone(),
                            gmail_cancellations.clone(),
                            workflow.clone(),
                            json!({"type":"gmail_new_email","email":message}),
                        );
                    }
                }
            }
        }
    });
    let provider_engine = state.engine.clone();
    let provider_paused = state.paused.clone();
    let provider_cancellations = state.cancellations.clone();
    let provider_adapter = state.provider_adapter.clone();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(15));
        loop {
            interval.tick().await;
            if provider_paused.load(Ordering::SeqCst) {
                continue;
            }
            let Ok(workflows) = provider_engine.database().list_workflows() else {
                continue;
            };
            for summary in workflows {
                let workflow = summary.workflow;
                if !workflow.enabled
                    || !workflow.settings.permissions.background_execution_permitted
                {
                    continue;
                }
                let Some(trigger) = workflow
                    .nodes
                    .iter()
                    .find(|node| node.id == workflow.trigger_node_id)
                else {
                    continue;
                };
                let Some(provider) = polling_provider(&trigger.node_type) else {
                    continue;
                };
                let Some(connection_id) = trigger
                    .configuration
                    .get("connectionId")
                    .and_then(serde_json::Value::as_str)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
                else {
                    continue;
                };
                let plugin_id = trigger
                    .plugin
                    .as_ref()
                    .map(|pin| pin.plugin_id.clone())
                    .unwrap_or_else(|| format!("com.sndbox.{provider}"));
                let plugin_version = trigger
                    .plugin
                    .as_ref()
                    .map(|pin| pin.plugin_version.clone())
                    .unwrap_or_else(|| "1.0.0".into());
                let state = provider_engine
                    .database()
                    .poll_cursor(
                        &workflow.id,
                        &trigger.id,
                        "desktop",
                        &connection_id,
                        &plugin_id,
                        &plugin_version,
                    )
                    .ok()
                    .flatten();
                if state
                    .as_ref()
                    .and_then(|(_, _, next, _)| *next)
                    .is_some_and(|next| next > Utc::now())
                {
                    continue;
                }
                let baseline_complete = state.as_ref().is_some_and(|(_, baseline, _, _)| *baseline);
                let cursor = state
                    .as_ref()
                    .map(|(cursor, _, _, _)| cursor.clone())
                    .filter(|value| !value.is_null());
                let failures = state.as_ref().map_or(0, |(_, _, _, failures)| *failures);
                let poll_seconds = trigger
                    .configuration
                    .get("pollIntervalSeconds")
                    .and_then(serde_json::Value::as_i64)
                    .unwrap_or(if trigger.node_type == "github.workflow_run_completed" {
                        90
                    } else {
                        120
                    })
                    .clamp(60, 300);
                let next_poll = Utc::now() + chrono::Duration::seconds(poll_seconds);
                let adapter = provider_adapter.clone();
                let operation = trigger.node_type.clone();
                let config = trigger.configuration.clone();
                let credential = connection_id.clone();
                let batch = tauri::async_runtime::spawn_blocking(move || {
                    adapter.poll(&credential, provider, &operation, &config, cursor.as_ref())
                })
                .await;
                let Ok(batch) = batch else {
                    continue;
                };
                match batch {
                    Ok(batch) => {
                        let accepted = provider_engine
                            .database()
                            .save_poll_checkpoint(
                                &workflow.id,
                                &trigger.id,
                                "desktop",
                                &connection_id,
                                &plugin_id,
                                &plugin_version,
                                &batch.cursor,
                                true,
                                next_poll,
                                &batch.event_keys,
                            )
                            .unwrap_or_default()
                            .into_iter()
                            .collect::<HashSet<_>>();
                        if baseline_complete {
                            for (event, key) in batch.events.into_iter().zip(batch.event_keys) {
                                if accepted.contains(&key) {
                                    spawn_run(
                                        provider_engine.clone(),
                                        provider_cancellations.clone(),
                                        workflow.clone(),
                                        json!({"type":trigger.node_type,"event":event,"polledAt":Utc::now()}),
                                    );
                                }
                            }
                        }
                    }
                    Err(error) => {
                        let message = error.to_string();
                        let _ = provider_engine.database().save_poll_failure(
                            &workflow.id,
                            &trigger.id,
                            "desktop",
                            &connection_id,
                            &plugin_id,
                            &plugin_version,
                            Utc::now() + provider_backoff(&message, failures),
                            &message,
                        );
                    }
                }
            }
        }
    });
    start_file_watch_service(app, state);
}

fn polling_provider(node_type: &str) -> Option<&'static str> {
    match node_type {
        "google.calendar.event_changed"
        | "google.drive.file_changed"
        | "google.sheets.row_added" => Some("google_workspace"),
        "slack.channel_message_posted" => Some("slack_oauth"),
        "notion.data_source_page_changed" => Some("notion"),
        "github.issue_or_pull_request_changed" | "github.workflow_run_completed" => {
            Some("github_app")
        }
        _ => None,
    }
}

fn provider_backoff(message: &str, prior_failures: u32) -> chrono::Duration {
    if let Some(seconds) = message
        .split("retry after ")
        .nth(1)
        .and_then(|value| {
            value
                .split(|character: char| !character.is_ascii_digit())
                .next()
        })
        .and_then(|value| value.parse::<i64>().ok())
    {
        return chrono::Duration::seconds(seconds.clamp(1, 3_600));
    }
    let exponential = 60_i64.saturating_mul(1_i64 << prior_failures.min(4));
    let jitter = i64::from(Utc::now().timestamp_subsec_millis() % 17);
    chrono::Duration::seconds((exponential + jitter).min(900))
}

fn due_schedule_workflows(
    engine: &sandbox_engine::Engine,
    now: DateTime<Utc>,
) -> Vec<(Workflow, DateTime<Utc>)> {
    let Ok(workflows) = engine.database().list_workflows() else {
        return vec![];
    };
    workflows
        .into_iter()
        .filter_map(|summary| {
            let workflow = summary.workflow;
            if !workflow.enabled || !workflow.settings.permissions.background_execution_permitted {
                return None;
            }
            let trigger = workflow
                .nodes
                .iter()
                .find(|node| node.id == workflow.trigger_node_id)?;
            if trigger.node_type != "schedule_trigger" || trigger.disabled {
                return None;
            }
            let next_at = summary
                .next_run_at
                .or_else(|| next_run(trigger, now).ok())?;
            if summary.next_run_at.is_none() {
                let _ = engine.database().set_next_run(&workflow.id, Some(next_at));
            }
            if next_at > now {
                return None;
            }
            let next_after = next_run(trigger, now).ok();
            let _ = engine.database().set_next_run(&workflow.id, next_after);
            Some((workflow, next_at))
        })
        .collect()
}

fn spawn_run(
    engine: sandbox_engine::Engine,
    cancellations: Arc<parking_lot::Mutex<std::collections::HashMap<String, CancellationToken>>>,
    workflow: Workflow,
    trigger: serde_json::Value,
) {
    tauri::async_runtime::spawn(async move {
        let token = CancellationToken::new();
        let id = workflow.id.clone();
        let owns_token = {
            let mut active = cancellations.lock();
            match active.entry(id.clone()) {
                Entry::Vacant(entry) => {
                    entry.insert(token.clone());
                    true
                }
                Entry::Occupied(_) => false,
            }
        };
        let _ = engine.run(workflow, trigger, token).await;
        if owns_token {
            cancellations.lock().remove(&id);
        }
    });
}

fn start_file_watch_service(_app: AppHandle, state: &AppState) {
    let engine = state.engine.clone();
    let paused = state.paused.clone();
    let cancellations = state.cancellations.clone();
    std::thread::spawn(move || {
        let mut watchers: Vec<notify::RecommendedWatcher> = Vec::new();
        loop {
            watchers.clear();
            if !paused.load(Ordering::SeqCst) {
                if let Ok(workflows) = engine.database().list_workflows() {
                    for summary in workflows {
                        let workflow = summary.workflow;
                        if !workflow.enabled
                            || !workflow.settings.permissions.background_execution_permitted
                        {
                            continue;
                        }
                        let Some(trigger_node) = workflow.nodes.iter().find(|n| {
                            n.id == workflow.trigger_node_id && n.node_type == "file_watch_trigger"
                        }) else {
                            continue;
                        };
                        let Some(folder) = trigger_node
                            .configuration
                            .get("folder")
                            .and_then(|v| v.as_str())
                        else {
                            continue;
                        };
                        if folder.is_empty()
                            || !workflow
                                .settings
                                .permissions
                                .approved_folders
                                .iter()
                                .any(|p| Path::new(folder).starts_with(p))
                        {
                            continue;
                        }
                        let wf = workflow.clone();
                        let engine2 = engine.clone();
                        let cancel2 = cancellations.clone();
                        let events = trigger_node
                            .configuration
                            .get("events")
                            .and_then(|v| v.as_array())
                            .cloned()
                            .unwrap_or_default();
                        let pattern = trigger_node
                            .configuration
                            .get("pattern")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        if let Ok(mut watcher) = notify::recommended_watcher(
                            move |result: notify::Result<notify::Event>| {
                                if let Ok(event) = result {
                                    let event_type = match event.kind {
                                        EventKind::Create(_) => "created",
                                        EventKind::Modify(_) => "modified",
                                        EventKind::Remove(_) => "deleted",
                                        _ => return,
                                    };
                                    if !events.is_empty()
                                        && !events.iter().any(|v| v.as_str() == Some(event_type))
                                    {
                                        return;
                                    }
                                    for path in event.paths {
                                        let filename = path
                                            .file_name()
                                            .map(|v| v.to_string_lossy().to_string())
                                            .unwrap_or_default();
                                        if !pattern.is_empty() && !glob_match(&pattern, &filename) {
                                            continue;
                                        }
                                        let trigger = json!({"type":"file_watch","path":path,"filename":filename,"extension":path.extension().map(|v|v.to_string_lossy().to_string()),"eventType":event_type,"timestamp":Utc::now()});
                                        spawn_run(
                                            engine2.clone(),
                                            cancel2.clone(),
                                            wf.clone(),
                                            trigger,
                                        );
                                    }
                                }
                            },
                        ) {
                            if watcher
                                .watch(Path::new(folder), RecursiveMode::NonRecursive)
                                .is_ok()
                            {
                                watchers.push(watcher);
                            }
                        }
                    }
                }
            }
            std::thread::sleep(Duration::from_secs(30));
        }
    });
}
fn glob_match(pattern: &str, name: &str) -> bool {
    globset::Glob::new(pattern)
        .ok()
        .map(|g| g.compile_matcher().is_match(name))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::templates;
    use chrono::Duration as ChronoDuration;
    use sandbox_engine::{Database, Engine, LocalHost};

    #[test]
    fn due_schedule_tick_advances_state_and_returns_workflow() {
        let engine = Engine::new(Database::in_memory().unwrap(), Arc::new(LocalHost));
        let mut workflow = templates::by_key("blank", Some("Scheduled".into()));
        workflow.enabled = true;
        workflow.settings.permissions.background_execution_permitted = true;
        workflow.nodes[0].node_type = "schedule_trigger".into();
        workflow.nodes[0].configuration = json!({"scheduleType":"minutes","every":5});
        engine.database().save_workflow(workflow.clone()).unwrap();
        let now = Utc::now();
        engine
            .database()
            .set_next_run(&workflow.id, Some(now - ChronoDuration::seconds(1)))
            .unwrap();

        let due = due_schedule_workflows(&engine, now);
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].0.id, workflow.id);
        assert!(engine
            .database()
            .get_next_run(&workflow.id)
            .unwrap()
            .is_some_and(|next| next > now));
    }
}
