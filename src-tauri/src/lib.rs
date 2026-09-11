mod account_auth;
mod ai_builder;
mod browser_sidecar;
mod bundled_plugins;
mod collaboration;
mod commands;
mod credential_vault;
mod integrations;
mod marketplace;
mod oauth;
mod plugin_manager;
mod provider_adapter;
pub mod remote_runner;
mod runner;
mod sync_crypto;
mod templates;

use async_trait::async_trait;
use browser_sidecar::BrowserSidecar;
use credential_vault::{CredentialVault, OsCredentialVault};
use parking_lot::Mutex;
use sandbox_engine::{
    BrowserDiagnostics, Database, Engine, EngineError, HostServices, PendingApproval,
    PluginHostResult, Workflow, WorkflowNode,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::{Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_global_shortcut::ShortcutState;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tokio_util::sync::CancellationToken;

pub struct TauriHost {
    app: tauri::AppHandle,
    database: Database,
    browser_sidecar: BrowserSidecar,
    data_dir: std::path::PathBuf,
    credential_vault: Arc<dyn CredentialVault>,
    plugin_manager: plugin_manager::PluginManager,
}
#[async_trait]
impl HostServices for TauriHost {
    async fn desktop_notification(&self, title: &str, message: &str) -> Result<(), EngineError> {
        self.app
            .notification()
            .builder()
            .title(title)
            .body(message)
            .show()
            .map_err(|error| {
                EngineError::Node(format!(
                    "Desktop Notification could not be delivered: {error}"
                ))
            })
    }

    async fn browser_operation(
        &self,
        operation: &str,
        mut payload: Value,
    ) -> Result<Value, EngineError> {
        let object = payload.as_object_mut().ok_or_else(|| {
            EngineError::Node("Browser operation payload must be an object.".into())
        })?;
        if operation == "open_browser" {
            let profile_id = object
                .get("profileId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    EngineError::Node("Open Browser requires a browser profile.".into())
                })?;
            let mut profile = self
                .database
                .get_browser_profile(profile_id)?
                .ok_or_else(|| {
                    EngineError::Node("The selected browser profile no longer exists.".into())
                })?;
            object.insert(
                "profilePath".into(),
                Value::String(profile.data_path.clone()),
            );
            object
                .entry("persistent")
                .or_insert(Value::Bool(profile.persistent));
            object.entry("viewport").or_insert(json!({"width":profile.settings.viewport_width,"height":profile.settings.viewport_height}));
            if let Some(user_agent) = profile.settings.user_agent.clone() {
                object
                    .entry("userAgent")
                    .or_insert(Value::String(user_agent));
            }
            if let Some(proxy) = profile.settings.proxy.clone() {
                object.entry("proxy").or_insert(Value::String(proxy));
            }
            profile.last_used_at = Some(chrono::Utc::now());
            self.database.save_browser_profile(&profile)?;
        }
        let workflow = object
            .get("workflowId")
            .and_then(Value::as_str)
            .unwrap_or("manual");
        let node = object
            .get("nodeId")
            .and_then(Value::as_str)
            .unwrap_or(operation);
        let diagnostic_directory = self
            .data_dir
            .join("artifacts")
            .join("browser")
            .join(workflow)
            .join(node);
        object.entry("diagnosticDirectory").or_insert(Value::String(
            diagnostic_directory.to_string_lossy().to_string(),
        ));
        if operation == "open_browser" && !object.contains_key("tracePath") {
            let trace = diagnostic_directory.join(format!("trace-{}.zip", uuid::Uuid::new_v4()));
            object.insert(
                "tracePath".into(),
                Value::String(trace.to_string_lossy().to_string()),
            );
        }
        if operation == "screenshot" && !object.contains_key("outputPath") {
            let output =
                diagnostic_directory.join(format!("screenshot-{}.png", uuid::Uuid::new_v4()));
            object.insert(
                "outputPath".into(),
                Value::String(output.to_string_lossy().to_string()),
            );
        }
        self.browser_sidecar
            .request(operation, payload)
            .await
            .map_err(|encoded| {
                let parsed: Value =
                    serde_json::from_str(&encoded).unwrap_or_else(|_| json!({"message":encoded}));
                let message = parsed
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("The managed browser operation failed.")
                    .to_string();
                let diagnostics = parsed
                    .get("details")
                    .cloned()
                    .and_then(|value| serde_json::from_value::<BrowserDiagnostics>(value).ok());
                EngineError::Browser {
                    message,
                    diagnostics,
                }
            })
    }

    async fn integration_operation(
        &self,
        operation: &str,
        payload: Value,
    ) -> Result<Value, EngineError> {
        integrations::execute(
            operation,
            payload,
            &self.database,
            self.credential_vault.clone(),
        )
        .await
        .map_err(EngineError::Node)
    }

    async fn ai_operation(&self, payload: Value) -> Result<Value, EngineError> {
        ai_builder::run_ai_prompt(&self.database, self.credential_vault.clone(), payload)
            .await
            .map_err(EngineError::Node)
    }

    async fn open_local_url(&self, url: &str) -> Result<(), EngineError> {
        self.app
            .opener()
            .open_url(url, None::<&str>)
            .map_err(|error| {
                EngineError::Node(format!("The local site could not be opened: {error}"))
            })
    }

    async fn plugin_operation(
        &self,
        workflow: &Workflow,
        node: &WorkflowNode,
        execution_id: &str,
        input: Value,
        cancellation: CancellationToken,
    ) -> Result<PluginHostResult, EngineError> {
        struct CancelOnDrop(Arc<std::sync::atomic::AtomicBool>);
        impl Drop for CancelOnDrop {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }

        let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let _cancel_on_drop = CancelOnDrop(cancelled.clone());
        let monitor_flag = cancelled.clone();
        let monitor = tauri::async_runtime::spawn(async move {
            cancellation.cancelled().await;
            monitor_flag.store(true, Ordering::SeqCst);
        });
        let manager = self.plugin_manager.clone();
        let workflow = workflow.clone();
        let node = node.clone();
        let execution_id = execution_id.to_string();
        let result = tauri::async_runtime::spawn_blocking(move || {
            manager.execute_node(&workflow, &node, &execution_id, input, cancelled)
        })
        .await
        .map_err(|error| EngineError::Node(format!("Plugin worker failed: {error}")))??;
        monitor.abort();
        Ok(PluginHostResult {
            output: result.output,
            diagnostics: result
                .diagnostics
                .into_iter()
                .map(|diagnostic| format!("{}: {}", diagnostic.code, diagnostic.message))
                .collect(),
        })
    }
    async fn approval_requested(&self, approval: &PendingApproval) -> Result<(), EngineError> {
        let action = approval
            .action
            .get("proposedAction")
            .and_then(Value::as_str)
            .unwrap_or("Workflow action");
        let _ = self
            .app
            .notification()
            .builder()
            .title("sndbox approval required")
            .body(action)
            .show();
        if let Some(window) = self.app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
        let _ = self.app.emit("approval-requested", approval);
        Ok(())
    }
}

pub struct AppState {
    pub engine: Engine,
    pub cancellations: Arc<Mutex<HashMap<String, CancellationToken>>>,
    pub paused: Arc<AtomicBool>,
    pub quitting: Arc<AtomicBool>,
    pub browser_sidecar: BrowserSidecar,
    pub credential_vault: Arc<dyn CredentialVault>,
    pub data_dir: std::path::PathBuf,
    pub plugin_manager: plugin_manager::PluginManager,
    pub provider_adapter: Arc<provider_adapter::ProviderOperationAdapter>,
    pub sync_crypto: sync_crypto::WorkflowSyncCrypto,
    pub collaboration_crypto: collaboration::CollaborationCrypto,
    pub pending_deep_links: Arc<Mutex<Vec<String>>>,
    pub pending_workflow_files: Arc<Mutex<Vec<String>>>,
    pub pending_workflow_imports: Arc<Mutex<HashMap<String, Workflow>>>,
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let files = workflow_file_arguments(&argv);
            if let Some(state) = app.try_state::<AppState>() {
                state.pending_workflow_files.lock().extend(files.clone());
            }
            if !files.is_empty() {
                let _ = app.emit("workflow-file-requested", &files);
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        let _ = commands::show_quick_launcher(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--background"]),
        ))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            app.deep_link().register_all()?;
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let database =
                Database::open(data_dir.join("sandbox.db")).map_err(|error| error.to_string())?;
            database
                .recover_unfinished()
                .map_err(|error| error.to_string())?;
            let browser_sidecar =
                BrowserSidecar::new(app.handle()).map_err(|error| error.to_string())?;
            let credential_vault: Arc<dyn CredentialVault> = Arc::new(OsCredentialVault::new());
            let provider_adapter = Arc::new(
                provider_adapter::ProviderOperationAdapter::new(
                    database.clone(),
                    credential_vault.clone(),
                )
                .map_err(|error| error.to_string())?,
            );
            let plugin_manager = plugin_manager::PluginManager::with_host_services(
                database.clone(),
                data_dir.join("plugins").join("packages"),
                Arc::new(
                    sandbox_plugin_runtime::ReqwestTransport::new()
                        .map_err(|error| error.to_string())?,
                ),
                provider_adapter.clone(),
            )
            .map_err(|error| error.to_string())?;
            bundled_plugins::install(&plugin_manager).map_err(|error| error.to_string())?;
            let sync_crypto = sync_crypto::WorkflowSyncCrypto::new(credential_vault.clone());
            let collaboration_crypto =
                collaboration::CollaborationCrypto::new(credential_vault.clone());
            let pending_deep_links = Arc::new(Mutex::new(
                app.deep_link()
                    .get_current()?
                    .unwrap_or_default()
                    .iter()
                    .filter_map(|url| validate_deep_link(url.as_str()))
                    .collect(),
            ));
            let startup_arguments = std::env::args().collect::<Vec<_>>();
            let pending_workflow_files =
                Arc::new(Mutex::new(workflow_file_arguments(&startup_arguments)));
            let sidecar_for_verify = browser_sidecar.clone();
            tauri::async_runtime::block_on(async {
                let _ = sidecar_for_verify.verify().await;
            });
            let engine = Engine::new(
                database.clone(),
                Arc::new(TauriHost {
                    app: app.handle().clone(),
                    database: database.clone(),
                    browser_sidecar: browser_sidecar.clone(),
                    data_dir: data_dir.clone(),
                    credential_vault: credential_vault.clone(),
                    plugin_manager: plugin_manager.clone(),
                }),
            );
            let state = AppState {
                engine: engine.clone(),
                cancellations: Arc::new(Mutex::new(HashMap::new())),
                paused: Arc::new(AtomicBool::new(false)),
                quitting: Arc::new(AtomicBool::new(false)),
                browser_sidecar,
                credential_vault,
                data_dir,
                plugin_manager,
                provider_adapter,
                sync_crypto,
                collaboration_crypto,
                pending_deep_links,
                pending_workflow_files,
                pending_workflow_imports: Arc::new(Mutex::new(HashMap::new())),
            };
            commands::initialize_desktop_integration(app.handle(), &database);
            runner::create_tray(app, &state)?;
            runner::start_background_services(app.handle().clone(), &state);
            let mut events = engine.subscribe();
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                while let Ok(event) = events.recv().await {
                    let _ = handle.emit("runner-event", event);
                }
            });
            app.manage(state);
            let background_launch = startup_arguments
                .iter()
                .any(|argument| argument == "--background");
            let has_workflow_file = !workflow_file_arguments(&startup_arguments).is_empty();
            if background_launch && !has_workflow_file {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            let app_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                let urls: Vec<String> = event
                    .urls()
                    .iter()
                    .filter_map(|url| validate_deep_link(url.as_str()))
                    .collect();
                if urls.is_empty() {
                    return;
                }
                if let Some(state) = app_handle.try_state::<AppState>() {
                    state.pending_deep_links.lock().extend(urls.clone());
                }
                let _ = app_handle.emit("deep-link-requested", &urls);
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if let Some(state) = window.try_state::<AppState>() {
                    if !state.quitting.load(Ordering::SeqCst) {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_workflows,
            commands::get_workflow,
            commands::save_workflow,
            commands::list_workflow_revisions,
            commands::get_workflow_revision,
            commands::restore_workflow_revision,
            commands::delete_workflow,
            commands::update_workflow_metadata,
            commands::batch_update_workflow_metadata,
            commands::duplicate_workflow,
            commands::archive_workflow,
            commands::archive_workflows,
            commands::restore_workflow,
            commands::restore_workflows,
            commands::purge_workflow,
            commands::create_workflow,
            commands::export_workflow,
            commands::inspect_workflow_import,
            commands::inspect_workflow_path,
            commands::confirm_workflow_import,
            commands::cancel_workflow_import,
            commands::take_workflow_file_requests,
            commands::validate_workflow,
            commands::list_node_contracts,
            commands::evaluate_node_gates,
            commands::test_custom_node,
            commands::get_custom_node_verification,
            commands::open_quick_launcher,
            commands::reveal_workflow,
            commands::desktop_integration_settings,
            commands::set_desktop_integration_settings,
            commands::run_workflow,
            commands::test_workflow_node,
            commands::retry_failed_node,
            commands::retry_browser_execution_headed,
            commands::open_execution_artifact,
            commands::cancel_execution,
            commands::list_executions,
            commands::get_execution,
            commands::clear_execution_history,
            commands::query_executions,
            commands::delete_execution,
            commands::approve_permissions,
            commands::runner_status,
            commands::set_runner_paused,
            commands::browser_engine_status,
            commands::restart_browser_engine,
            commands::list_browser_profiles,
            commands::create_browser_profile,
            commands::update_browser_profile,
            commands::duplicate_browser_profile,
            commands::delete_browser_profile,
            commands::clear_browser_profile_data,
            commands::open_browser_profile,
            commands::start_browser_recording,
            commands::get_browser_recording,
            commands::stop_browser_recording,
            commands::test_browser_locator,
            commands::list_connections,
            commands::submit_bug_report,
            commands::create_file_grant,
            commands::create_connection,
            commands::rename_connection,
            commands::reconnect_connection,
            commands::test_connection,
            ai_builder::build_workflow_with_ai,
            ai_builder::generate_code_with_ai,
            commands::revoke_connection,
            commands::delete_connection,
            commands::workflows_using_connection,
            commands::start_gmail_oauth,
            commands::start_integration_oauth,
            commands::list_integration_resources,
            commands::configure_github_installation,
            commands::account_status,
            commands::start_account_auth,
            commands::sign_out_account,
            commands::list_account_organisations,
            commands::create_account_organisation,
            commands::list_cloud_workflows,
            commands::get_workspace_activity,
            commands::push_cloud_workflow,
            commands::list_cloud_workflow_revisions,
            commands::list_cloud_workflow_approvals,
            commands::request_cloud_workflow_approval,
            commands::decide_cloud_workflow_approval,
            commands::publish_cloud_workflow,
            commands::import_cloud_workflow_revision,
            commands::list_pending_approvals,
            commands::resolve_pending_approval,
            commands::inspect_plugin_package,
            commands::install_inspected_plugin,
            commands::list_installed_plugins,
            commands::approve_plugin_permissions,
            commands::set_plugin_enabled,
            commands::prepare_workflow_sync,
            commands::import_synced_revision_copy,
            commands::search_marketplace,
            commands::inspect_marketplace_plugin,
            commands::take_deep_link_requests
        ])
        .run(tauri::generate_context!())
        .expect("failed to run sndbox");
}

fn workflow_file_arguments(arguments: &[String]) -> Vec<String> {
    arguments
        .iter()
        .filter(|argument| {
            let lower = argument.to_ascii_lowercase();
            lower.ends_with(".sndbox") || lower.ends_with(".sandbox-workflow.json")
        })
        .filter_map(|argument| {
            std::path::Path::new(argument)
                .canonicalize()
                .ok()
                .map(|path| path.to_string_lossy().to_string())
        })
        .collect()
}

fn validate_deep_link(raw: &str) -> Option<String> {
    if raw.len() > 4096 {
        return None;
    }
    let parsed = url::Url::parse(raw).ok()?;
    if parsed.scheme() != "sandbox"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
    {
        return None;
    }
    let supported = matches!(
        (parsed.host_str(), parsed.path()),
        (Some("marketplace"), "/install") | (Some("templates"), "/import")
    );
    if !supported || parsed.query_pairs().count() > 20 {
        return None;
    }
    Some(parsed.to_string())
}

#[cfg(test)]
mod deep_link_tests {
    use super::validate_deep_link;

    #[test]
    fn accepts_only_supported_marketplace_and_template_routes() {
        assert_eq!(
            validate_deep_link(
                "sandbox://marketplace/install?plugin=com.example.csv&version=2.4.1"
            )
            .as_deref(),
            Some("sandbox://marketplace/install?plugin=com.example.csv&version=2.4.1")
        );
        assert!(validate_deep_link(
            "sandbox://templates/import?template=monthly-report&enabled=false"
        )
        .is_some());
        assert!(validate_deep_link("sandbox://settings/reset").is_none());
        assert!(validate_deep_link("https://sndbox.app/templates/monthly-report").is_none());
    }

    #[test]
    fn rejects_ambiguous_or_oversized_deep_links() {
        assert!(validate_deep_link(
            "sandbox://user:secret@marketplace/install?plugin=com.example.csv"
        )
        .is_none());
        assert!(validate_deep_link(
            "sandbox://marketplace/install?plugin=com.example.csv#unexpected"
        )
        .is_none());
        let excessive_query = format!(
            "sandbox://templates/import?{}",
            (0..21)
                .map(|index| format!("p{index}=x"))
                .collect::<Vec<_>>()
                .join("&")
        );
        assert!(validate_deep_link(&excessive_query).is_none());
        assert!(validate_deep_link(&format!(
            "sandbox://marketplace/install?plugin={}",
            "a".repeat(4096)
        ))
        .is_none());
    }
}
