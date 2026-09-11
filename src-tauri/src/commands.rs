use crate::{
    account_auth, marketplace, oauth,
    plugin_manager::{PackageTrustMetadata, PluginPackageInspection},
    sync_crypto::EncryptedWorkflowRevision,
    templates, AppState,
};
use chrono::{DateTime, Utc};
use reqwest::Method;
use sandbox_engine::{
    custom_node_fingerprint, gate_node, node_contracts, CustomNodeVerification,
    NodeContract, NodeGate,
    validation::{validate, ValidationIssue},
    BrowserProfile, BrowserProfileSettings, ConnectionMetadata, ConnectionStatus, ExecutionRecord,
    InstalledPlugin, PendingApproval, PermissionSummary, StructuredLocator, Workflow,
    WorkflowMetadataPatch, WorkflowRevisionSummary, WorkflowSummary,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::hash_map::Entry;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

type Result<T> = std::result::Result<T, String>;
const ACCOUNT_AUTH_CALLBACK_PORT: u16 = 53_682;
const DESKTOP_INTEGRATION_KEY: &str = "desktop.integration.v1";

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountWorkspace {
    pub id: String,
    pub organisation_id: String,
    pub name: String,
    pub slug: String,
    pub role: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountOrganisation {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub role: String,
    pub created_at: DateTime<Utc>,
    pub workspaces: Vec<AccountWorkspace>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudWorkflow {
    pub workflow_id: String,
    pub name: String,
    pub current_draft_revision_id: Option<String>,
    pub current_published_revision_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncResult {
    pub revision: EncryptedWorkflowRevision,
    pub conflict_revision_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudWorkflowApproval {
    pub approval_id: String,
    pub workflow_id: String,
    pub revision_id: String,
    pub status: String,
    pub required_approvals: u32,
    pub approval_count: u32,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudPublishResult {
    pub workflow_id: String,
    pub published_revision_id: String,
    pub previous_published_revision_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopIntegrationSettings {
    pub shortcut: String,
    pub shortcut_enabled: bool,
    pub start_at_login: bool,
    pub shortcut_error: Option<String>,
}

impl Default for DesktopIntegrationSettings {
    fn default() -> Self { Self { shortcut: "Ctrl+Shift+Space".into(), shortcut_enabled: true, start_at_login: false, shortcut_error: None } }
}

pub fn show_quick_launcher(app: &AppHandle) -> std::result::Result<(), String> {
    if let Some(window) = app.get_webview_window("quick-launcher") {
        window.show().map_err(err)?; window.unminimize().map_err(err)?; window.set_focus().map_err(err)?; return Ok(());
    }
    WebviewWindowBuilder::new(app, "quick-launcher", WebviewUrl::App("index.html?window=quick-launcher".into()))
        .title("sndbox quick launcher").inner_size(520.0,420.0).min_inner_size(420.0,320.0)
        .resizable(true).decorations(true).always_on_top(true).build().map_err(err)?;
    Ok(())
}

#[tauri::command]
pub fn open_quick_launcher(app: AppHandle) -> Result<()> { show_quick_launcher(&app) }

#[tauri::command]
pub fn desktop_integration_settings(app: AppHandle, state: State<'_, AppState>) -> Result<DesktopIntegrationSettings> {
    let mut settings=state.engine.database().get_setting::<DesktopIntegrationSettings>(DESKTOP_INTEGRATION_KEY).map_err(err)?.unwrap_or_default();
    settings.start_at_login=app.autolaunch().is_enabled().unwrap_or(settings.start_at_login);
    Ok(settings)
}

#[tauri::command]
pub fn set_desktop_integration_settings(next: DesktopIntegrationSettings, app: AppHandle, state: State<'_, AppState>) -> Result<DesktopIntegrationSettings> {
    let previous=state.engine.database().get_setting::<DesktopIntegrationSettings>(DESKTOP_INTEGRATION_KEY).map_err(err)?.unwrap_or_default();
    if next.shortcut_enabled && (!previous.shortcut_enabled || next.shortcut != previous.shortcut) {
        app.global_shortcut().register(next.shortcut.as_str()).map_err(|error| format!("Could not register '{}': {error}. The previous shortcut remains active.",next.shortcut))?;
    }
    if previous.shortcut_enabled && (!next.shortcut_enabled || next.shortcut != previous.shortcut) {
        let _=app.global_shortcut().unregister(previous.shortcut.as_str());
    }
    if next.start_at_login { app.autolaunch().enable().map_err(err)?; } else { app.autolaunch().disable().map_err(err)?; }
    let saved=DesktopIntegrationSettings{shortcut:next.shortcut.trim().to_string(),shortcut_enabled:next.shortcut_enabled,start_at_login:next.start_at_login,shortcut_error:None};
    state.engine.database().set_setting(DESKTOP_INTEGRATION_KEY,&saved).map_err(err)?;
    Ok(saved)
}

#[tauri::command]
pub fn take_deep_link_requests(state: State<'_, AppState>) -> Vec<String> {
    std::mem::take(&mut *state.pending_deep_links.lock())
}

#[tauri::command]
pub async fn inspect_plugin_package(
    trust: PackageTrustMetadata,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<PluginPackageInspection>> {
    let selection = tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Inspect signed plugin package")
            .add_filter("sndbox plugin", &["sandbox-plugin"])
            .blocking_pick_file()
    })
    .await
    .map_err(err)?;
    let Some(selection) = selection else {
        return Ok(None);
    };
    let path = selection.into_path().map_err(err)?;
    state
        .plugin_manager
        .inspect_path(&path, trust)
        .map(Some)
        .map_err(err)
}

#[tauri::command]
pub fn install_inspected_plugin(
    inspection_id: String,
    state: State<'_, AppState>,
) -> Result<InstalledPlugin> {
    state
        .plugin_manager
        .install_inspected(&inspection_id)
        .map_err(err)
}

#[tauri::command]
pub fn list_installed_plugins(
    owner_type: Option<String>,
    owner_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<InstalledPlugin>> {
    state
        .engine
        .database()
        .list_installed_plugins(
            owner_type.as_deref().unwrap_or("personal"),
            owner_id.as_deref().unwrap_or("local"),
        )
        .map_err(err)
}

#[tauri::command]
pub fn approve_plugin_permissions(
    plugin_id: String,
    version: String,
    package_integrity: String,
    owner_type: String,
    owner_id: String,
    state: State<'_, AppState>,
) -> Result<InstalledPlugin> {
    state
        .engine
        .database()
        .approve_plugin_permissions(
            &plugin_id,
            &version,
            &package_integrity,
            &owner_type,
            &owner_id,
        )
        .map_err(err)
}

#[tauri::command]
pub fn set_plugin_enabled(
    plugin_id: String,
    version: String,
    package_integrity: String,
    owner_type: String,
    owner_id: String,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<InstalledPlugin> {
    state
        .engine
        .database()
        .set_plugin_enabled(
            &plugin_id,
            &version,
            &package_integrity,
            &owner_type,
            &owner_id,
            enabled,
        )
        .map_err(err)
}

#[tauri::command]
pub fn prepare_workflow_sync(
    id: String,
    parent_revision_id: Option<String>,
    editor_device_id: String,
    state: State<'_, AppState>,
) -> Result<EncryptedWorkflowRevision> {
    prepare_workflow_sync_revision(&id, parent_revision_id, editor_device_id, &state)
}

fn prepare_workflow_sync_revision(
    id: &str,
    parent_revision_id: Option<String>,
    editor_device_id: String,
    state: &AppState,
) -> Result<EncryptedWorkflowRevision> {
    if !state
        .credential_vault
        .exists(account_auth::ACCOUNT_VAULT_ID)
        .map_err(err)?
    {
        return Err("Sign in before enabling workflow sync. Local workflows remain available without an account.".into());
    }
    let workflow = state
        .engine
        .database()
        .get_workflow(id)
        .map_err(err)?
        .ok_or_else(|| "Workflow no longer exists.".to_string())?;
    let mut definition = serde_json::to_value(&workflow).map_err(err)?;
    let mut required_connections = Vec::new();
    let mut required_profiles = Vec::new();
    let mut local_path_fields = Vec::new();
    sanitize_export_definition(
        &mut definition,
        &state,
        &mut required_connections,
        &mut required_profiles,
        &mut local_path_fields,
    )?;
    if contains_secret_material(&definition) {
        return Err(
            "Workflow sync stopped because the definition contains secret-shaped material.".into(),
        );
    }
    let sanitized: Workflow = serde_json::from_value(definition).map_err(err)?;
    state
        .sync_crypto
        .encrypt(&sanitized, parent_revision_id, editor_device_id)
}

#[tauri::command]
pub async fn list_account_organisations(
    state: State<'_, AppState>,
) -> Result<Vec<AccountOrganisation>> {
    let payload =
        control_plane_json(&state, Method::GET, "/v1/account/organisations", None).await?;
    serde_json::from_value(
        payload
            .get("items")
            .cloned()
            .ok_or_else(|| "Account workspace response did not contain items.".to_string())?,
    )
    .map_err(|error| format!("Account workspace response was invalid: {error}"))
}

#[tauri::command]
pub async fn create_account_organisation(
    name: String,
    slug: String,
    state: State<'_, AppState>,
) -> Result<AccountOrganisation> {
    let name = name.trim();
    let slug = slug.trim();
    if !(2..=100).contains(&name.len()) {
        return Err("Organisation name must be between 2 and 100 characters.".into());
    }
    if slug.is_empty()
        || slug.len() > 63
        || slug.starts_with('-')
        || slug.ends_with('-')
        || slug.chars().any(|character| {
            !character.is_ascii_lowercase() && !character.is_ascii_digit() && character != '-'
        })
    {
        return Err(
            "Organisation slug must contain lowercase letters, numbers, and internal hyphens."
                .into(),
        );
    }
    let payload = control_plane_json(
        &state,
        Method::POST,
        "/v1/organisations",
        Some(json!({"name":name,"slug":slug})),
    )
    .await?;
    let organisation = payload
        .get("organisation")
        .cloned()
        .ok_or_else(|| "Organisation response was incomplete.".to_string())?;
    let workspace = payload.get("workspace").cloned().ok_or_else(|| {
        "Organisation response did not contain its default workspace.".to_string()
    })?;
    let mut organisation: AccountOrganisation = serde_json::from_value(json!({
        "id": organisation.get("id"),
        "name": organisation.get("name"),
        "slug": organisation.get("slug"),
        "role": "owner",
        "createdAt": organisation.get("createdAt"),
        "workspaces": [{
            "id": workspace.get("id"),
            "organisationId": workspace.get("organisationId"),
            "name": workspace.get("name"),
            "slug": workspace.get("slug"),
            "role": "owner",
            "createdAt": workspace.get("createdAt")
        }]
    }))
    .map_err(|error| format!("Organisation response was invalid: {error}"))?;
    organisation.workspaces.shrink_to_fit();
    Ok(organisation)
}

#[tauri::command]
pub async fn list_cloud_workflows(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<CloudWorkflow>> {
    let workspace_id = checked_uuid(&workspace_id, "Workspace")?;
    let payload = control_plane_json(
        &state,
        Method::GET,
        &format!("/v1/workspaces/{workspace_id}/sync/workflows"),
        None,
    )
    .await?;
    serde_json::from_value(
        payload
            .get("items")
            .cloned()
            .ok_or_else(|| "Cloud workflow response did not contain items.".to_string())?,
    )
    .map_err(|error| format!("Cloud workflow response was invalid: {error}"))
}

#[tauri::command]
pub async fn get_workspace_activity(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<Value> {
    let workspace_id = checked_uuid(&workspace_id, "Workspace")?;
    control_plane_json(
        &state,
        Method::GET,
        &format!("/v1/workspaces/{workspace_id}/activity?limit=30"),
        None,
    )
    .await
}

#[tauri::command]
pub async fn push_cloud_workflow(
    workflow_id: String,
    workspace_id: String,
    parent_revision_id: Option<String>,
    editor_device_id: String,
    state: State<'_, AppState>,
) -> Result<CloudSyncResult> {
    let workflow_id = checked_uuid(&workflow_id, "Workflow")?;
    let workspace_id = checked_uuid(&workspace_id, "Workspace")?;
    if let Some(parent) = parent_revision_id.as_deref() {
        checked_uuid(parent, "Parent revision")?;
    }
    let workflow = state
        .engine
        .database()
        .get_workflow(&workflow_id)
        .map_err(err)?
        .ok_or_else(|| "Workflow no longer exists.".to_string())?;
    control_plane_json(
        &state,
        Method::POST,
        &format!("/v1/workspaces/{workspace_id}/sync/workflows"),
        Some(json!({"workflowId":workflow_id,"name":workflow.name})),
    )
    .await?;
    let revision =
        prepare_workflow_sync_revision(&workflow_id, parent_revision_id, editor_device_id, &state)?;
    let payload = control_plane_json(
        &state,
        Method::POST,
        &format!("/v1/workspaces/{workspace_id}/sync/revisions"),
        Some(serde_json::to_value(&revision).map_err(err)?),
    )
    .await?;
    serde_json::from_value(payload)
        .map_err(|error| format!("Cloud sync response was invalid: {error}"))
}

#[tauri::command]
pub async fn list_cloud_workflow_revisions(
    workspace_id: String,
    workflow_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<EncryptedWorkflowRevision>> {
    let workspace_id = checked_uuid(&workspace_id, "Workspace")?;
    let workflow_id = checked_uuid(&workflow_id, "Workflow")?;
    let payload = control_plane_json(
        &state,
        Method::GET,
        &format!("/v1/workspaces/{workspace_id}/sync/workflows/{workflow_id}/revisions?limit=100"),
        None,
    )
    .await?;
    serde_json::from_value(
        payload
            .get("items")
            .cloned()
            .ok_or_else(|| "Cloud revision response did not contain items.".to_string())?,
    )
    .map_err(|error| format!("Cloud revision response was invalid: {error}"))
}

#[tauri::command]
pub async fn list_cloud_workflow_approvals(
    workspace_id: String,
    status: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<CloudWorkflowApproval>> {
    let workspace_id = checked_uuid(&workspace_id, "Workspace")?;
    let status = status.unwrap_or_else(|| "all".into());
    if !matches!(status.as_str(), "all" | "pending" | "approved" | "rejected") {
        return Err("Approval status filter is invalid.".into());
    }
    let payload = control_plane_json(
        &state,
        Method::GET,
        &format!("/v1/workspaces/{workspace_id}/workflow-approvals?status={status}"),
        None,
    )
    .await?;
    serde_json::from_value(
        payload
            .get("items")
            .cloned()
            .ok_or_else(|| "Cloud approval response did not contain items.".to_string())?,
    )
    .map_err(|error| format!("Cloud approval response was invalid: {error}"))
}

#[tauri::command]
pub async fn request_cloud_workflow_approval(
    workspace_id: String,
    workflow_id: String,
    revision_id: String,
    state: State<'_, AppState>,
) -> Result<CloudWorkflowApproval> {
    let workspace_id = checked_uuid(&workspace_id, "Workspace")?;
    let workflow_id = checked_uuid(&workflow_id, "Workflow")?;
    let revision_id = checked_uuid(&revision_id, "Revision")?;
    let payload = control_plane_json(
        &state,
        Method::POST,
        &format!("/v1/workspaces/{workspace_id}/workflows/{workflow_id}/revisions/{revision_id}/request-approval"),
        Some(json!({})),
    ).await?;
    serde_json::from_value(
        payload
            .get("approval")
            .cloned()
            .ok_or_else(|| "Approval response was incomplete.".to_string())?,
    )
    .map_err(|error| format!("Approval response was invalid: {error}"))
}

#[tauri::command]
pub async fn decide_cloud_workflow_approval(
    workspace_id: String,
    approval_id: String,
    decision: String,
    reason: Option<String>,
    state: State<'_, AppState>,
) -> Result<CloudWorkflowApproval> {
    let workspace_id = checked_uuid(&workspace_id, "Workspace")?;
    let approval_id = checked_uuid(&approval_id, "Approval")?;
    if !matches!(decision.as_str(), "approved" | "rejected") {
        return Err("Approval decision must be approved or rejected.".into());
    }
    if decision == "rejected"
        && reason
            .as_deref()
            .is_none_or(|value| value.trim().is_empty())
    {
        return Err("A rejection reason is required.".into());
    }
    let payload = control_plane_json(
        &state,
        Method::POST,
        &format!("/v1/workspaces/{workspace_id}/workflow-approvals/{approval_id}/decision"),
        Some(json!({"decision":decision,"reason":reason})),
    )
    .await?;
    serde_json::from_value(
        payload
            .get("approval")
            .cloned()
            .ok_or_else(|| "Approval response was incomplete.".to_string())?,
    )
    .map_err(|error| format!("Approval response was invalid: {error}"))
}

#[tauri::command]
pub async fn publish_cloud_workflow(
    workspace_id: String,
    workflow_id: String,
    revision_id: String,
    change_summary: String,
    state: State<'_, AppState>,
) -> Result<CloudPublishResult> {
    let workspace_id = checked_uuid(&workspace_id, "Workspace")?;
    let workflow_id = checked_uuid(&workflow_id, "Workflow")?;
    let revision_id = checked_uuid(&revision_id, "Revision")?;
    if change_summary.trim().is_empty() || change_summary.len() > 2_000 {
        return Err(
            "A publication change summary is required and must be at most 2,000 characters.".into(),
        );
    }
    let payload = control_plane_json(
        &state,
        Method::POST,
        &format!(
            "/v1/workspaces/{workspace_id}/workflows/{workflow_id}/revisions/{revision_id}/publish"
        ),
        Some(json!({"changeSummary":change_summary.trim()})),
    )
    .await?;
    serde_json::from_value(payload)
        .map_err(|error| format!("Publication response was invalid: {error}"))
}

#[tauri::command]
pub async fn import_cloud_workflow_revision(
    workspace_id: String,
    workflow_id: String,
    revision_id: String,
    state: State<'_, AppState>,
) -> Result<Workflow> {
    let workspace_id = checked_uuid(&workspace_id, "Workspace")?;
    let workflow_id = checked_uuid(&workflow_id, "Workflow")?;
    let revision_id = checked_uuid(&revision_id, "Revision")?;
    let payload = control_plane_json(
        &state,
        Method::GET,
        &format!(
            "/v1/workspaces/{workspace_id}/sync/workflows/{workflow_id}/revisions/{revision_id}"
        ),
        None,
    )
    .await?;
    let revision: EncryptedWorkflowRevision = serde_json::from_value(
        payload
            .get("revision")
            .cloned()
            .ok_or_else(|| "Cloud revision response did not contain a revision.".to_string())?,
    )
    .map_err(|error| format!("Cloud revision response was invalid: {error}"))?;
    import_synced_revision(&revision, &state)
}

#[tauri::command]
pub fn import_synced_revision_copy(
    revision: EncryptedWorkflowRevision,
    state: State<'_, AppState>,
) -> Result<Workflow> {
    import_synced_revision(&revision, &state)
}

fn import_synced_revision(
    revision: &EncryptedWorkflowRevision,
    state: &AppState,
) -> Result<Workflow> {
    let mut workflow = state.sync_crypto.decrypt(revision)?;
    workflow.id = Uuid::new_v4().to_string();
    workflow.name = format!("{} (synced conflict copy)", workflow.name);
    workflow.enabled = false;
    workflow.owner = Default::default();
    workflow.settings.permissions = PermissionSummary::default();
    workflow.created_at = Utc::now();
    workflow.updated_at = Utc::now();
    state.engine.database().save_workflow(workflow).map_err(err)
}

#[tauri::command]
pub async fn search_marketplace(
    query: marketplace::MarketplaceSearch,
) -> Result<marketplace::MarketplacePage> {
    marketplace::search(query).await
}

#[tauri::command]
pub async fn inspect_marketplace_plugin(
    plugin_id: String,
    state: State<'_, AppState>,
) -> Result<PluginPackageInspection> {
    marketplace::inspect_for_install(&plugin_id, &state.plugin_manager).await
}

#[tauri::command]
pub fn list_workflows(
    include_archived: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Vec<WorkflowSummary>> {
    state
        .engine
        .database()
        .list_workflows_including_archived(include_archived.unwrap_or(false))
        .map_err(err)
}
#[tauri::command]
pub fn get_workflow(id: String, state: State<'_, AppState>) -> Result<Option<Workflow>> {
    let workflow = state.engine.database().get_workflow(&id).map_err(err)?;
    if workflow.is_some() {
        state
            .engine
            .database()
            .update_workflow_metadata(
                &id,
                WorkflowMetadataPatch {
                    last_opened_at: Some(Some(Utc::now())),
                    ..Default::default()
                },
            )
            .map_err(err)?;
    }
    Ok(workflow)
}
#[tauri::command]
pub fn save_workflow(workflow: Workflow, state: State<'_, AppState>) -> Result<Workflow> {
    if workflow.id.trim().is_empty() || workflow.name.trim().is_empty() {
        return Err("Workflow name and identifier are required.".into());
    }
    state.engine.database().save_workflow(workflow).map_err(err)
}
#[tauri::command]
pub fn list_workflow_revisions(
    workflow_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<WorkflowRevisionSummary>> {
    state
        .engine
        .database()
        .list_workflow_revisions(&workflow_id)
        .map_err(err)
}

#[tauri::command]
pub fn get_workflow_revision(
    workflow_id: String,
    revision_id: String,
    state: State<'_, AppState>,
) -> Result<Option<Workflow>> {
    state
        .engine
        .database()
        .get_workflow_revision(&workflow_id, &revision_id)
        .map_err(err)
}

#[tauri::command]
pub fn restore_workflow_revision(
    workflow_id: String,
    revision_id: String,
    state: State<'_, AppState>,
) -> Result<Workflow> {
    state
        .engine
        .database()
        .restore_workflow_revision(&workflow_id, &revision_id)
        .map_err(err)
}
#[tauri::command]
pub fn delete_workflow(id: String, state: State<'_, AppState>) -> Result<()> {
    state.engine.database().delete_workflow(&id).map_err(err)
}

#[tauri::command]
pub fn update_workflow_metadata(
    id: String,
    patch: WorkflowMetadataPatch,
    state: State<'_, AppState>,
) -> Result<WorkflowSummary> {
    state
        .engine
        .database()
        .update_workflow_metadata(&id, patch)
        .map_err(err)?;
    state
        .engine
        .database()
        .list_workflows_including_archived(true)
        .map_err(err)?
        .into_iter()
        .find(|item| item.workflow.id == id)
        .ok_or_else(|| "Workflow no longer exists.".into())
}

#[tauri::command]
pub fn batch_update_workflow_metadata(
    ids: Vec<String>,
    patch: WorkflowMetadataPatch,
    state: State<'_, AppState>,
) -> Result<()> {
    state
        .engine
        .database()
        .batch_update_workflow_metadata(&ids, patch)
        .map(|_| ())
        .map_err(err)
}

#[tauri::command]
pub fn duplicate_workflow(
    id: String,
    name: Option<String>,
    state: State<'_, AppState>,
) -> Result<Workflow> {
    let mut workflow = state
        .engine
        .database()
        .get_workflow(&id)
        .map_err(err)?
        .ok_or_else(|| "Workflow no longer exists.".to_string())?;
    let summaries = state
        .engine
        .database()
        .list_workflows_including_archived(true)
        .map_err(err)?;
    let names = summaries
        .iter()
        .map(|item| item.workflow.name.to_lowercase())
        .collect::<std::collections::HashSet<_>>();
    let base = name
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("{} copy", workflow.name));
    let mut candidate = base.clone();
    let mut suffix = 2;
    while names.contains(&candidate.to_lowercase()) {
        candidate = format!("{base} {suffix}");
        suffix += 1;
    }
    workflow.id = Uuid::new_v4().to_string();
    workflow.name = candidate;
    workflow.enabled = false;
    workflow.settings.permissions = PermissionSummary::default();
    workflow.created_at = Utc::now();
    workflow.updated_at = workflow.created_at;
    state.engine.database().save_workflow(workflow).map_err(err)
}

#[tauri::command]
pub fn archive_workflow(id: String, state: State<'_, AppState>) -> Result<()> {
    let mut workflow = state
        .engine
        .database()
        .get_workflow(&id)
        .map_err(err)?
        .ok_or_else(|| "Workflow no longer exists.".to_string())?;
    if workflow.enabled {
        workflow.enabled = false;
        state
            .engine
            .database()
            .save_workflow(workflow)
            .map_err(err)?;
    }
    state
        .engine
        .database()
        .update_workflow_metadata(
            &id,
            WorkflowMetadataPatch {
                archived_at: Some(Some(Utc::now())),
                ..Default::default()
            },
        )
        .map_err(err)?;
    Ok(())
}

#[tauri::command]
pub fn archive_workflows(ids: Vec<String>, state: State<'_, AppState>) -> Result<()> {
    state
        .engine
        .database()
        .set_workflows_archived(&ids, true)
        .map_err(err)
}

#[tauri::command]
pub fn restore_workflow(id: String, state: State<'_, AppState>) -> Result<()> {
    let mut workflow = state
        .engine
        .database()
        .get_workflow(&id)
        .map_err(err)?
        .ok_or_else(|| "Workflow no longer exists.".to_string())?;
    if workflow.enabled {
        workflow.enabled = false;
        state
            .engine
            .database()
            .save_workflow(workflow)
            .map_err(err)?;
    }
    state
        .engine
        .database()
        .update_workflow_metadata(
            &id,
            WorkflowMetadataPatch {
                archived_at: Some(None),
                ..Default::default()
            },
        )
        .map_err(err)?;
    Ok(())
}

#[tauri::command]
pub fn restore_workflows(ids: Vec<String>, state: State<'_, AppState>) -> Result<()> {
    state
        .engine
        .database()
        .set_workflows_archived(&ids, false)
        .map_err(err)
}

fn remove_safe_artifacts(paths: Vec<String>, root: &std::path::Path) {
    let Ok(root) = root.canonicalize() else {
        return;
    };
    for path in paths {
        let candidate = std::path::PathBuf::from(path);
        if let Ok(candidate) = candidate.canonicalize() {
            if candidate.is_file() && candidate.starts_with(&root) {
                let _ = std::fs::remove_file(candidate);
            }
        }
    }
}

#[tauri::command]
pub fn purge_workflow(id: String, state: State<'_, AppState>) -> Result<()> {
    let metadata = state
        .engine
        .database()
        .get_workflow_metadata(&id)
        .map_err(err)?;
    if metadata.archived_at.is_none() {
        return Err("Only archived workflows can be permanently deleted.".into());
    }
    let artifacts = state
        .engine
        .database()
        .delete_workflow_with_artifacts(&id)
        .map_err(err)?;
    remove_safe_artifacts(artifacts, &state.data_dir.join("artifacts"));
    Ok(())
}
#[tauri::command]
pub fn create_workflow(
    template_key: Option<String>,
    name: Option<String>,
    state: State<'_, AppState>,
) -> Result<Workflow> {
    let workflow = templates::by_key(template_key.as_deref().unwrap_or("blank"), name);
    state.engine.database().save_workflow(workflow).map_err(err)
}

#[tauri::command]
pub async fn export_workflow(
    id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<String>> {
    let workflow = state
        .engine
        .database()
        .get_workflow(&id)
        .map_err(err)?
        .ok_or_else(|| "Workflow no longer exists.".to_string())?;
    let mut definition = serde_json::to_value(&workflow).map_err(err)?;
    let mut required_connections = Vec::<Value>::new();
    let mut required_profiles = Vec::<Value>::new();
    let mut local_path_fields = Vec::<String>::new();
    sanitize_export_definition(
        &mut definition,
        &state,
        &mut required_connections,
        &mut required_profiles,
        &mut local_path_fields,
    )?;
    if let Some(object) = definition.as_object_mut() {
        object.insert("enabled".into(), Value::Bool(false));
    }
    let mut node_types = workflow
        .nodes
        .iter()
        .map(|node| node.node_type.clone())
        .collect::<Vec<_>>();
    node_types.sort();
    node_types.dedup();
    let package = json!({
        "format": "sandbox-workflow",
        "formatVersion": 1,
        "schemaVersion": workflow.schema_version,
        "exportedAt": Utc::now(),
        "workflow": definition,
        "requiredNodeTypes": node_types,
        "requiredConnections": required_connections,
        "requiredBrowserProfiles": required_profiles,
        "requiredPermissions": {
            "networkDomains": workflow.settings.permissions.approved_network_domains,
            "folderAccessCount": workflow.settings.permissions.approved_folders.len(),
            "commandExecution": workflow.nodes.iter().any(|node| matches!(node.node_type.as_str(), "run_command" | "code" | "javascript_code" | "python_code")),
            "backgroundExecution": workflow.nodes.iter().any(|node| matches!(node.node_type.as_str(), "schedule_trigger" | "file_watch_trigger" | "gmail_new_email_trigger")),
            "externalCommunication": workflow.nodes.iter().any(|node| matches!(node.node_type.as_str(), "gmail_create_draft" | "gmail_send_email" | "gmail_add_label" | "discord_webhook" | "discord_embed" | "slack_webhook"))
        },
        "localPathRequirements": local_path_fields,
        "codeRuntimes": workflow.nodes.iter().filter(|node| matches!(node.node_type.as_str(), "code" | "javascript_code" | "python_code")).map(|node| json!({"nodeId":node.id,"language":node.configuration.get("language"),"runtimeVersion":node.configuration.get("runtimeVersion"),"helperLanguageVersion":node.configuration.get("helperLanguageVersion"),"itemMode":node.configuration.get("itemMode"),"dependencies":node.configuration.get("dependencies")})).collect::<Vec<_>>(),
        "templateMetadata": Value::Null,
        "warnings": if local_path_fields.is_empty() { Vec::<String>::new() } else { vec!["Local absolute paths were removed. Select approved files or folders after import.".to_string()] }
    });
    let suggested = format!("{}.sandbox-workflow.json", safe_filename(&workflow.name));
    let selection = tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Export workflow")
            .set_file_name(suggested)
            .add_filter("sndbox workflow", &["json"])
            .blocking_save_file()
    })
    .await
    .map_err(err)?;
    let Some(selection) = selection else {
        return Ok(None);
    };
    let path = selection.into_path().map_err(err)?;
    let encoded = serde_json::to_vec_pretty(&package).map_err(err)?;
    if encoded.len() > 2 * 1024 * 1024 {
        return Err("This workflow export exceeds the 2 MB definition limit.".into());
    }
    std::fs::write(&path, encoded).map_err(err)?;
    Ok(Some(path.to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn import_workflow(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<Workflow>> {
    let selection = tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Import workflow")
            .add_filter("sndbox workflow", &["json"])
            .blocking_pick_file()
    })
    .await
    .map_err(err)?;
    let Some(selection) = selection else {
        return Ok(None);
    };
    let path = selection.into_path().map_err(err)?;
    let metadata = std::fs::metadata(&path).map_err(err)?;
    if metadata.len() > 2 * 1024 * 1024 {
        return Err("The selected workflow exceeds the 2 MB import limit.".into());
    }
    let package: Value = serde_json::from_slice(&std::fs::read(&path).map_err(err)?)
        .map_err(|error| format!("The selected file is not valid workflow JSON: {error}"))?;
    if package.get("format").and_then(Value::as_str) != Some("sandbox-workflow") {
        return Err("The selected file is not a sndbox workflow export.".into());
    }
    if contains_secret_material(&package) {
        return Err("The import contains raw secret material. Remove tokens, passwords, cookies, and webhook URLs before importing.".into());
    }
    let schema = package
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .ok_or_else(|| "The workflow export does not declare a schema version.".to_string())?
        as u32;
    if schema > sandbox_engine::CURRENT_SCHEMA_VERSION {
        return Err(format!(
            "This workflow uses schema version {schema}, but this build supports up to version {}.",
            sandbox_engine::CURRENT_SCHEMA_VERSION
        ));
    }
    if schema == 0 {
        return Err("Workflow schema version 0 is not supported.".into());
    }
    let mut definition = package
        .get("workflow")
        .cloned()
        .ok_or_else(|| "The export does not contain a workflow definition.".to_string())?;
    if let Some(object) = definition.as_object_mut() {
        object.insert(
            "schemaVersion".into(),
            json!(sandbox_engine::CURRENT_SCHEMA_VERSION),
        );
    }
    let mut workflow: Workflow = serde_json::from_value(definition)
        .map_err(|error| format!("The workflow definition is incomplete: {error}"))?;
    workflow.id = Uuid::new_v4().to_string();
    workflow.name = format!("{} (imported)", workflow.name.trim());
    workflow.enabled = false;
    workflow.schema_version = sandbox_engine::CURRENT_SCHEMA_VERSION;
    workflow.created_at = Utc::now();
    workflow.updated_at = Utc::now();
    workflow.settings.permissions = PermissionSummary {
        approved_network_domains: package
            .pointer("/requiredPermissions/networkDomains")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        ..PermissionSummary::default()
    };
    let saved = state
        .engine
        .database()
        .save_workflow(workflow)
        .map_err(err)?;
    Ok(Some(saved))
}
#[tauri::command]
pub fn validate_workflow(workflow: Workflow) -> Vec<ValidationIssue> {
    validate(&workflow)
}

#[tauri::command]
pub fn list_node_contracts() -> Vec<NodeContract> {
    node_contracts()
}

#[tauri::command]
pub fn evaluate_node_gates(workflow: Workflow, placement: Option<String>) -> std::collections::BTreeMap<String, NodeGate> {
    let placement = placement.unwrap_or_else(|| "local".into());
    workflow.nodes.iter().map(|node| (node.id.clone(), gate_node(node, &placement))).collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomFixtureResult {
    id: String,
    name: String,
    passed: bool,
    duration_ms: u64,
    logs: Vec<String>,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomNodeTestReport {
    passed: bool,
    fingerprint: String,
    output_coverage: Vec<String>,
    branch_coverage: Vec<String>,
    fixtures: Vec<CustomFixtureResult>,
    verification: Option<CustomNodeVerification>,
}

#[tauri::command]
pub async fn test_custom_node(
    workflow: Workflow,
    node_id: String,
    state: State<'_, AppState>,
) -> Result<CustomNodeTestReport> {
    if state.engine.database().get_workflow(&workflow.id).map_err(err)?.is_none() {
        return Err("Save the workflow before verifying its custom node.".into());
    }
    let node = workflow.nodes.iter().find(|node| node.id == node_id).cloned().ok_or_else(|| "Custom node no longer exists.".to_string())?;
    if node.node_type != "custom_function" { return Err("Only custom ƒx nodes use the custom verification suite.".into()); }
    let customization = node.customization.clone().ok_or_else(|| "Custom contract is missing.".to_string())?;
    let fingerprint = custom_node_fingerprint(&customization);
    let mut fixture_results = Vec::new();
    let mut output_coverage = std::collections::BTreeSet::new();
    let mut branch_coverage = std::collections::BTreeSet::new();
    for fixture in &customization.tests {
        let execution = state.engine.test_node(
            workflow.clone(), &node_id,
            json!({"input":{"items":fixture.items},"fixtureInputs":fixture.inputs}),
            None, false, CancellationToken::new()
        ).await;
        let (passed, duration_ms, logs, actual_error) = match execution {
            Ok(record) => {
                let node_run = record.node_executions.first();
                let error_text = node_run.and_then(|run| run.error.as_ref()).map(|error| format!("{}: {}", error.code, error.message));
                let expected_error_ok = match &fixture.expected_error { Some(expected) => error_text.as_ref().is_some_and(|actual| actual.contains(expected)), None => error_text.is_none() };
                let actual_output = node_run.map(|run| &run.output).unwrap_or(&Value::Null);
                let expected_output_ok = fixture.expected_outputs.as_object().is_some_and(|expected| expected.iter().all(|(key, value)| actual_output.get(key) == Some(value)));
                let branch_counts = node_run.and_then(|run| run.collection.as_ref()).map(|collection| &collection.branch_counts);
                let expected_branch_ok = fixture.expected_branches.as_object().is_some_and(|expected| expected.keys().all(|key| branch_counts.is_some_and(|counts| counts.get(key).copied().unwrap_or(0) > 0)));
                if expected_error_ok && expected_output_ok && expected_branch_ok {
                    if let Some(expected) = fixture.expected_outputs.as_object() { output_coverage.extend(expected.keys().cloned()); }
                    if let Some(expected) = fixture.expected_branches.as_object() { branch_coverage.extend(expected.keys().cloned()); }
                }
                (expected_error_ok && expected_output_ok && expected_branch_ok, record.duration_ms.unwrap_or(0), node_run.map(|run| run.logs.clone()).unwrap_or_default(), error_text)
            }
            Err(error) => {
                let matches = fixture.expected_error.as_ref().is_some_and(|expected| error.to_string().contains(expected));
                (matches, 0, vec![], Some(error.to_string()))
            }
        };
        fixture_results.push(CustomFixtureResult { id: fixture.id.clone(), name: fixture.name.clone(), passed, duration_ms, logs, error: actual_error });
    }
    let coverage_complete = customization.outputs.iter().filter(|port| port.required).all(|port| output_coverage.contains(&port.key))
        && customization.branches.iter().all(|port| branch_coverage.contains(&port.key));
    let passed = !fixture_results.is_empty() && fixture_results.iter().all(|fixture| fixture.passed) && coverage_complete;
    let verification = if passed {
        let receipt = CustomNodeVerification { workflow_id: workflow.id.clone(), node_id: node_id.clone(), fingerprint: fingerprint.clone(), passed_at: Utc::now(), output_coverage: output_coverage.iter().cloned().collect(), branch_coverage: branch_coverage.iter().cloned().collect(), runtime_version: customization.runtime_requirement.clone() };
        state.engine.database().save_custom_node_verification(&receipt).map_err(err)?;
        Some(receipt)
    } else {
        state.engine.database().clear_custom_node_verification(&workflow.id, &node_id).map_err(err)?;
        None
    };
    Ok(CustomNodeTestReport { passed, fingerprint, output_coverage: output_coverage.into_iter().collect(), branch_coverage: branch_coverage.into_iter().collect(), fixtures: fixture_results, verification })
}

#[tauri::command]
pub fn get_custom_node_verification(workflow_id: String, node_id: String, state: State<'_, AppState>) -> Result<Option<CustomNodeVerification>> {
    state.engine.database().custom_node_verification(&workflow_id, &node_id).map_err(err)
}

#[tauri::command]
pub async fn run_workflow(
    id: String,
    trigger: Option<serde_json::Value>,
    state: State<'_, AppState>,
) -> Result<ExecutionRecord> {
    let workflow = state
        .engine
        .database()
        .get_workflow(&id)
        .map_err(err)?
        .ok_or_else(|| "Workflow no longer exists.".to_string())?;
    let token = CancellationToken::new();
    let owns_token = {
        let mut active = state.cancellations.lock();
        match active.entry(workflow.id.clone()) {
            Entry::Vacant(entry) => {
                entry.insert(token.clone());
                true
            }
            Entry::Occupied(_) => false,
        }
    };
    let result = state
        .engine
        .run(
            workflow,
            trigger.unwrap_or_else(|| json!({"type":"manual"})),
            token,
        )
        .await
        .map_err(err);
    if owns_token {
        state.cancellations.lock().remove(&id);
    }
    result
}
#[tauri::command]
pub async fn test_workflow_node(
    workflow: Workflow,
    node_id: String,
    input_overrides: Option<Value>,
    previous_execution_id: Option<String>,
    allow_side_effects: Option<bool>,
    state: State<'_, AppState>,
) -> Result<ExecutionRecord> {
    state
        .engine
        .test_node(
            workflow,
            &node_id,
            input_overrides.unwrap_or_else(|| json!({})),
            previous_execution_id.as_deref(),
            allow_side_effects.unwrap_or(false),
            CancellationToken::new(),
        )
        .await
        .map_err(err)
}
#[tauri::command]
pub async fn retry_failed_node(
    execution_id: String,
    node_id: String,
    state: State<'_, AppState>,
) -> Result<ExecutionRecord> {
    let execution = state
        .engine
        .database()
        .get_execution(&execution_id)
        .map_err(err)?
        .ok_or_else(|| "Execution no longer exists.".to_string())?;
    let token = CancellationToken::new();
    let owns_token = {
        let mut active = state.cancellations.lock();
        match active.entry(execution.workflow_id.clone()) {
            Entry::Vacant(entry) => {
                entry.insert(token.clone());
                true
            }
            Entry::Occupied(_) => false,
        }
    };
    let result = state
        .engine
        .retry_failed_node(&execution_id, &node_id, token)
        .await
        .map_err(err);
    if owns_token {
        state.cancellations.lock().remove(&execution.workflow_id);
    }
    result
}

#[tauri::command]
pub async fn retry_browser_execution_headed(
    execution_id: String,
    state: State<'_, AppState>,
) -> Result<ExecutionRecord> {
    let previous = state
        .engine
        .database()
        .get_execution(&execution_id)
        .map_err(err)?
        .ok_or_else(|| "Execution no longer exists.".to_string())?;
    let mut workflow = state
        .engine
        .database()
        .get_workflow(&previous.workflow_id)
        .map_err(err)?
        .ok_or_else(|| "Workflow no longer exists.".to_string())?;
    let mut browser_found = false;
    for node in &mut workflow.nodes {
        if node.node_type == "open_browser" {
            let configuration = node
                .configuration
                .as_object_mut()
                .ok_or_else(|| "Open Browser has invalid configuration.".to_string())?;
            configuration.insert("headed".into(), Value::Bool(true));
            browser_found = true;
        }
    }
    if !browser_found {
        return Err("This execution does not contain an Open Browser node.".into());
    }
    let token = CancellationToken::new();
    let owns_token = {
        let mut active = state.cancellations.lock();
        match active.entry(workflow.id.clone()) {
            Entry::Vacant(entry) => {
                entry.insert(token.clone());
                true
            }
            Entry::Occupied(_) => false,
        }
    };
    let workflow_id = workflow.id.clone();
    let result = state
        .engine
        .run(workflow, previous.trigger, token)
        .await
        .map_err(err);
    if owns_token {
        state.cancellations.lock().remove(&workflow_id);
    }
    result
}

#[tauri::command]
pub fn open_execution_artifact(
    path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<()> {
    let artifact_root = state.data_dir.join("artifacts");
    let root = std::fs::canonicalize(&artifact_root).map_err(|_| {
        "Execution artifacts are no longer available. Run the workflow again to capture new evidence."
            .to_string()
    })?;
    let candidate = std::fs::canonicalize(&path).map_err(|_| {
        "This execution artifact no longer exists. It may have expired under the retention policy."
            .to_string()
    })?;
    if !candidate.is_file() || !candidate.starts_with(&root) {
        return Err(
            "Only files created inside the execution artifact directory can be opened.".into(),
        );
    }
    app.opener()
        .open_path(candidate.to_string_lossy().to_string(), None::<&str>)
        .map_err(err)
}
#[tauri::command]
pub fn cancel_execution(execution_id: String, state: State<'_, AppState>) -> Result<()> {
    let execution = state
        .engine
        .database()
        .get_execution(&execution_id)
        .map_err(err)?
        .ok_or_else(|| "Execution no longer exists.".to_string())?;
    state
        .cancellations
        .lock()
        .get(&execution.workflow_id)
        .ok_or_else(|| "This execution is no longer active.".to_string())?
        .cancel();
    Ok(())
}
#[tauri::command]
pub fn list_executions(
    workflow_id: Option<String>,
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<ExecutionRecord>> {
    state
        .engine
        .database()
        .list_executions(workflow_id.as_deref(), limit.unwrap_or(100).min(500))
        .map_err(err)
}
#[tauri::command]
pub fn get_execution(id: String, state: State<'_, AppState>) -> Result<Option<ExecutionRecord>> {
    state.engine.database().get_execution(&id).map_err(err)
}
#[tauri::command]
pub fn clear_execution_history(keep: Option<usize>, state: State<'_, AppState>) -> Result<usize> {
    let (removed, artifacts) = state
        .engine
        .database()
        .clear_old_executions(keep.unwrap_or(0))
        .map_err(err)?;
    remove_safe_artifacts(artifacts, &state.data_dir.join("artifacts"));
    Ok(removed)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionQuery {
    search: Option<String>,
    workflow_ids: Option<Vec<String>>,
    statuses: Option<Vec<sandbox_engine::ExecutionStatus>>,
    trigger_types: Option<Vec<String>>,
    started_after: Option<DateTime<Utc>>,
    started_before: Option<DateTime<Utc>>,
    cursor: Option<String>,
    limit: Option<usize>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionPage {
    items: Vec<ExecutionRecord>,
    next_cursor: Option<String>,
}

#[tauri::command]
pub fn query_executions(
    query: ExecutionQuery,
    state: State<'_, AppState>,
) -> Result<ExecutionPage> {
    let workflows = state
        .engine
        .database()
        .list_workflows_including_archived(true)
        .map_err(err)?;
    let mut items = state.engine.database().all_executions().map_err(err)?;
    items.sort_by(|left, right| {
        right
            .started_at
            .cmp(&left.started_at)
            .then_with(|| right.id.cmp(&left.id))
    });
    if let Some(search) = query.search.filter(|value| !value.trim().is_empty()) {
        let needle = search.to_lowercase();
        items.retain(|run| {
            workflows
                .iter()
                .find(|item| item.workflow.id == run.workflow_id)
                .is_some_and(|item| item.workflow.name.to_lowercase().contains(&needle))
                || run
                    .error
                    .as_ref()
                    .is_some_and(|error| error.message.to_lowercase().contains(&needle))
                || run.node_executions.iter().any(|node| {
                    node.error.as_ref().is_some_and(|error| {
                        error.message.to_lowercase().contains(&needle)
                            || error
                                .detail
                                .as_ref()
                                .is_some_and(|detail| detail.to_lowercase().contains(&needle))
                    })
                })
        });
    }
    if let Some(ids) = query.workflow_ids.filter(|value| !value.is_empty()) {
        items.retain(|run| ids.contains(&run.workflow_id));
    }
    if let Some(statuses) = query.statuses.filter(|value| !value.is_empty()) {
        items.retain(|run| statuses.contains(&run.status));
    }
    if let Some(types) = query.trigger_types.filter(|value| !value.is_empty()) {
        items.retain(|run| {
            run.trigger
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|value| types.iter().any(|item| item == value))
        });
    }
    if let Some(after) = query.started_after {
        items.retain(|run| run.started_at >= after);
    }
    if let Some(before) = query.started_before {
        items.retain(|run| run.started_at <= before);
    }
    if let Some(cursor) = query.cursor {
        if let Some((started, id)) = cursor.split_once('|') {
            if let Ok(started) =
                DateTime::parse_from_rfc3339(started).map(|value| value.with_timezone(&Utc))
            {
                items.retain(|run| {
                    run.started_at < started || (run.started_at == started && run.id.as_str() < id)
                });
            }
        }
    }
    let limit = query.limit.unwrap_or(50).clamp(1, 100);
    let has_more = items.len() > limit;
    items.truncate(limit);
    let next_cursor = if has_more {
        items
            .last()
            .map(|run| format!("{}|{}", run.started_at.to_rfc3339(), run.id))
    } else {
        None
    };
    Ok(ExecutionPage { items, next_cursor })
}

#[tauri::command]
pub fn delete_execution(id: String, state: State<'_, AppState>) -> Result<()> {
    let artifacts = state.engine.database().delete_execution(&id).map_err(err)?;
    remove_safe_artifacts(artifacts, &state.data_dir.join("artifacts"));
    Ok(())
}
#[tauri::command]
pub fn approve_permissions(
    id: String,
    mut permissions: PermissionSummary,
    state: State<'_, AppState>,
) -> Result<Workflow> {
    let mut workflow = state
        .engine
        .database()
        .get_workflow(&id)
        .map_err(err)?
        .ok_or_else(|| "Workflow no longer exists.".to_string())?;
    permissions.approval_revision = Some(Uuid::new_v4().to_string());
    workflow.settings.permissions = permissions;
    state.engine.database().save_workflow(workflow).map_err(err)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerStatus {
    paused: bool,
    active_workflow_ids: Vec<String>,
    local_schedules_stop_on_quit: bool,
    scheduled_workflow_count: usize,
    next_run_at: Option<DateTime<Utc>>,
}
#[tauri::command]
pub fn runner_status(state: State<'_, AppState>) -> RunnerStatus {
    let scheduled = state
        .engine
        .database()
        .list_workflows()
        .unwrap_or_default()
        .into_iter()
        .filter(|item| {
            item.workflow.enabled
                && item
                    .workflow
                    .nodes
                    .iter()
                    .any(|node| node.node_type == "schedule_trigger")
        })
        .collect::<Vec<_>>();
    RunnerStatus {
        paused: state.paused.load(Ordering::SeqCst),
        active_workflow_ids: state.cancellations.lock().keys().cloned().collect(),
        local_schedules_stop_on_quit: true,
        scheduled_workflow_count: scheduled.len(),
        next_run_at: scheduled
            .into_iter()
            .filter_map(|item| item.next_run_at)
            .min(),
    }
}

#[tauri::command]
pub fn set_runner_paused(paused: bool, app: AppHandle, state: State<'_, AppState>) -> RunnerStatus {
    state.paused.store(paused, Ordering::SeqCst);
    let status = runner_status(state);
    let _ = app.emit("runner-status-changed", &status);
    status
}

#[tauri::command]
pub async fn browser_engine_status(
    state: State<'_, AppState>,
) -> Result<crate::browser_sidecar::BrowserEngineStatus> {
    Ok(state.browser_sidecar.status().await)
}

#[tauri::command]
pub async fn restart_browser_engine(
    state: State<'_, AppState>,
) -> Result<crate::browser_sidecar::BrowserEngineStatus> {
    state.browser_sidecar.restart().await
}

#[tauri::command]
pub fn list_browser_profiles(state: State<'_, AppState>) -> Result<Vec<BrowserProfile>> {
    state.engine.database().list_browser_profiles().map_err(err)
}

#[tauri::command]
pub fn create_browser_profile(
    name: String,
    persistent: Option<bool>,
    settings: Option<BrowserProfileSettings>,
    state: State<'_, AppState>,
) -> Result<BrowserProfile> {
    let name = name.trim();
    if name.is_empty() || name.len() > 80 {
        return Err("Browser profile name must contain 1 to 80 characters.".into());
    }
    let id = Uuid::new_v4().to_string();
    let path = state.data_dir.join("browser-profiles").join(&id);
    std::fs::create_dir_all(&path).map_err(err)?;
    let profile = BrowserProfile {
        id,
        name: name.into(),
        persistent: persistent.unwrap_or(true),
        data_path: path.to_string_lossy().to_string(),
        settings: settings.unwrap_or_default(),
        created_at: chrono::Utc::now(),
        last_used_at: None,
    };
    state
        .engine
        .database()
        .save_browser_profile(&profile)
        .map_err(err)?;
    Ok(profile)
}

#[tauri::command]
pub fn update_browser_profile(
    id: String,
    name: String,
    persistent: bool,
    settings: BrowserProfileSettings,
    state: State<'_, AppState>,
) -> Result<BrowserProfile> {
    let mut profile = state
        .engine
        .database()
        .get_browser_profile(&id)
        .map_err(err)?
        .ok_or_else(|| "Browser profile no longer exists.".to_string())?;
    if name.trim().is_empty() || name.len() > 80 {
        return Err("Browser profile name must contain 1 to 80 characters.".into());
    }
    profile.name = name.trim().into();
    profile.persistent = persistent;
    profile.settings = settings;
    state
        .engine
        .database()
        .save_browser_profile(&profile)
        .map_err(err)?;
    Ok(profile)
}

#[tauri::command]
pub fn duplicate_browser_profile(id: String, state: State<'_, AppState>) -> Result<BrowserProfile> {
    let source = state
        .engine
        .database()
        .get_browser_profile(&id)
        .map_err(err)?
        .ok_or_else(|| "Browser profile no longer exists.".to_string())?;
    let new_id = Uuid::new_v4().to_string();
    let path = state.data_dir.join("browser-profiles").join(&new_id);
    std::fs::create_dir_all(&path).map_err(err)?;
    let profile = BrowserProfile {
        id: new_id,
        name: format!("{} copy", source.name),
        persistent: source.persistent,
        data_path: path.to_string_lossy().to_string(),
        settings: source.settings,
        created_at: chrono::Utc::now(),
        last_used_at: None,
    };
    state
        .engine
        .database()
        .save_browser_profile(&profile)
        .map_err(err)?;
    Ok(profile)
}

#[tauri::command]
pub async fn clear_browser_profile_data(id: String, state: State<'_, AppState>) -> Result<()> {
    let profile = state
        .engine
        .database()
        .get_browser_profile(&id)
        .map_err(err)?
        .ok_or_else(|| "Browser profile no longer exists.".to_string())?;
    state
        .browser_sidecar
        .request("close_all", json!({}))
        .await
        .map_err(err)?;
    let path = checked_profile_path(&state, &profile)?;
    if path.exists() {
        std::fs::remove_dir_all(&path).map_err(err)?;
    }
    std::fs::create_dir_all(&path).map_err(err)?;
    Ok(())
}

#[tauri::command]
pub async fn delete_browser_profile(id: String, state: State<'_, AppState>) -> Result<()> {
    let profile = state
        .engine
        .database()
        .get_browser_profile(&id)
        .map_err(err)?
        .ok_or_else(|| "Browser profile no longer exists.".to_string())?;
    let used = state
        .engine
        .database()
        .workflows_using_reference(&id)
        .map_err(err)?;
    if !used.is_empty() {
        return Err(format!("This browser profile is used by {} workflow(s). Remove those references before deleting it.",used.len()));
    }
    state
        .browser_sidecar
        .request("close_all", json!({}))
        .await
        .map_err(err)?;
    let path = checked_profile_path(&state, &profile)?;
    if path.exists() {
        std::fs::remove_dir_all(&path).map_err(err)?;
    }
    state
        .engine
        .database()
        .delete_browser_profile(&id)
        .map_err(err)
}

#[tauri::command]
pub async fn open_browser_profile(
    id: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value> {
    let profile = state
        .engine
        .database()
        .get_browser_profile(&id)
        .map_err(err)?
        .ok_or_else(|| "Browser profile no longer exists.".to_string())?;
    state.browser_sidecar.request("open_browser",json!({"profileId":profile.id,"profilePath":profile.data_path,"persistent":profile.persistent,"headed":true,"viewport":{"width":profile.settings.viewport_width,"height":profile.settings.viewport_height},"userAgent":profile.settings.user_agent,"proxy":profile.settings.proxy,"closeAutomatically":false})).await.map_err(err)
}

#[tauri::command]
pub async fn start_browser_recording(
    profile_id: String,
    initial_url: Option<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value> {
    let opened = open_browser_profile(profile_id, state.clone()).await?;
    let session_id = opened
        .get("browserSession")
        .and_then(|value| value.get("sessionId"))
        .and_then(|value| value.as_str())
        .ok_or_else(|| "The browser recorder did not receive a session.".to_string())?;
    state
        .browser_sidecar
        .request(
            "recorder_start",
            json!({"sessionId":session_id,"initialUrl":initial_url}),
        )
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn stop_browser_recording(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value> {
    let result = state
        .browser_sidecar
        .request("recorder_stop", json!({"sessionId":session_id}))
        .await
        .map_err(err)?;
    let _ = state
        .browser_sidecar
        .request("close_browser", json!({"sessionId":session_id}))
        .await;
    Ok(result)
}

#[tauri::command]
pub async fn get_browser_recording(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value> {
    state
        .browser_sidecar
        .request("recorder_snapshot", json!({"sessionId":session_id}))
        .await
        .map_err(err)
}

#[tauri::command]
pub fn list_connections(state: State<'_, AppState>) -> Result<Vec<ConnectionMetadata>> {
    state.engine.database().list_connections().map_err(err)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BugReportDraft {
    summary: String,
    description: String,
    #[serde(default)]
    diagnostics: std::collections::BTreeMap<String, String>,
}

#[tauri::command]
pub async fn submit_bug_report(report: BugReportDraft) -> Result<Value> {
    let payload = normalized_bug_report_payload(report)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(err)?;
    let base = account_auth::control_plane_url()?;
    let response = client
        .post(format!(
            "{}/v1/support/bug-reports",
            base.trim_end_matches('/')
        ))
        .header("accept", "application/json")
        .header("idempotency-key", Uuid::new_v4().to_string())
        .header("x-sndbox-client-version", env!("CARGO_PKG_VERSION"))
        .json(&payload)
        .send()
        .await
        .map_err(|error| format!("sndbox support could not be reached: {error}"))?;
    let status = response.status();
    if response
        .content_length()
        .is_some_and(|length| length > 64 * 1024)
    {
        return Err("sndbox support returned an oversized response.".into());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("sndbox support response could not be read: {error}"))?;
    if bytes.len() > 64 * 1024 {
        return Err("sndbox support returned an oversized response.".into());
    }
    let response_payload: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "sndbox support returned an invalid response.".to_string())?;
    if !status.is_success() {
        let message = response_payload
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("The bug report could not be delivered.");
        let reference = response_payload
            .get("correlationId")
            .and_then(Value::as_str)
            .map(|value| format!(" Reference: {value}."))
            .unwrap_or_default();
        return Err(format!("{message}{reference}"));
    }
    Ok(response_payload)
}

fn normalized_bug_report_payload(report: BugReportDraft) -> Result<Value> {
    let summary = limited_text(&report.summary, 120);
    let description = limited_text(&report.description, 2_000);
    if summary.chars().count() < 4 {
        return Err("Bug report summary must be at least 4 characters.".into());
    }
    if description.chars().count() < 10 {
        return Err("Describe the problem in at least 10 characters.".into());
    }
    let diagnostics = report
        .diagnostics
        .iter()
        .take(10)
        .map(|(key, value)| (limited_text(key, 40), limited_text(value, 300)))
        .filter(|(key, _)| !key.is_empty())
        .collect::<std::collections::BTreeMap<_, _>>();
    Ok(json!({
        "summary": summary,
        "description": description,
        "diagnostics": diagnostics
    }))
}

fn limited_text(value: &str, maximum: usize) -> String {
    value.trim().chars().take(maximum).collect()
}

#[tauri::command]
pub fn create_file_grant(
    path: String,
    maximum_bytes: u64,
    state: State<'_, AppState>,
) -> Result<Value> {
    let canonical = std::fs::canonicalize(&path)
        .map_err(|error| format!("The selected file is unavailable: {error}"))?;
    let metadata = std::fs::metadata(&canonical)
        .map_err(|error| format!("The selected file cannot be inspected: {error}"))?;
    if !metadata.is_file() {
        return Err("Secure file grants can reference files only, not directories.".into());
    }
    let maximum_bytes = maximum_bytes.clamp(1, 1024 * 1024 * 1024);
    if metadata.len() > maximum_bytes {
        return Err(format!(
            "The selected file is {} bytes, above this node's {}-byte limit.",
            metadata.len(),
            maximum_bytes
        ));
    }
    let expires_at = Utc::now() + chrono::Duration::minutes(15);
    let grant_id = state
        .engine
        .database()
        .create_file_grant(&canonical.to_string_lossy(), maximum_bytes, expires_at)
        .map_err(err)?;
    Ok(json!({
        "grantId": grant_id,
        "expiresAt": expires_at,
        "name": canonical.file_name().and_then(|value| value.to_str()).unwrap_or("file"),
        "size": metadata.len()
    }))
}

#[tauri::command]
pub fn create_connection(
    provider: String,
    display_name: String,
    account_identifier: Option<String>,
    scopes: Vec<String>,
    expires_at: Option<DateTime<Utc>>,
    metadata: Value,
    secret: Value,
    state: State<'_, AppState>,
) -> Result<ConnectionMetadata> {
    validate_connection_input(&provider, &display_name, &metadata, &secret)?;
    let connection = ConnectionMetadata {
        id: Uuid::new_v4().to_string(),
        provider: provider.to_lowercase(),
        display_name: display_name.trim().to_string(),
        account_identifier: account_identifier.filter(|value| !value.trim().is_empty()),
        scopes,
        created_at: Utc::now(),
        last_used_at: None,
        expires_at,
        status: ConnectionStatus::Connected,
        metadata,
    };
    state.credential_vault.put(&connection.id, &secret)?;
    if let Err(error) = state.engine.database().save_connection(&connection) {
        let _ = state.credential_vault.delete(&connection.id);
        return Err(error.to_string());
    }
    Ok(connection)
}

#[tauri::command]
pub fn rename_connection(
    id: String,
    display_name: String,
    state: State<'_, AppState>,
) -> Result<ConnectionMetadata> {
    if display_name.trim().is_empty() {
        return Err("Connection name is required.".into());
    }
    let mut connection = state
        .engine
        .database()
        .get_connection(&id)
        .map_err(err)?
        .ok_or_else(|| "Connection no longer exists.".to_string())?;
    connection.display_name = display_name.trim().to_string();
    state
        .engine
        .database()
        .save_connection(&connection)
        .map_err(err)?;
    Ok(connection)
}

#[tauri::command]
pub fn reconnect_connection(
    id: String,
    secret: Value,
    expires_at: Option<DateTime<Utc>>,
    state: State<'_, AppState>,
) -> Result<ConnectionMetadata> {
    let mut connection = state
        .engine
        .database()
        .get_connection(&id)
        .map_err(err)?
        .ok_or_else(|| "Connection no longer exists.".to_string())?;
    validate_connection_input(
        &connection.provider,
        &connection.display_name,
        &connection.metadata,
        &secret,
    )?;
    state.credential_vault.put(&id, &secret)?;
    connection.expires_at = expires_at;
    connection.status = ConnectionStatus::Connected;
    state
        .engine
        .database()
        .save_connection(&connection)
        .map_err(err)?;
    Ok(connection)
}

#[tauri::command]
pub async fn test_connection(id: String, state: State<'_, AppState>) -> Result<Value> {
    let connection = state
        .engine
        .database()
        .get_connection(&id)
        .map_err(err)?
        .ok_or_else(|| "Connection no longer exists.".to_string())?;
    if !state.credential_vault.exists(&id)? {
        return Err(format!(
            "{} has no secret in the operating-system credential store. Reconnect it.",
            connection.display_name
        ));
    }
    if matches!(
        connection.provider.as_str(),
        "openai" | "anthropic" | "openai_compatible"
    ) {
        let secret = state.credential_vault.get(&id)?;
        let api_key = secret
            .get("apiKey")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "The AI API key is missing. Reconnect this provider.".to_string())?;
        return crate::ai_builder::test_ai_provider_connection(
            &connection.provider,
            &connection.metadata,
            api_key,
        )
        .await;
    }
    Ok(
        json!({"healthy":true,"provider":connection.provider,"message":"Credential is available in the operating-system store."}),
    )
}

#[tauri::command]
pub async fn revoke_connection(
    id: String,
    state: State<'_, AppState>,
) -> Result<ConnectionMetadata> {
    let mut connection = state
        .engine
        .database()
        .get_connection(&id)
        .map_err(err)?
        .ok_or_else(|| "Connection no longer exists.".to_string())?;
    if state.credential_vault.exists(&id)? {
        if connection.provider == "gmail" || connection.provider == "google_workspace" {
            let secret = state.credential_vault.get(&id)?;
            let token = secret.get("refreshToken").or_else(|| secret.get("accessToken")).and_then(Value::as_str).ok_or_else(|| "The Gmail token is unavailable. Delete the local connection if it was already revoked at Google.".to_string())?;
            let response = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .map_err(err)?
                .post(oauth::GMAIL_REVOKE_URL)
                .form(&[("token", token)])
                .send()
                .await
                .map_err(|error| format!("Gmail revocation could not connect: {error}"))?;
            if !response.status().is_success() {
                return Err(format!("Gmail rejected token revocation with HTTP {}. The local secret was retained so you can retry.", response.status()));
            }
        }
        state.credential_vault.delete(&id)?;
    }
    connection.status = ConnectionStatus::Revoked;
    state
        .engine
        .database()
        .save_connection(&connection)
        .map_err(err)?;
    Ok(connection)
}

#[tauri::command]
pub fn delete_connection(id: String, state: State<'_, AppState>) -> Result<()> {
    if state.credential_vault.exists(&id)? {
        state.credential_vault.delete(&id)?;
    }
    state.engine.database().delete_connection(&id).map_err(err)
}

#[tauri::command]
pub fn workflows_using_connection(id: String, state: State<'_, AppState>) -> Result<Vec<String>> {
    state
        .engine
        .database()
        .workflows_using_reference(&id)
        .map_err(err)
}

#[tauri::command]
pub fn account_status(state: State<'_, AppState>) -> Result<account_auth::AccountStatus> {
    let configuration = account_auth::configured();
    let metadata = state
        .engine
        .database()
        .get_setting::<account_auth::AccountMetadata>(account_auth::ACCOUNT_METADATA_KEY)
        .map_err(err)?;
    let has_secret = state
        .credential_vault
        .exists(account_auth::ACCOUNT_VAULT_ID)?;
    Ok(account_auth::AccountStatus {
        configured: configuration.is_ok(),
        signed_in: metadata.is_some() && has_secret,
        metadata,
        local_workflows_available: true,
        configuration_error: configuration.err(),
    })
}

fn checked_uuid(value: &str, label: &str) -> Result<String> {
    Uuid::parse_str(value)
        .map(|value| value.to_string())
        .map_err(|_| format!("{label} ID must be a UUID."))
}

async fn control_plane_json(
    state: &AppState,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value> {
    if !path.starts_with("/v1/")
        || path.starts_with("//")
        || path.contains('\\')
        || path.contains("..")
        || path.contains('#')
    {
        return Err("Control-plane request path is invalid.".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(err)?;
    let stored = state
        .credential_vault
        .get(account_auth::ACCOUNT_VAULT_ID)
        .map_err(|_| "Sign in to use workspace and sync features.".to_string())?;
    let mut secret: account_auth::AccountSecret = serde_json::from_value(stored)
        .map_err(|_| "The stored account session is invalid. Sign in again.".to_string())?;
    if secret.expires_at <= Utc::now() + chrono::Duration::seconds(60) {
        secret = account_auth::refresh(&client, &secret).await?;
        state.credential_vault.put(
            account_auth::ACCOUNT_VAULT_ID,
            &serde_json::to_value(&secret).map_err(err)?,
        )?;
        if let Some(mut metadata) = state
            .engine
            .database()
            .get_setting::<account_auth::AccountMetadata>(account_auth::ACCOUNT_METADATA_KEY)
            .map_err(err)?
        {
            metadata.expires_at = secret.expires_at;
            state
                .engine
                .database()
                .set_setting(account_auth::ACCOUNT_METADATA_KEY, &metadata)
                .map_err(err)?;
        }
    }
    let base = account_auth::control_plane_url()?;
    let mut request = client
        .request(
            method.clone(),
            format!("{}{}", base.trim_end_matches('/'), path),
        )
        .bearer_auth(&secret.access_token)
        .header("accept", "application/json")
        .header("x-correlation-id", Uuid::new_v4().to_string());
    if method != Method::GET && method != Method::HEAD {
        request = request.header("x-idempotency-key", Uuid::new_v4().to_string());
    }
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("sndbox could not reach the account service: {error}"))?;
    if response
        .content_length()
        .is_some_and(|length| length > 3 * 1024 * 1024)
    {
        return Err("Account service response exceeded the 3 MB safety limit.".into());
    }
    let status = response.status();
    let correlation_id = response
        .headers()
        .get("x-correlation-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Account service response could not be read: {error}"))?;
    if bytes.len() > 3 * 1024 * 1024 {
        return Err("Account service response exceeded the 3 MB safety limit.".into());
    }
    let payload: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "Account service returned an invalid JSON response.".to_string())?;
    if !status.is_success() {
        let message = payload
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("The account service rejected the request.");
        return Err(match correlation_id {
            Some(correlation_id) => {
                format!("{message} (HTTP {status}, reference {correlation_id})")
            }
            None => format!("{message} (HTTP {status})"),
        });
    }
    Ok(payload)
}

#[tauri::command]
pub async fn start_account_auth(
    create_account: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<account_auth::AccountAuthStart> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", ACCOUNT_AUTH_CALLBACK_PORT))
        .await
        .map_err(|error| {
            format!(
                "sndbox could not open its local account callback on port {ACCOUNT_AUTH_CALLBACK_PORT}: {error}"
            )
        })?;
    let address = listener.local_addr().map_err(err)?;
    let redirect_uri = format!("http://127.0.0.1:{ACCOUNT_AUTH_CALLBACK_PORT}/account/callback");
    let (attempt, start) = account_auth::start(redirect_uri, create_account)?;
    app.opener()
        .open_url(&start.authorization_url, None::<&str>)
        .map_err(|error| {
            format!("The account page could not be opened in the system browser: {error}")
        })?;
    let database = state.engine.database().clone();
    let vault = state.credential_vault.clone();
    tauri::async_runtime::spawn(async move {
        let result: Result<account_auth::AccountMetadata> = async {
            let (mut stream, _) =
                tokio::time::timeout(std::time::Duration::from_secs(300), listener.accept())
                    .await
                    .map_err(|_| "Account authorization expired after five minutes.".to_string())?
                    .map_err(|error| format!("Account callback could not be accepted: {error}"))?;
            let mut request = vec![0_u8; 16 * 1024];
            let count = stream.read(&mut request).await.map_err(err)?;
            let request = String::from_utf8_lossy(&request[..count]);
            let target = request
                .lines()
                .next()
                .and_then(|line| line.split_whitespace().nth(1))
                .ok_or_else(|| "Account callback request was invalid.".to_string())?;
            let callback_url = format!("http://127.0.0.1:{}{}", address.port(), target);
            let code = match attempt.validate_callback(&callback_url) {
                Ok(code) => code,
                Err(error) => {
                    write_oauth_response(&mut stream, false, &error).await;
                    return Err(error);
                }
            };
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(err)?;
            let (secret, metadata) = match attempt.exchange(&client, &code).await {
                Ok(value) => value,
                Err(error) => {
                    write_oauth_response(&mut stream, false, &error).await;
                    return Err(error);
                }
            };
            vault.put(
                account_auth::ACCOUNT_VAULT_ID,
                &serde_json::to_value(&secret).map_err(err)?,
            )?;
            if let Err(error) = database.set_setting(account_auth::ACCOUNT_METADATA_KEY, &metadata)
            {
                let _ = vault.delete(account_auth::ACCOUNT_VAULT_ID);
                return Err(error.to_string());
            }
            write_oauth_response(
                &mut stream,
                true,
                "sndbox is connected. You can close this tab and return to the desktop app.",
            )
            .await;
            Ok(metadata)
        }
        .await;
        match result {
            Ok(metadata) => {
                let _ = app.emit("account-session-updated", metadata);
            }
            Err(error) => {
                let _ = app.emit("account-session-error", error);
            }
        }
    });
    Ok(start)
}

#[tauri::command]
pub fn sign_out_account(state: State<'_, AppState>) -> Result<()> {
    if state
        .credential_vault
        .exists(account_auth::ACCOUNT_VAULT_ID)?
    {
        state
            .credential_vault
            .delete(account_auth::ACCOUNT_VAULT_ID)?;
    }
    state
        .engine
        .database()
        .delete_setting(account_auth::ACCOUNT_METADATA_KEY)
        .map_err(err)
}

#[tauri::command]
pub fn list_pending_approvals(state: State<'_, AppState>) -> Result<Vec<PendingApproval>> {
    state
        .engine
        .database()
        .list_pending_approvals()
        .map_err(err)
}

#[tauri::command]
pub fn resolve_pending_approval(
    id: String,
    approved: bool,
    state: State<'_, AppState>,
) -> Result<()> {
    let changed = state
        .engine
        .database()
        .resolve_pending_approval(&id, if approved { "approved" } else { "rejected" })
        .map_err(err)?;
    if changed {
        Ok(())
    } else {
        Err("This approval was already resolved or has expired.".into())
    }
}

fn validate_connection_input(
    provider: &str,
    display_name: &str,
    metadata: &Value,
    secret: &Value,
) -> Result<()> {
    if !matches!(
        provider.to_lowercase().as_str(),
        "gmail"
            | "discord"
            | "slack"
            | "google_workspace"
            | "slack_oauth"
            | "notion"
            | "github_app"
            | "openai"
            | "anthropic"
            | "openai_compatible"
    ) {
        return Err("This connection provider is not supported.".into());
    }
    if display_name.trim().is_empty() {
        return Err("Connection name is required.".into());
    }
    if !secret.is_object() || secret.as_object().is_some_and(|object| object.is_empty()) {
        return Err("Connection secret material is required and will be stored only in the operating-system vault.".into());
    }
    if contains_sensitive_metadata(metadata) {
        return Err("Connection metadata contains a secret-like field. Tokens, passwords, and webhook URLs must be stored in the credential vault.".into());
    }
    Ok(())
}

fn contains_sensitive_metadata(value: &Value) -> bool {
    match value {
        Value::Object(object) => object.iter().any(|(key, value)| {
            let key = key.to_lowercase();
            [
                "secret",
                "token",
                "password",
                "webhook",
                "authorization",
                "cookie",
            ]
            .iter()
            .any(|part| key.contains(part))
                || contains_sensitive_metadata(value)
        }),
        Value::Array(values) => values.iter().any(contains_sensitive_metadata),
        _ => false,
    }
}

#[tauri::command]
pub async fn start_gmail_oauth(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<oauth::OAuthStart> {
    let client_id = oauth::gmail_client_id()?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| format!("sndbox could not open a local OAuth callback port: {error}"))?;
    let address = listener.local_addr().map_err(err)?;
    let redirect_uri = format!("http://127.0.0.1:{}/oauth/callback", address.port());
    let (attempt, start) = oauth::start_gmail(&client_id, redirect_uri.clone())?;
    app.opener()
        .open_url(&start.authorization_url, None::<&str>)
        .map_err(|error| format!("The Gmail authorization page could not be opened: {error}"))?;
    let database = state.engine.database().clone();
    let vault = state.credential_vault.clone();
    tauri::async_runtime::spawn(async move {
        let result: Result<ConnectionMetadata> = async {
            let (mut stream, _) =
                tokio::time::timeout(std::time::Duration::from_secs(300), listener.accept())
                    .await
                    .map_err(|_| "Gmail authorization expired after five minutes.".to_string())?
                    .map_err(|error| format!("OAuth callback could not be accepted: {error}"))?;
            let mut request = vec![0_u8; 16 * 1024];
            let count = stream.read(&mut request).await.map_err(err)?;
            let request = String::from_utf8_lossy(&request[..count]);
            let target = request
                .lines()
                .next()
                .and_then(|line| line.split_whitespace().nth(1))
                .ok_or_else(|| "OAuth callback request was invalid.".to_string())?;
            let callback_url = format!("http://127.0.0.1:{}{}", address.port(), target);
            let code = match attempt.validate_callback(&callback_url) {
                Ok(code) => code,
                Err(error) => {
                    write_oauth_response(&mut stream, false, &error).await;
                    return Err(error);
                }
            };
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .map_err(err)?;
            let token = match oauth::exchange_gmail_code(&client, &client_id, &attempt, &code).await
            {
                Ok(token) => token,
                Err(error) => {
                    write_oauth_response(&mut stream, false, &error).await;
                    return Err(error);
                }
            };
            let profile: Value = client
                .get("https://gmail.googleapis.com/gmail/v1/users/me/profile")
                .bearer_auth(&token.access_token)
                .send()
                .await
                .map_err(|error| format!("Gmail profile could not be read: {error}"))?
                .json()
                .await
                .map_err(|error| format!("Gmail profile response was invalid: {error}"))?;
            let email = profile
                .get("emailAddress")
                .and_then(Value::as_str)
                .unwrap_or("Gmail account")
                .to_string();
            let connection = ConnectionMetadata {
                id: Uuid::new_v4().to_string(),
                provider: "gmail".into(),
                display_name: email.clone(),
                account_identifier: Some(email),
                scopes: token
                    .scope
                    .as_deref()
                    .unwrap_or(oauth::GMAIL_SCOPES)
                    .split_whitespace()
                    .map(str::to_string)
                    .collect(),
                created_at: Utc::now(),
                last_used_at: None,
                expires_at: token
                    .expires_in
                    .map(|seconds| Utc::now() + chrono::Duration::seconds(seconds)),
                status: ConnectionStatus::Connected,
                metadata: json!({"authType":"oauth2_pkce"}),
            };
            vault.put(&connection.id, &oauth::token_secret(&token))?;
            if let Err(error) = database.save_connection(&connection) {
                let _ = vault.delete(&connection.id);
                return Err(error.to_string());
            }
            write_oauth_response(
                &mut stream,
                true,
                "Gmail is connected. You can close this tab and return to sndbox.",
            )
            .await;
            Ok(connection)
        }
        .await;
        match result {
            Ok(connection) => {
                let _ = app.emit("connection-updated", connection);
            }
            Err(error) => {
                let _ = app.emit("connection-error", error);
            }
        }
    });
    Ok(start)
}

#[tauri::command]
pub async fn start_integration_oauth(
    provider: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<oauth::OAuthStart> {
    if provider == "github_app" {
        return start_github_device_oauth(app, state).await;
    }
    let (
        port,
        client_id_env,
        client_secret_env,
        authorization_endpoint,
        token_endpoint,
        scopes,
        extra,
    ) = match provider.as_str() {
        "google_workspace" => (
            0,
            "SANDBOX_GOOGLE_WORKSPACE_CLIENT_ID",
            None,
            "https://accounts.google.com/o/oauth2/v2/auth",
            "https://oauth2.googleapis.com/token",
            oauth::GOOGLE_WORKSPACE_SCOPES,
            vec![],
        ),
        "slack_oauth" => (
            42_818,
            "SANDBOX_SLACK_CLIENT_ID",
            Some("SANDBOX_SLACK_CLIENT_SECRET"),
            "https://slack.com/oauth/v2/authorize",
            "https://slack.com/api/oauth.v2.access",
            "channels:history,channels:read,chat:write,reactions:write,files:write,users:read",
            vec![],
        ),
        "notion" => (
            42_819,
            "SANDBOX_NOTION_CLIENT_ID",
            Some("SANDBOX_NOTION_CLIENT_SECRET"),
            "https://api.notion.com/v1/oauth/authorize",
            "https://api.notion.com/v1/oauth/token",
            "",
            vec![("owner", "user")],
        ),
        _ => return Err("Unsupported OAuth integration provider.".into()),
    };
    let client_id = configured_secret(client_id_env, &provider)?;
    let client_secret = client_secret_env
        .map(|name| configured_secret(name, &provider))
        .transpose()?;
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|error| format!("sndbox could not open the local OAuth callback: {error}"))?;
    let address = listener.local_addr().map_err(err)?;
    let redirect_uri = format!("http://127.0.0.1:{}/oauth/callback", address.port());
    let (attempt, start) = if provider == "google_workspace" {
        oauth::start_google_workspace(&client_id, redirect_uri.clone())?
    } else {
        oauth::start_code_flow(
            authorization_endpoint,
            &client_id,
            redirect_uri.clone(),
            scopes,
            &extra,
        )?
    };
    app.opener()
        .open_url(&start.authorization_url, None::<&str>)
        .map_err(|error| format!("The authorization page could not be opened: {error}"))?;
    let database = state.engine.database().clone();
    let vault = state.credential_vault.clone();
    let emitted_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result: Result<ConnectionMetadata> = async {
            let (mut stream, _) = tokio::time::timeout(std::time::Duration::from_secs(300), listener.accept()).await.map_err(|_| "Authorization expired after five minutes.".to_string())?.map_err(|error| format!("OAuth callback could not be accepted: {error}"))?;
            let mut request = vec![0_u8; 16 * 1024];
            let count = stream.read(&mut request).await.map_err(err)?;
            let target = String::from_utf8_lossy(&request[..count]).lines().next().and_then(|line| line.split_whitespace().nth(1)).ok_or_else(|| "OAuth callback request was invalid.".to_string())?.to_string();
            let code = attempt.validate_callback(&format!("http://127.0.0.1:{}{}", address.port(), target))?;
            let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(30)).redirect(reqwest::redirect::Policy::none()).build().map_err(err)?;
            let token: Value = match provider.as_str() {
                "google_workspace" => serde_json::to_value(oauth::exchange_gmail_code(&client,&client_id,&attempt,&code).await?).map_err(err)?,
                "slack_oauth" => provider_token_json(client.post(token_endpoint).form(&[("client_id",client_id.as_str()),("client_secret",client_secret.as_deref().unwrap_or("")),("code",code.as_str()),("redirect_uri",redirect_uri.as_str())]).send().await.map_err(err)?,"Slack").await?,
                "notion" => provider_token_json(client.post(token_endpoint).basic_auth(&client_id,client_secret.as_deref()).json(&json!({"grant_type":"authorization_code","code":code,"redirect_uri":redirect_uri})).send().await.map_err(err)?,"Notion").await?,
                _ => unreachable!(),
            };
            let access = token.get("access_token").or_else(||token.get("accessToken")).and_then(Value::as_str).ok_or_else(||"The provider did not return an access token.".to_string())?.to_string();
            let (display_name, account_identifier, metadata, granted_scopes) = match provider.as_str() {
                "google_workspace" => {
                    let profile = provider_token_json(client.get("https://www.googleapis.com/oauth2/v2/userinfo").bearer_auth(&access).send().await.map_err(err)?,"Google profile").await?;
                    let email=profile.get("email").and_then(Value::as_str).unwrap_or("Google Workspace").to_string();
                    (email.clone(),Some(email),json!({"authType":"oauth2_pkce","incrementalAuthorization":true}),token.get("scope").and_then(Value::as_str).unwrap_or(oauth::GOOGLE_WORKSPACE_SCOPES).split([' ', ',']).filter(|value|!value.is_empty()).map(str::to_string).collect())
                }
                "slack_oauth" => {
                    let auth=provider_token_json(client.post("https://slack.com/api/auth.test").bearer_auth(&access).send().await.map_err(err)?,"Slack profile").await?;
                    if auth.get("ok").and_then(Value::as_bool)!=Some(true){return Err("Slack could not validate the new connection.".into());}
                    let team=auth.get("team").and_then(Value::as_str).unwrap_or("Slack workspace").to_string();
                    (team.clone(),auth.get("user").and_then(Value::as_str).map(str::to_string),json!({"teamId":auth.get("team_id"),"userId":auth.get("user_id"),"authType":"oauth_v2"}),token.get("scope").and_then(Value::as_str).unwrap_or(scopes).split(',').filter(|value|!value.is_empty()).map(str::to_string).collect())
                }
                "notion" => {
                    let workspace=token.get("workspace_name").and_then(Value::as_str).unwrap_or("Notion workspace").to_string();
                    (workspace.clone(),token.get("workspace_id").and_then(Value::as_str).map(str::to_string),json!({"workspaceId":token.get("workspace_id"),"workspaceIcon":token.get("workspace_icon"),"botId":token.get("bot_id"),"owner":token.get("owner"),"authType":"oauth2"}),vec!["read_content".into(),"update_content".into(),"insert_content".into()])
                }
                _ => unreachable!(),
            };
            let connection=ConnectionMetadata{id:Uuid::new_v4().to_string(),provider:provider.clone(),display_name,account_identifier,scopes:granted_scopes,created_at:Utc::now(),last_used_at:None,expires_at:token.get("expires_in").or_else(||token.get("expiresIn")).and_then(Value::as_i64).map(|seconds|Utc::now()+chrono::Duration::seconds(seconds)),status:ConnectionStatus::Connected,metadata};
            let secret=json!({"accessToken":access,"refreshToken":token.get("refresh_token").or_else(||token.get("refreshToken")),"tokenType":token.get("token_type").or_else(||token.get("tokenType"))});
            vault.put(&connection.id,&secret)?;
            if let Err(error)=database.save_connection(&connection){let _=vault.delete(&connection.id);return Err(error.to_string());}
            write_oauth_response(&mut stream,true,"sndbox is connected. You can close this tab and return to the desktop app.").await;
            Ok(connection)
        }.await;
        match result {
            Ok(connection) => {
                let _ = emitted_app.emit("connection-updated", connection);
            }
            Err(error) => {
                let _ = emitted_app.emit("connection-error", error);
            }
        }
    });
    Ok(start)
}

#[tauri::command]
pub async fn list_integration_resources(
    connection_id: String,
    kind: String,
    parent: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<crate::provider_adapter::ProviderResource>> {
    let connection_id = checked_uuid(&connection_id, "Connection")?;
    if kind.len() > 80
        || !kind
            .chars()
            .all(|character| character.is_ascii_lowercase() || character == '_')
    {
        return Err("Resource picker kind is invalid.".into());
    }
    let adapter = state.provider_adapter.clone();
    tauri::async_runtime::spawn_blocking(move || {
        adapter
            .list_resources(&connection_id, &kind, parent.as_deref())
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("Resource picker worker failed: {error}"))?
}

#[tauri::command]
pub async fn configure_github_installation(
    connection_id: String,
    installation_id: u64,
    repositories: Vec<String>,
    state: State<'_, AppState>,
) -> Result<ConnectionMetadata> {
    let connection_id = checked_uuid(&connection_id, "Connection")?;
    if repositories.is_empty() || repositories.len() > 500 {
        return Err("Select between 1 and 500 repositories.".into());
    }
    let adapter = state.provider_adapter.clone();
    let lookup_id = connection_id.clone();
    let available = tauri::async_runtime::spawn_blocking(move || {
        adapter
            .list_resources(&lookup_id, "github_repository", None)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("GitHub repository picker failed: {error}"))??;
    let selected=repositories.iter().map(|name|{
        validate_repository_name(name)?;
        available.iter().find(|resource|resource.id==*name&&resource.metadata.get("installationId").and_then(Value::as_u64)==Some(installation_id)).map(|resource|json!({"repositoryId":resource.metadata.get("repositoryId"),"fullName":resource.id,"owner":resource.metadata.get("owner"),"permissions":resource.metadata.get("permissions")})).ok_or_else(||format!("Repository '{name}' is not accessible through the selected GitHub App installation."))
    }).collect::<Result<Vec<_>>>()?;
    let mut connection = state
        .engine
        .database()
        .get_connection(&connection_id)
        .map_err(err)?
        .ok_or_else(|| "The GitHub connection no longer exists.".to_string())?;
    if connection.provider != "github_app" {
        return Err("The selected connection is not a GitHub App connection.".into());
    }
    if !connection
        .metadata
        .get("installations")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items
                .iter()
                .any(|item| item.get("id").and_then(Value::as_u64) == Some(installation_id))
        })
    {
        return Err(
            "The selected GitHub App installation is not accessible to this account.".into(),
        );
    }
    connection.status = ConnectionStatus::Connected;
    connection.metadata["installationId"] = json!(installation_id);
    connection.metadata["accessibleOwner"] = selected
        .first()
        .and_then(|item| item.get("owner"))
        .cloned()
        .unwrap_or(Value::Null);
    connection.metadata["selectedRepositories"] = Value::Array(selected);
    connection.metadata["grantedPermissionSnapshot"] = connection
        .metadata
        .get("installations")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find(|item| item.get("id").and_then(Value::as_u64) == Some(installation_id))
        })
        .and_then(|item| item.get("permissions"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    connection.metadata["lastSuccessfulValidationTime"] = json!(Utc::now());
    if let Some(object) = connection.metadata.as_object_mut() {
        object.remove("attentionReason");
        object.remove("lastValidationFailureAt");
    }
    state
        .engine
        .database()
        .save_connection(&connection)
        .map_err(err)?;
    Ok(connection)
}

fn validate_repository_name(value: &str) -> Result<()> {
    let parts = value.split('/').collect::<Vec<_>>();
    if parts.len() != 2
        || parts.iter().any(|part| {
            part.is_empty()
                || !part.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
                })
        })
    {
        Err("Repository must use owner/name format.".into())
    } else {
        Ok(())
    }
}

async fn start_github_device_oauth(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<oauth::OAuthStart> {
    let client_id = configured_secret("SANDBOX_GITHUB_APP_CLIENT_ID", "github_app")?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(err)?;
    let device = provider_token_json(
        client
            .post("https://github.com/login/device/code")
            .header("accept", "application/json")
            .form(&[("client_id", client_id.as_str())])
            .send()
            .await
            .map_err(err)?,
        "GitHub device authorization",
    )
    .await?;
    let verification = device
        .get("verification_uri")
        .and_then(Value::as_str)
        .ok_or_else(|| "GitHub did not return a verification URL.".to_string())?
        .to_string();
    let user_code = device
        .get("user_code")
        .and_then(Value::as_str)
        .ok_or_else(|| "GitHub did not return a user code.".to_string())?
        .to_string();
    let device_code = device
        .get("device_code")
        .and_then(Value::as_str)
        .ok_or_else(|| "GitHub did not return a device code.".to_string())?
        .to_string();
    let expires_in = device
        .get("expires_in")
        .and_then(Value::as_i64)
        .unwrap_or(900);
    let interval = device
        .get("interval")
        .and_then(Value::as_u64)
        .unwrap_or(5)
        .max(5);
    app.opener()
        .open_url(&verification, None::<&str>)
        .map_err(|error| format!("The GitHub authorization page could not be opened: {error}"))?;
    let database = state.engine.database().clone();
    let vault = state.credential_vault.clone();
    let emitted_app = app.clone();
    let client_id_for_poll = client_id.clone();
    tauri::async_runtime::spawn(async move {
        let result:Result<ConnectionMetadata>=async{
            let deadline=Utc::now()+chrono::Duration::seconds(expires_in);let mut wait=interval;
            let token=loop{if Utc::now()>=deadline{return Err("GitHub device authorization expired.".into());}tokio::time::sleep(std::time::Duration::from_secs(wait)).await;let response=provider_token_json(client.post("https://github.com/login/oauth/access_token").header("accept","application/json").form(&[("client_id",client_id_for_poll.as_str()),("device_code",device_code.as_str()),("grant_type","urn:ietf:params:oauth:grant-type:device_code")]).send().await.map_err(err)?,"GitHub device token").await?;match response.get("error").and_then(Value::as_str){Some("authorization_pending")=>continue,Some("slow_down")=>{wait+=5;continue},Some(error)=>return Err(format!("GitHub authorization failed: {error}.")),None=>break response}};
            let access=token.get("access_token").and_then(Value::as_str).ok_or_else(||"GitHub did not return an access token.".to_string())?.to_string();
            let profile=provider_token_json(client.get("https://api.github.com/user").bearer_auth(&access).header("accept","application/vnd.github+json").header("X-GitHub-Api-Version","2026-03-10").header("user-agent","sndbox/0.8").send().await.map_err(err)?,"GitHub profile").await?;
            let installations=provider_token_json(client.get("https://api.github.com/user/installations").bearer_auth(&access).header("accept","application/vnd.github+json").header("X-GitHub-Api-Version","2026-03-10").header("user-agent","sndbox/0.8").send().await.map_err(err)?,"GitHub installations").await?;
            let login=profile.get("login").and_then(Value::as_str).unwrap_or("GitHub account").to_string();
            let installation_summaries=installations.get("installations").and_then(Value::as_array).cloned().unwrap_or_default().into_iter().map(|item|json!({"id":item.get("id"),"account":item.get("account").and_then(|value|value.get("login")),"repositorySelection":item.get("repository_selection"),"permissions":item.get("permissions")})).collect::<Vec<_>>();
            if installation_summaries.is_empty(){return Err("Authorize or install the sndbox GitHub App for at least one account, then connect again.".into());}
            let connection=ConnectionMetadata{id:Uuid::new_v4().to_string(),provider:"github_app".into(),display_name:login.clone(),account_identifier:Some(login),scopes:vec!["metadata:read".into(),"issues:write".into(),"pull_requests:write".into(),"actions:write".into(),"contents:write".into()],created_at:Utc::now(),last_used_at:None,expires_at:token.get("expires_in").and_then(Value::as_i64).map(|seconds|Utc::now()+chrono::Duration::seconds(seconds)),status:ConnectionStatus::SetupRequired,metadata:json!({"authType":"github_app_device_flow","avatarUrl":profile.get("avatar_url"),"installations":installation_summaries,"installationId":null,"selectedRepositories":[],"lastSuccessfulValidationTime":null,"attentionReason":"Select an installation and repositories."})};
            vault.put(&connection.id,&json!({"accessToken":access,"refreshToken":token.get("refresh_token"),"tokenType":token.get("token_type")}))?;if let Err(error)=database.save_connection(&connection){let _=vault.delete(&connection.id);return Err(error.to_string());}Ok(connection)
        }.await;
        match result {
            Ok(connection) => {
                let _ = emitted_app.emit("connection-updated", connection);
            }
            Err(error) => {
                let _ = emitted_app.emit("connection-error", error);
            }
        }
    });
    Ok(oauth::OAuthStart {
        authorization_url: verification,
        expires_at: Utc::now() + chrono::Duration::seconds(expires_in),
        user_code: Some(user_code),
    })
}

fn configured_secret(name: &str, provider: &str) -> Result<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            format!(
                "{provider} OAuth is not configured in this build. Set {name} and restart sndbox."
            )
        })
}

async fn provider_token_json(response: reqwest::Response, provider: &str) -> Result<Value> {
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|error| format!("{provider} returned invalid JSON: {error}"))?;
    if !status.is_success() {
        return Err(format!(
            "{provider} failed with HTTP {status}: {}",
            body.get("error_description")
                .or_else(|| body.get("error"))
                .and_then(Value::as_str)
                .unwrap_or("unknown error")
        ));
    }
    Ok(body)
}

async fn write_oauth_response(stream: &mut tokio::net::TcpStream, success: bool, message: &str) {
    let title = if success {
        "Connected"
    } else {
        "Connection failed"
    };
    let safe_message = message
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    let body = format!("<!doctype html><meta charset=utf-8><title>{title}</title><style>body{{margin:0;background:#09090b;color:#f4f4f5;font:14px system-ui;display:grid;place-items:center;height:100vh}}main{{max-width:460px;border:1px solid #29292d;border-radius:8px;padding:24px;background:#111113}}h1{{font-size:18px}}p{{color:#a1a1aa;line-height:1.5}}</style><main><h1>{title}</h1><p>{safe_message}</p></main>");
    let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

#[tauri::command]
pub async fn test_browser_locator(
    session_id: String,
    locator: StructuredLocator,
    state: State<'_, AppState>,
) -> Result<serde_json::Value> {
    state
        .browser_sidecar
        .request(
            "test_locator",
            json!({"sessionId":session_id,"locator":locator}),
        )
        .await
        .map_err(err)
}

fn checked_profile_path(state: &AppState, profile: &BrowserProfile) -> Result<std::path::PathBuf> {
    let root = state.data_dir.join("browser-profiles");
    let path = std::path::PathBuf::from(&profile.data_path);
    if !path.starts_with(&root) || path == root {
        return Err("Browser profile path failed its safety check.".into());
    }
    Ok(path)
}

fn sanitize_export_definition(
    definition: &mut Value,
    state: &AppState,
    required_connections: &mut Vec<Value>,
    required_profiles: &mut Vec<Value>,
    local_path_fields: &mut Vec<String>,
) -> Result<()> {
    let nodes = definition
        .get_mut("nodes")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "The workflow definition does not contain nodes.".to_string())?;
    for node in nodes {
        let node_id = node
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("unknown-node")
            .to_string();
        let connection_field = if node.get("type").and_then(Value::as_str) == Some("ai_prompt") {
            "connectionId"
        } else {
            "credentialId"
        };
        let Some(configuration) = node.get_mut("configuration").and_then(Value::as_object_mut)
        else {
            continue;
        };
        // Development fixtures are local by default. An explicit future export
        // mode can include them after size/sensitivity review.
        configuration.remove("pinnedData");
        if let Some(credential_id) = configuration
            .remove(connection_field)
            .and_then(|value| value.as_str().map(str::to_string))
            .filter(|value| !value.is_empty())
        {
            let connection = state
                .engine
                .database()
                .get_connection(&credential_id)
                .map_err(err)?;
            let requirement_id = format!("connection-{}", required_connections.len() + 1);
            required_connections.push(json!({
                "requirementId": requirement_id.clone(),
                "nodeId": node_id,
                "provider": connection.as_ref().map(|item| item.provider.as_str()).unwrap_or("unknown"),
                "displayName": connection.as_ref().map(|item| item.display_name.as_str()).unwrap_or("Connection required"),
                "scopes": connection.as_ref().map(|item| item.scopes.clone()).unwrap_or_default()
            }));
            configuration.insert(
                "connectionRequirementId".into(),
                Value::String(requirement_id),
            );
        }
        if let Some(profile_id) = configuration
            .remove("profileId")
            .and_then(|value| value.as_str().map(str::to_string))
            .filter(|value| !value.is_empty())
        {
            let profile = state
                .engine
                .database()
                .get_browser_profile(&profile_id)
                .map_err(err)?;
            let requirement_id = format!("browser-profile-{}", required_profiles.len() + 1);
            required_profiles.push(json!({
                "requirementId": requirement_id.clone(),
                "nodeId": node_id,
                "displayName": profile.as_ref().map(|item| item.name.as_str()).unwrap_or("Managed browser profile")
            }));
            configuration.insert(
                "browserProfileRequirementId".into(),
                Value::String(requirement_id),
            );
        }
        if let Some(headers) = configuration
            .get_mut("headers")
            .and_then(Value::as_object_mut)
        {
            headers.retain(|key, _| {
                !matches!(
                    key.to_ascii_lowercase().as_str(),
                    "authorization" | "proxy-authorization" | "cookie" | "set-cookie" | "x-api-key"
                )
            });
        }
        for key in [
            "folder",
            "destinationFolder",
            "downloadFolder",
            "file",
            "workingDirectory",
            "source",
            "outputPath",
        ] {
            let Some(value) = configuration.get_mut(key) else {
                continue;
            };
            let Some(path) = value.as_str() else { continue };
            if std::path::Path::new(path).is_absolute() {
                local_path_fields.push(format!("{node_id}.{key}"));
                *value = Value::String(String::new());
            }
        }
    }
    if let Some(permissions) = definition
        .pointer_mut("/settings/permissions")
        .and_then(Value::as_object_mut)
    {
        permissions.insert("approvedFolders".into(), json!([]));
        permissions.insert("approvedBrowserProfileIds".into(), json!([]));
        permissions.insert("commandExecutionPermitted".into(), Value::Bool(false));
        permissions.insert("backgroundExecutionPermitted".into(), Value::Bool(false));
        permissions.insert("browserAutomationPermitted".into(), Value::Bool(false));
        permissions.insert("externalCommunicationPermitted".into(), Value::Bool(false));
        permissions.insert("approvalRevision".into(), Value::Null);
        permissions.insert("communicationApprovalRevision".into(), Value::Null);
        permissions.insert("approvedEnvironmentVariables".into(), json!([]));
    }
    Ok(())
}

fn contains_secret_material(value: &Value) -> bool {
    match value {
        Value::Object(object) => object.iter().any(|(key, value)| {
            let normalized = key.to_ascii_lowercase().replace(['_', '-'], "");
            matches!(
                normalized.as_str(),
                "password"
                    | "accesstoken"
                    | "refreshtoken"
                    | "clientsecret"
                    | "webhookurl"
                    | "authorization"
                    | "cookies"
                    | "cookie"
            ) || contains_secret_material(value)
        }),
        Value::Array(values) => values.iter().any(contains_secret_material),
        _ => false,
    }
}

#[cfg(test)]
mod bug_report_tests {
    use super::*;

    fn report() -> BugReportDraft {
        BugReportDraft {
            summary: "Web Builder preview stays blank".into(),
            description: "The localhost page opens, but no compiled content is displayed.".into(),
            diagnostics: [("App version".into(), "0.7.10-beta.2".into())]
                .into_iter()
                .collect(),
        }
    }

    #[test]
    fn normalizes_a_bounded_first_party_report() {
        let payload = normalized_bug_report_payload(report()).unwrap();
        assert_eq!(payload.as_object().unwrap().len(), 3);
        assert_eq!(payload["summary"], "Web Builder preview stays blank");
        assert!(payload["description"]
            .as_str()
            .unwrap()
            .contains("localhost"));
        assert_eq!(payload["diagnostics"]["App version"], "0.7.10-beta.2");
    }

    #[test]
    fn rejects_incomplete_bug_reports() {
        let mut incomplete = report();
        incomplete.summary = "no".into();
        assert!(normalized_bug_report_payload(incomplete).is_err());
    }
}

fn safe_filename(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    if sanitized.is_empty() {
        "workflow".into()
    } else {
        sanitized
    }
}
