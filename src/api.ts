import { invoke } from "@tauri-apps/api/core";
import type { WorkspaceActivitySummary } from "@sandbox/contracts";
import type {
  AiWorkflowProposal,
  AccountStatus,
  AccountOrganisation,
  BrowserEngineStatus,
  BrowserProfile,
  BrowserProfileSettings,
  BugReportDraft,
  BugReportReceipt,
  CloudSyncResult,
  CloudWorkflow,
  CloudWorkflowApproval,
  CloudPublishResult,
  ConnectionMetadata,
  CustomNodeTestReport,
  CustomNodeVerification,
  DesktopIntegrationSettings,
  ExecutionPage,
  ExecutionQuery,
  ExecutionRecord,
  EncryptedWorkflowRevision,
  InstalledPlugin,
  NodeContract,
  NodeGate,
  MarketplacePage,
  PackageTrustMetadata,
  PendingApproval,
  PermissionSummary,
  PluginPackageInspection,
  RecordedStep,
  RunnerStatus,
  StructuredLocator,
  ValidationIssue,
  Workflow,
  WorkflowImportInspection,
  WorkflowMetadataPatch,
  WorkflowRevisionSummary,
  WorkflowSummary,
} from "./types";
import nodeContractSnapshot from "./generated/node-contracts.json";
import { previewApi } from "./previewApi";
const tauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export const api = {
  takeDeepLinkRequests: () =>
    tauri ? invoke<string[]>("take_deep_link_requests") : Promise.resolve([]),
  listWorkflows: (includeArchived = false) =>
    tauri
      ? invoke<WorkflowSummary[]>("list_workflows", { includeArchived })
      : previewApi.listWorkflows(includeArchived),
  getWorkflow: (id: string) =>
    tauri
      ? invoke<Workflow | undefined>("get_workflow", { id })
      : previewApi.getWorkflow(id),
  saveWorkflow: (workflow: Workflow) =>
    tauri
      ? invoke<Workflow>("save_workflow", { workflow })
      : previewApi.saveWorkflow(workflow),
  listWorkflowRevisions: (workflowId: string) =>
    tauri
      ? invoke<WorkflowRevisionSummary[]>("list_workflow_revisions", {
          workflowId,
        })
      : previewApi.listWorkflowRevisions(workflowId),
  getWorkflowRevision: (workflowId: string, revisionId: string) =>
    tauri
      ? invoke<Workflow | undefined>("get_workflow_revision", {
          workflowId,
          revisionId,
        })
      : previewApi.getWorkflowRevision(workflowId, revisionId),
  restoreWorkflowRevision: (workflowId: string, revisionId: string) =>
    tauri
      ? invoke<Workflow>("restore_workflow_revision", {
          workflowId,
          revisionId,
        })
      : previewApi.restoreWorkflowRevision(workflowId, revisionId),
  createWorkflow: (templateKey?: string, name?: string) =>
    tauri
      ? invoke<Workflow>("create_workflow", { templateKey, name })
      : previewApi.createWorkflow(templateKey, name),
  exportWorkflow: (id: string) =>
    tauri
      ? invoke<string | undefined>("export_workflow", { id })
      : Promise.reject(
          new Error(
            "Workflow export uses a native file picker in the desktop application.",
          ),
        ),
  inspectWorkflowImport: () =>
    tauri
      ? invoke<WorkflowImportInspection | undefined>("inspect_workflow_import")
      : Promise.reject(
          new Error(
            "Workflow import uses a native file picker in the desktop application.",
          ),
        ),
  inspectWorkflowPath: (path: string) =>
    tauri
      ? invoke<WorkflowImportInspection>("inspect_workflow_path", { path })
      : Promise.reject(new Error("Workflow file inspection requires the desktop application.")),
  confirmWorkflowImport: (inspectionId: string) =>
    tauri
      ? invoke<Workflow>("confirm_workflow_import", { inspectionId })
      : Promise.reject(new Error("Workflow import requires the desktop application.")),
  cancelWorkflowImport: (inspectionId: string) =>
    tauri ? invoke<void>("cancel_workflow_import", { inspectionId }) : Promise.resolve(),
  takeWorkflowFileRequests: () =>
    tauri ? invoke<string[]>("take_workflow_file_requests") : Promise.resolve([]),
  openQuickLauncher: () =>
    tauri ? invoke<void>("open_quick_launcher") : Promise.resolve(),
  revealWorkflow: (workflowId: string) =>
    tauri ? invoke<void>("reveal_workflow", { workflowId }) : Promise.resolve(),
  desktopIntegrationSettings: () =>
    tauri
      ? invoke<DesktopIntegrationSettings>("desktop_integration_settings")
      : Promise.resolve({ shortcut: "Ctrl+Shift+Space", shortcutEnabled: true, startAtLogin: false }),
  setDesktopIntegrationSettings: (next: DesktopIntegrationSettings) =>
    tauri
      ? invoke<DesktopIntegrationSettings>("set_desktop_integration_settings", { next })
      : Promise.resolve(next),
  deleteWorkflow: (id: string) =>
    tauri
      ? invoke<void>("delete_workflow", { id })
      : previewApi.deleteWorkflow(id),
  updateWorkflowMetadata: (id: string, patch: WorkflowMetadataPatch) =>
    tauri
      ? invoke<WorkflowSummary>("update_workflow_metadata", { id, patch })
      : previewApi.updateWorkflowMetadata(id, patch),
  batchUpdateWorkflowMetadata: (ids: string[], patch: WorkflowMetadataPatch) =>
    tauri
      ? invoke<void>("batch_update_workflow_metadata", { ids, patch })
      : previewApi.batchUpdateWorkflowMetadata(ids, patch),
  duplicateWorkflow: (id: string, name?: string) =>
    tauri
      ? invoke<Workflow>("duplicate_workflow", { id, name })
      : previewApi.duplicateWorkflow(id, name),
  archiveWorkflow: (id: string) =>
    tauri
      ? invoke<void>("archive_workflow", { id })
      : previewApi.archiveWorkflow(id),
  archiveWorkflows: (ids: string[]) =>
    tauri ? invoke<void>("archive_workflows", { ids }) : previewApi.archiveWorkflows(ids),
  restoreWorkflow: (id: string) =>
    tauri
      ? invoke<void>("restore_workflow", { id })
      : previewApi.restoreWorkflow(id),
  restoreWorkflows: (ids: string[]) =>
    tauri ? invoke<void>("restore_workflows", { ids }) : previewApi.restoreWorkflows(ids),
  purgeWorkflow: (id: string) =>
    tauri
      ? invoke<void>("purge_workflow", { id })
      : previewApi.purgeWorkflow(id),
  validateWorkflow: (workflow: Workflow) =>
    tauri
      ? invoke<ValidationIssue[]>("validate_workflow", { workflow })
      : previewApi.validateWorkflow(workflow),
  listNodeContracts: () => tauri ? invoke<NodeContract[]>("list_node_contracts") : Promise.resolve(nodeContractSnapshot as unknown as NodeContract[]),
  evaluateNodeGates: (workflow: Workflow, placement = "local") => tauri ? invoke<Record<string,NodeGate>>("evaluate_node_gates", { workflow, placement }) : Promise.resolve({}),
  testCustomNode: (workflow: Workflow, nodeId: string) => tauri ? invoke<CustomNodeTestReport>("test_custom_node", { workflow, nodeId }) : Promise.reject(new Error("Custom node verification requires the desktop runtime.")),
  getCustomNodeVerification: (workflowId:string,nodeId:string) => tauri ? invoke<CustomNodeVerification|undefined>("get_custom_node_verification",{workflowId,nodeId}) : Promise.resolve(undefined),
  runWorkflow: (id: string) =>
    tauri
      ? invoke<ExecutionRecord>("run_workflow", {
          id,
          trigger: { type: "manual" },
        })
      : previewApi.runWorkflow(id),
  testWorkflowNode: (
    workflow: Workflow,
    nodeId: string,
    inputOverrides: Record<string, unknown> = {},
    previousExecutionId?: string,
    allowSideEffects = false,
  ) =>
    tauri
      ? invoke<ExecutionRecord>("test_workflow_node", {
          workflow,
          nodeId,
          inputOverrides,
          previousExecutionId,
          allowSideEffects,
        })
      : previewApi.testWorkflowNode(
          workflow,
          nodeId,
          inputOverrides,
          previousExecutionId,
          allowSideEffects,
        ),
  retryFailedNode: (executionId: string, nodeId: string) =>
    tauri
      ? invoke<ExecutionRecord>("retry_failed_node", { executionId, nodeId })
      : previewApi.retryFailedNode(executionId, nodeId),
  retryBrowserExecutionHeaded: (executionId: string) =>
    tauri
      ? invoke<ExecutionRecord>("retry_browser_execution_headed", {
          executionId,
        })
      : Promise.reject(
          new Error("Headed browser retries require the desktop application."),
        ),
  openExecutionArtifact: (path: string) =>
    tauri
      ? invoke<void>("open_execution_artifact", { path })
      : Promise.reject(
          new Error(
            "Execution artifacts are available only in the desktop application.",
          ),
        ),
  cancelExecution: (executionId: string) =>
    tauri
      ? invoke<void>("cancel_execution", { executionId })
      : previewApi.cancelExecution(),
  listExecutions: (workflowId?: string, limit = 100) =>
    tauri
      ? invoke<ExecutionRecord[]>("list_executions", { workflowId, limit })
      : previewApi.listExecutions(workflowId),
  getExecution: (id: string) =>
    tauri
      ? invoke<ExecutionRecord | undefined>("get_execution", { id })
      : previewApi.getExecution(id),
  clearExecutionHistory: (keep = 0) =>
    tauri
      ? invoke<number>("clear_execution_history", { keep })
      : previewApi.clearExecutionHistory(keep),
  queryExecutions: (query: ExecutionQuery) =>
    tauri
      ? invoke<ExecutionPage>("query_executions", { query })
      : previewApi.queryExecutions(query),
  deleteExecution: (id: string) =>
    tauri
      ? invoke<void>("delete_execution", { id })
      : previewApi.deleteExecution(id),
  approvePermissions: (id: string, permissions: PermissionSummary) =>
    invoke<Workflow>("approve_permissions", { id, permissions }),
  runnerStatus: () =>
    tauri ? invoke<RunnerStatus>("runner_status") : previewApi.runnerStatus(),
  setRunnerPaused: (paused: boolean) =>
    tauri
      ? invoke<RunnerStatus>("set_runner_paused", { paused })
      : previewApi.setRunnerPaused(paused),
  browserEngineStatus: () =>
    tauri
      ? invoke<BrowserEngineStatus>("browser_engine_status")
      : Promise.resolve({
          available: true,
          protocolVersion: 1,
          sidecarVersion: "0.2.0",
          browserName: "chromium",
          browserVersion: "151.0.7922.34",
        }),
  restartBrowserEngine: () =>
    invoke<BrowserEngineStatus>("restart_browser_engine"),
  listBrowserProfiles: () =>
    tauri
      ? invoke<BrowserProfile[]>("list_browser_profiles")
      : previewApi.listBrowserProfiles(),
  createBrowserProfile: (
    name: string,
    persistent = true,
    settings?: BrowserProfileSettings,
  ) =>
    tauri
      ? invoke<BrowserProfile>("create_browser_profile", {
          name,
          persistent,
          settings,
        })
      : previewApi.createBrowserProfile(name, persistent, settings),
  updateBrowserProfile: (
    id: string,
    name: string,
    persistent: boolean,
    settings: BrowserProfileSettings,
  ) =>
    tauri
      ? invoke<BrowserProfile>("update_browser_profile", {
          id,
          name,
          persistent,
          settings,
        })
      : previewApi.updateBrowserProfile(id, name, persistent, settings),
  duplicateBrowserProfile: (id: string) =>
    tauri
      ? invoke<BrowserProfile>("duplicate_browser_profile", { id })
      : previewApi.duplicateBrowserProfile(id),
  clearBrowserProfileData: (id: string) =>
    invoke<void>("clear_browser_profile_data", { id }),
  deleteBrowserProfile: (id: string) =>
    tauri
      ? invoke<void>("delete_browser_profile", { id })
      : previewApi.deleteBrowserProfile(id),
  openBrowserProfile: (id: string) =>
    invoke<Record<string, unknown>>("open_browser_profile", { id }),
  startBrowserRecording: (profileId: string, initialUrl?: string) =>
    invoke<{ browserSession: { sessionId: string } }>(
      "start_browser_recording",
      { profileId, initialUrl },
    ),
  getBrowserRecording: (sessionId: string) =>
    invoke<{ steps: RecordedStep[] }>("get_browser_recording", { sessionId }),
  stopBrowserRecording: (sessionId: string) =>
    invoke<{ steps: RecordedStep[] }>("stop_browser_recording", { sessionId }),
  testBrowserLocator: (sessionId: string, locator: StructuredLocator) =>
    invoke<Record<string, unknown>>("test_browser_locator", {
      sessionId,
      locator,
    }),
  listConnections: () =>
    tauri
      ? invoke<ConnectionMetadata[]>("list_connections")
      : previewApi.listConnections(),
  submitBugReport: (report: BugReportDraft) =>
    tauri
      ? invoke<BugReportReceipt>("submit_bug_report", { report })
      : previewApi.submitBugReport(report),
  buildWorkflowWithAi: (connectionId: string, message: string, workflow: Workflow, requestId: string) =>
    tauri
      ? invoke<AiWorkflowProposal>("build_workflow_with_ai", { connectionId, message, workflow, requestId })
      : Promise.reject(new Error("AI workflow building requires the desktop application so credentials stay in the operating-system vault.")),
  generateCodeWithAi: (
    connectionId: string,
    language: "python" | "html" | "javascript" | "css",
    instruction: string,
    currentCode: string,
  ) =>
    tauri
      ? invoke<{ code: string; model: string; usage: Record<string, unknown> }>("generate_code_with_ai", {
          connectionId,
          language,
          instruction,
          currentCode,
        })
      : Promise.reject(new Error("AI code writing requires the desktop application so credentials stay in the operating-system vault.")),
  createConnection: (
    provider: string,
    displayName: string,
    secret: Record<string, unknown>,
    accountIdentifier?: string,
    scopes: string[] = [],
    metadata: Record<string, unknown> = {},
  ) =>
    tauri
      ? invoke<ConnectionMetadata>("create_connection", {
          provider,
          displayName,
          accountIdentifier,
          scopes,
          metadata,
          secret,
        })
      : Promise.reject(
          new Error(
            "Connections use the operating-system credential store and are available only in the desktop application.",
          ),
        ),
  renameConnection: (id: string, displayName: string) =>
    invoke<ConnectionMetadata>("rename_connection", { id, displayName }),
  reconnectConnection: (id: string, secret: Record<string, unknown>) =>
    invoke<ConnectionMetadata>("reconnect_connection", { id, secret }),
  testConnection: (id: string) =>
    invoke<{ healthy: boolean; message: string }>("test_connection", { id }),
  revokeConnection: (id: string) =>
    invoke<ConnectionMetadata>("revoke_connection", { id }),
  deleteConnection: (id: string) => invoke<void>("delete_connection", { id }),
  workflowsUsingConnection: (id: string) =>
    invoke<string[]>("workflows_using_connection", { id }),
  startGmailOAuth: () =>
    tauri
      ? invoke<{ authorizationUrl: string; expiresAt: string }>(
          "start_gmail_oauth",
        )
      : Promise.reject(
          new Error(
            "Gmail OAuth requires the desktop application and SANDBOX_GMAIL_CLIENT_ID.",
          ),
        ),
  startIntegrationOAuth: (provider: "google_workspace" | "slack_oauth" | "notion" | "github_app") =>
    tauri
      ? invoke<{ authorizationUrl: string; expiresAt: string; userCode?: string }>(
          "start_integration_oauth",
          { provider },
        )
      : Promise.reject(new Error("Integration OAuth requires the desktop application.")),
  listIntegrationResources: (connectionId: string, kind: string, parent?: string) =>
    tauri
      ? invoke<Array<{ id: string; label: string; metadata: Record<string, unknown> }>>("list_integration_resources", { connectionId, kind, parent })
      : Promise.resolve([]),
  configureGithubInstallation: (connectionId: string, installationId: number, repositories: string[]) =>
    invoke<ConnectionMetadata>("configure_github_installation", { connectionId, installationId, repositories }),
  createFileGrant: (path: string, maximumBytes = 1024 * 1024 * 1024) =>
    tauri
      ? invoke<{ grantId: string; expiresAt: string; name: string; size: number }>(
          "create_file_grant",
          { path, maximumBytes },
        )
      : Promise.reject(new Error("Secure file grants require the desktop application.")),
  accountStatus: () =>
    tauri
      ? invoke<AccountStatus>("account_status")
      : Promise.resolve({
          configured: false,
          signedIn: false,
          localWorkflowsAvailable: true,
          configurationError:
            "Accounts are available in the desktop application.",
        }),
  startAccountAuth: (createAccount = false) =>
    tauri
      ? invoke<{ authorizationUrl: string; expiresAt: string }>(
          "start_account_auth",
          { createAccount },
        )
      : Promise.reject(
          new Error(
            "Account authorization opens the system browser from the desktop application.",
          ),
        ),
  signOutAccount: () =>
    tauri ? invoke<void>("sign_out_account") : Promise.resolve(),
  listAccountOrganisations: () =>
    tauri
      ? invoke<AccountOrganisation[]>("list_account_organisations")
      : Promise.resolve([]),
  createAccountOrganisation: (name: string, slug: string) =>
    tauri
      ? invoke<AccountOrganisation>("create_account_organisation", { name, slug })
      : Promise.reject(new Error("Organisation creation requires the desktop application.")),
  listCloudWorkflows: (workspaceId: string) =>
    tauri
      ? invoke<CloudWorkflow[]>("list_cloud_workflows", { workspaceId })
      : Promise.resolve([]),
  getWorkspaceActivity: (workspaceId: string) =>
    tauri
      ? invoke<WorkspaceActivitySummary>("get_workspace_activity", { workspaceId })
      : Promise.resolve<WorkspaceActivitySummary>({ generatedAt: new Date().toISOString(), runners: [], runs: [], pendingApprovalCount: 0, webhookFailureCount: 0, syncConflictCount: 0 }),
  pushCloudWorkflow: (
    workflowId: string,
    workspaceId: string,
    parentRevisionId: string | undefined,
    editorDeviceId: string,
  ) =>
    tauri
      ? invoke<CloudSyncResult>("push_cloud_workflow", {
          workflowId,
          workspaceId,
          parentRevisionId,
          editorDeviceId,
        })
      : Promise.reject(new Error("Encrypted sync requires the desktop application.")),
  listCloudWorkflowRevisions: (workspaceId: string, workflowId: string) =>
    tauri
      ? invoke<EncryptedWorkflowRevision[]>("list_cloud_workflow_revisions", {
          workspaceId,
          workflowId,
        })
      : Promise.resolve([]),
  listCloudWorkflowApprovals: (workspaceId: string, status = "all") =>
    tauri
      ? invoke<CloudWorkflowApproval[]>("list_cloud_workflow_approvals", { workspaceId, status })
      : Promise.resolve([]),
  requestCloudWorkflowApproval: (workspaceId: string, workflowId: string, revisionId: string) =>
    invoke<CloudWorkflowApproval>("request_cloud_workflow_approval", { workspaceId, workflowId, revisionId }),
  decideCloudWorkflowApproval: (workspaceId: string, approvalId: string, decision: "approved" | "rejected", reason?: string) =>
    invoke<CloudWorkflowApproval>("decide_cloud_workflow_approval", { workspaceId, approvalId, decision, reason }),
  publishCloudWorkflow: (workspaceId: string, workflowId: string, revisionId: string, changeSummary: string) =>
    invoke<CloudPublishResult>("publish_cloud_workflow", { workspaceId, workflowId, revisionId, changeSummary }),
  importCloudWorkflowRevision: (
    workspaceId: string,
    workflowId: string,
    revisionId: string,
  ) =>
    tauri
      ? invoke<Workflow>("import_cloud_workflow_revision", {
          workspaceId,
          workflowId,
          revisionId,
        })
      : Promise.reject(new Error("Encrypted sync requires the desktop application.")),
  listPendingApprovals: () =>
    tauri
      ? invoke<PendingApproval[]>("list_pending_approvals")
      : Promise.resolve([]),
  resolvePendingApproval: (id: string, approved: boolean) =>
    invoke<void>("resolve_pending_approval", { id, approved }),
  inspectPluginPackage: (trust: PackageTrustMetadata) =>
    tauri
      ? invoke<PluginPackageInspection | undefined>("inspect_plugin_package", {
          trust,
        })
      : Promise.reject(
          new Error(
            "Signed package inspection requires the desktop application.",
          ),
        ),
  installInspectedPlugin: (inspectionId: string) =>
    tauri
      ? invoke<InstalledPlugin>("install_inspected_plugin", { inspectionId })
      : Promise.reject(
          new Error("Plugin installation requires the desktop application."),
        ),
  listInstalledPlugins: (ownerType = "personal", ownerId = "local") =>
    tauri
      ? invoke<InstalledPlugin[]>("list_installed_plugins", {
          ownerType,
          ownerId,
        })
      : Promise.resolve([]),
  approvePluginPermissions: (plugin: InstalledPlugin) =>
    tauri
      ? invoke<InstalledPlugin>("approve_plugin_permissions", {
          pluginId: plugin.pluginId,
          version: plugin.version,
          packageIntegrity: plugin.packageIntegrity,
          ownerType: plugin.ownerType,
          ownerId: plugin.ownerId,
        })
      : Promise.reject(
          new Error("Plugin permissions require the desktop application."),
        ),
  setPluginEnabled: (plugin: InstalledPlugin, enabled: boolean) =>
    tauri
      ? invoke<InstalledPlugin>("set_plugin_enabled", {
          pluginId: plugin.pluginId,
          version: plugin.version,
          packageIntegrity: plugin.packageIntegrity,
          ownerType: plugin.ownerType,
          ownerId: plugin.ownerId,
          enabled,
        })
      : Promise.reject(
          new Error("Plugin enablement requires the desktop application."),
        ),
  searchMarketplace: (query: {
    search?: string;
    pricing?: string;
    verifiedOnly?: boolean;
    sort?: string;
    cursor?: string;
    limit?: number;
  }) =>
    tauri
      ? invoke<MarketplacePage>("search_marketplace", { query })
      : Promise.resolve({ items: [], nextCursor: null }),
  inspectMarketplacePlugin: (pluginId: string) =>
    tauri
      ? invoke<PluginPackageInspection>("inspect_marketplace_plugin", {
          pluginId,
        })
      : Promise.reject(
          new Error(
            "Marketplace package inspection requires the desktop application.",
          ),
        ),
  isDesktop: tauri,
};
