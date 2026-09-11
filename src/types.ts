export type BuiltInNodeType =
  | "note"
  | "manual_trigger" | "schedule_trigger" | "file_watch_trigger" | "condition" | "filter" | "switch" | "loop_over_items" | "split_out" | "aggregate" | "merge" | "remove_duplicates" | "set_data" | "delay"
  | "http_request" | "desktop_notification" | "move_file" | "read_file" | "write_file" | "copy_path" | "delete_path" | "list_folder" | "parse_csv" | "parse_json" | "parse_text" | "get_workflow_state" | "set_workflow_state" | "compare_previous" | "run_command"
  | "ai_prompt" | "code" | "javascript_code" | "python_code" | "custom_function" | "web_builder"
  | "open_browser" | "navigate" | "click_element" | "fill_field" | "select_option" | "press_key"
  | "wait_for" | "extract_data" | "screenshot" | "download_file" | "upload_file" | "close_browser"
  | "gmail_new_email_trigger" | "gmail_get_email" | "gmail_create_draft" | "gmail_send_email" | "gmail_add_label"
  | "discord_webhook" | "discord_embed" | "slack_webhook" | "approval";
// Plugin node types are publisher-defined stable strings. Keeping the built-in
// union separately preserves autocomplete without closing the public registry.
export type NodeType = BuiltInNodeType | (string & {});
export type NodeStatus = "idle" | "waiting" | "running" | "successful" | "handled" | "failed" | "skipped" | "cancelled";
export type ExecutionStatus = "queued" | "running" | "successful" | "successful_with_warnings" | "failed" | "skipped" | "cancelled";
export interface Position { x:number; y:number }
export interface PluginNodePin { pluginId:string; pluginVersion:string; packageIntegrity:string; publisherId:string; input?:unknown; credentialReferences?:Record<string,string> }
export interface WorkflowOwner { ownerType:"personal"|"workspace"; ownerId:string }
export type ValueType="any"|"string"|"number"|"boolean"|"object"|"array"|"path"|"connection";
export interface NodePortDefinition { key:string; label:string; type:ValueType; required?:boolean; description?:string; sensitive?:boolean }
export interface CustomNodeTest { id:string; name:string; inputs:Record<string,unknown>; items:WorkflowItem[]; expectedOutputs:Record<string,unknown>; expectedBranches:Record<string,unknown>; expectedError?:string }
export interface NodeCustomization { sourceType:string; sourceVersion:number; sourceName:string; sourceContractHash:string; language:"javascript"|"python"; sourceCode:string; description:string; inputs:NodePortDefinition[]; outputs:NodePortDefinition[]; branches:NodePortDefinition[]; tests:CustomNodeTest[]; runtimeRequirement:string }
export type ErrorStrategy="fail"|"route"|"fallback";
export interface NodeErrorPolicy { strategy:ErrorStrategy; maxRetries:number; retryDelayMs:number; backoff:"fixed"|"exponential"; fallbackOutputs:unknown }
export type InputBinding=
  | {kind:"literal";value:unknown}
  | {kind:"node_output";nodeId:string;path?:string[]}
  | {kind:"template";template:string}
  | {kind:"protected_variable";name:string}
  | {kind:"connection";connectionId:string};
export interface WorkflowNode { id:string; type:NodeType; version:number; name:string; position:Position; configuration:Record<string,unknown>; disabled:boolean; inputBindings?:Record<string,InputBinding>; plugin?:PluginNodePin; customization?:NodeCustomization; errorPolicy?:NodeErrorPolicy }
export interface WorkflowEdge { id:string; sourceNodeId:string; sourceHandle:string; targetNodeId:string; targetHandle:string; kind?:"control"; sourcePort?:string; targetPort?:string }
export interface PermissionSummary { approvedFolders:string[]; approvedNetworkDomains:string[]; commandExecutionPermitted:boolean; backgroundExecutionPermitted:boolean; approvalRevision?:string|null; approvedBrowserProfileIds:string[]; browserAutomationPermitted:boolean; externalCommunicationPermitted:boolean; externalDataWritePermitted?:boolean; communicationApprovalRevision?:string|null; approvedEnvironmentVariables?:string[] }
export interface CollectionLimits { maxInputItems:number; maxResultItems:number; maxItemBytes:number; maxAggregateBytes:number; maxCartesianItems:number; maxLoopIterations:number; maxLoopConcurrency:number; maxDeduplicationKeys:number; maxHistoryItemPreviews:number }
export interface WorkflowSettings { defaultNodeTimeoutMs:number; maxConcurrentNodes:number; permissions:PermissionSummary; expressionLanguageVersion?:number; collectionLimits?:CollectionLimits }
export interface Workflow { id:string; schemaVersion:number; owner?:WorkflowOwner; name:string; description:string; enabled:boolean; triggerNodeId:string; nodes:WorkflowNode[]; edges:WorkflowEdge[]; settings:WorkflowSettings; createdAt:string; updatedAt:string }
export interface ExecutionError { code:string; message:string; detail?:string; suggestion?:string; line?:number; column?:number }
export interface BinaryReference { reference:string; fileName?:string; contentType?:string; sizeBytes?:number; sha256?:string }
export interface WorkflowItem { itemId?:string; originItemId?:string; parentItemId?:string; data:unknown; binary?:Record<string,BinaryReference>; sourceNodeId?:string; sourceItemIndex?:number; originalPosition?:number; currentPosition?:number; branch?:string; branchHistory?:string[]; loopIteration?:number; executionAttempt?:number; status?:"successful"|"filtered"|"removed"|"failed"|"retried"|"skipped"; trustedPaths?:Record<string,string>; correlations?:Record<string,string> }
export interface CollectionEvidence { inputItemCount:number; outputItemCount:number; rejectedItemCount:number; branchCounts?:Record<string,number>; iterationCount:number; batchCount:number; sampleItems?:WorkflowItem[]; previewTruncated:boolean; runtimeDataTruncated:boolean; orderingPolicy:string; stopReason?:string; waitingForInputs?:string[] }
export interface RuntimeMetadata { runtime:string; runtimeVersion:string; helperLanguageVersion:number; dependencyEnvironmentId:string; executionMode:string; outputBytes:number; logBytes:number }
export interface DataLineage { source:string; path:string[]; targetField:string }
export interface LocatorCandidate { kind:"role"|"label"|"placeholder"|"test_id"|"text"|"attribute"|"css"|"xpath"; value:string; name?:string; exact?:boolean }
export interface StructuredLocator { primary:LocatorCandidate; alternatives:LocatorCandidate[]; elementRole?:string; accessibleName?:string; tag:string; stableAttributes:Record<string,string>; framePath:string[]; recordingUrl:string; nearbyText?:string }
export interface BrowserDiagnostics { currentUrl:string; pageTitle:string; locatorAttempts:Array<{kind:string;value:string;matchCount:number;succeeded:boolean;weakFallback:boolean;error?:string}>; successfulLocator?:LocatorCandidate; matchCount:number; consoleErrors:string[]; failedNetworkRequests:string[]; screenshotPath?:string; tracePath?:string; playwrightError?:string; unexpectedNavigation:boolean; rerecordAvailable:boolean }
export interface NodeExecution { nodeId:string; status:NodeStatus; startedAt?:string; completedAt?:string; durationMs?:number; input:unknown; output:unknown; logs:string[]; retryCount:number; error?:ExecutionError; skipReason?:string; branchFollowed?:string; browserDiagnostics?:BrowserDiagnostics; inputItems?:WorkflowItem[]; outputItems?:WorkflowItem[]; warnings?:string[]; lineage?:DataLineage[]; runtime?:RuntimeMetadata; testDataSource?:string; capabilityUsage?:string[]; collection?:CollectionEvidence }
export interface ExecutionRecord { id:string; workflowId:string; workflowVersion:number; trigger:unknown; status:ExecutionStatus; startedAt:string; completedAt?:string; durationMs?:number; nodeExecutions:NodeExecution[]; error?:ExecutionError; skipReason?:string; recoveredAfterCrash:boolean }
export interface WorkflowMetadata { favorite:boolean; folder?:string; tags:string[]; archivedAt?:string; lastOpenedAt?:string }
export interface WorkflowMetadataPatch { favorite?:boolean; folder?:string|null; tags?:string[]; addTags?:string[]; removeTags?:string[]; archivedAt?:string|null; lastOpenedAt?:string|null }
export interface WorkflowSummary { workflow:Workflow; metadata:WorkflowMetadata; lastExecution?:ExecutionRecord; nextRunAt?:string }
export interface WorkflowRevisionSummary { revisionId:string; workflowId:string; parentRevisionId?:string; schemaVersion:number; contentHash:string; changeSummary:string; createdAt:string; current:boolean }
export interface ValidationIssue { code:string; message:string; severity:"info"|"warning"|"error"; nodeId?:string; edgeId?:string; fieldPath?:string; suggestion?:string }
export type GateState="available"|"setup_required"|"blocked";
export interface NodeContract { nodeType:string; version:number; displayName:string; kind:"annotation"|"trigger"|"action"; inputs:NodePortDefinition[]; outputs:NodePortDefinition[]; branches:string[]; configurationSchema:Record<string,unknown>; placements:Array<"local"|"paired_runner"|"hosted_runner"|"managed_browser">; requirements:string[]; effectLevel:"pure"|"read"|"write"|"destructive"; retrySafety:"safe"|"unsafe"|"idempotency_required"; customizable:boolean; inspectorStrategy:string; testFixture:unknown }
export interface NodeGate { state:GateState; code:string; message:string; remediation?:string }
export interface CustomNodeVerification { workflowId:string; nodeId:string; fingerprint:string; passedAt:string; outputCoverage:string[]; branchCoverage:string[]; runtimeVersion:string }
export interface CustomFixtureResult { id:string; name:string; passed:boolean; durationMs:number; logs:string[]; error?:string }
export interface CustomNodeTestReport { passed:boolean; fingerprint:string; outputCoverage:string[]; branchCoverage:string[]; fixtures:CustomFixtureResult[]; verification?:CustomNodeVerification }
export interface DesktopIntegrationSettings { shortcut:string; shortcutEnabled:boolean; startAtLogin:boolean; shortcutError?:string|null }
export interface WorkflowImportInspection { inspectionId:string; sourcePath:string; name:string; description:string; sourceSchemaVersion:number; nodeCount:number; requiredNodeTypes:string[]; warnings:string[] }
export interface ExecutionQuery { search?:string; workflowIds?:string[]; statuses?:ExecutionStatus[]; triggerTypes?:string[]; startedAfter?:string; startedBefore?:string; cursor?:string; limit?:number }
export interface ExecutionPage { items:ExecutionRecord[]; nextCursor?:string }
export interface RunnerStatus { paused:boolean; activeWorkflowIds:string[]; localSchedulesStopOnQuit:boolean; scheduledWorkflowCount:number; nextRunAt?:string }
export interface AccountMetadata { accountId:string; email:string; displayName:string; sessionId:string; expiresAt:string; signedInAt:string }
export interface AccountStatus { configured:boolean; signedIn:boolean; metadata?:AccountMetadata; localWorkflowsAvailable:boolean; configurationError?:string }
export type BuiltInRole="owner"|"administrator"|"developer"|"operator"|"viewer";
export interface AccountWorkspace { id:string; organisationId:string; name:string; slug:string; role:BuiltInRole; createdAt:string }
export interface AccountOrganisation { id:string; name:string; slug:string; role:BuiltInRole; createdAt:string; workspaces:AccountWorkspace[] }
export interface CloudWorkflow { workflowId:string; name:string; currentDraftRevisionId?:string|null; currentPublishedRevisionId?:string|null; createdAt:string; updatedAt?:string|null }
export interface SyncEncryption { algorithm:"aes-256-gcm"; keyVersion:number }
export interface SyncSearchableMetadata { name:string; folderId?:string|null; requiredPlugins:Array<{pluginId:string;version:string;packageIntegrity:string}>; permissionRequirements:string[]; runnerPolicy:Record<string,unknown> }
export interface EncryptedWorkflowRevision { workflowId:string; revisionId:string; parentRevisionId?:string|null; schemaVersion:number; contentHash:string; editorDeviceId:string; updatedAt:string; syncState:"local"|"synced"|"conflicted"|"deleted"; encryption:SyncEncryption; encryptedPayload:string; payloadKeyEnvelope:string; searchableMetadata:SyncSearchableMetadata }
export interface CloudSyncResult { revision:EncryptedWorkflowRevision; conflictRevisionId?:string|null }
export interface CloudWorkflowApproval { approvalId:string;workflowId:string;revisionId:string;status:"pending"|"approved"|"rejected"|"expired";requiredApprovals:number;approvalCount:number;createdAt:string }
export interface CloudPublishResult { workflowId:string;publishedRevisionId:string;previousPublishedRevisionId?:string|null }
export interface BrowserProfileSettings { viewportWidth:number; viewportHeight:number; downloadFolder?:string; proxy?:string; userAgent?:string; permissions:string[] }
export interface BrowserProfile { id:string; name:string; persistent:boolean; dataPath:string; settings:BrowserProfileSettings; createdAt:string; lastUsedAt?:string }
export interface BrowserEngineStatus { available:boolean; protocolVersion:number; sidecarVersion?:string; browserName?:string; browserVersion?:string; error?:string }
export type ConnectionStatus="connected"|"expired"|"revoked"|"error"|"setup_required";
export interface ConnectionMetadata { id:string; provider:string; displayName:string; accountIdentifier?:string; scopes:string[]; createdAt:string; lastUsedAt?:string; expiresAt?:string; status:ConnectionStatus; metadata:Record<string,unknown> }
export interface BugReportDraft { summary:string; description:string; diagnostics?:Record<string,string> }
export interface BugReportReceipt { delivered:boolean; provider:"discord"|"preview"; status:number; reportId:string }
export interface AiWorkflowProposal { workflow:Workflow; message:string; addedNodeCount:number; removedNodeCount:number; issues:ValidationIssue[]; tested:boolean; validationAttempts:number }
export interface AiWorkflowActivity { requestId:string; phase:string; message:string; attempt:number }
export interface PendingApproval { id:string; executionId:string; workflowId:string; nodeId:string; action:Record<string,unknown>; status:string; createdAt:string; expiresAt:string; resolvedAt?:string }
export interface RecordedStep { id:string; action:string; name:string; configuration:Record<string,unknown>; sensitiveInputRequired:boolean }
export type PluginInstallState="disabled"|"enabled"|"revoked";
export interface InstalledPlugin { pluginId:string; version:string; packageIntegrity:string; publisherId:string; publisherKeyId:string; ownerType:"personal"|"workspace"; ownerId:string; source:"marketplace"|"private"|"development"; development:boolean; state:PluginInstallState; manifest:PluginManifest; requestedPermissions:string[]; approvedPermissions:string[]; updateRequiresReview:boolean; packagePath:string; installedAt:string; updatedAt:string }
export interface PluginManifestNode { nodeType:string; nodeVersion:number; displayName:string; description:string; category:string; riskLevel:string; inputSchema:Record<string,unknown>; outputSchema:Record<string,unknown>; configurationSchema:Record<string,unknown>; credentialRequirements:string[]; capabilities:string[]; timeoutMs:number; retryBehavior:string; idempotencySupport:string; documentation:string; executionEntrypoint:string; kind?:"action"|"polling_trigger"; inputPorts?:NodePortDefinition[]; outputPorts?:NodePortDefinition[]; connectionRequirements?:Array<{reference:string;provider:string;permissions:string[];required:boolean}>; fileInputs?:Array<{key:string;required:boolean;maximumBytes?:number;acceptedMimeTypes?:string[]}>; placements?:Array<"desktop"|"self_hosted">; externalEffect?:"read"|"external_write"|"destructive_or_high_impact" }
export interface PluginManifest { manifestVersion?:1|2; pluginId:string; name:string; description:string; version:string; publisherId:string; nodes:PluginManifestNode[]; networkDomains:Array<{domain:string;methods:string[]}>; pricing:{model:string}; [key:string]:unknown }
export interface PluginPackageInspection { inspectionId:string; manifest:PluginManifest; requestedPermissions:string[]; permissionExpansion:string[]; expiresAt:string; development:boolean; signedAndVerified:boolean }
export interface PackageTrustMetadata { publisherId:string; keyId:string; publisherPublicKeyPem:string; ownerType:"personal"|"workspace"; ownerId:string; source:"marketplace"|"private"|"development" }
export interface MarketplaceListing { pluginId:string; name:string; summary:string; publisher:{publicId:string;publicName:string;verified:boolean}; version:string; packageIntegrity:string; categories:string[]; pricing:Record<string,unknown>; capabilities:unknown[]; networkDomains:unknown[]; nodes:unknown[]; minimumHostVersion:string; maximumHostVersion?:string|null; installCount:number; ratingAverage?:number|null; ratingCount:number; updatedAt:string }
export interface MarketplacePage { items:MarketplaceListing[]; nextCursor?:string|null }
