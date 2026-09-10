import { z } from "zod";

export const idSchema = z.string().uuid();
export type OwnerType = "personal" | "workspace" | "organisation" | "publisher";
export const ownerRefSchema = z.object({ ownerType: z.enum(["personal", "workspace", "organisation", "publisher"]), ownerId: idSchema });
export type OwnerRef = z.infer<typeof ownerRefSchema>;

export const permissions = [
  "organisation.billing.manage",
  "organisation.delete",
  "organisation.owners.manage",
  "organisation.security.manage",
  "members.manage",
  "service_accounts.manage",
  "api_credentials.manage",
  "plugins.manage",
  "plugins.develop_private",
  "plugins.permissions.request",
  "runners.manage",
  "connections.manage",
  "connections.use",
  "workflows.create",
  "workflows.edit",
  "workflows.test",
  "workflows.run",
  "workflows.pause",
  "workflows.publish",
  "workflows.approve",
  "deployments.manage",
  "deployments.promote",
  "workflows.view",
  "executions.view_summary",
  "executions.view_detail",
  "approvals.handle",
  "audit.view",
  "webhooks.manage",
  "policies.manage"
] as const;
export type Permission = typeof permissions[number];
export type BuiltInRole = "owner" | "administrator" | "developer" | "operator" | "viewer";

export const rolePermissionMatrix: Readonly<Record<BuiltInRole, readonly Permission[]>> = {
  owner: permissions,
  administrator: ["members.manage", "service_accounts.manage", "api_credentials.manage", "plugins.manage", "runners.manage", "connections.manage", "connections.use", "workflows.create", "workflows.edit", "workflows.test", "workflows.run", "workflows.pause", "workflows.publish", "workflows.approve", "deployments.manage", "deployments.promote", "workflows.view", "executions.view_summary", "executions.view_detail", "approvals.handle", "audit.view", "webhooks.manage", "policies.manage"],
  developer: ["plugins.develop_private", "plugins.permissions.request", "connections.use", "workflows.create", "workflows.edit", "workflows.test", "workflows.view", "executions.view_summary"],
  operator: ["connections.use", "workflows.run", "workflows.pause", "workflows.view", "executions.view_summary", "approvals.handle"],
  viewer: ["workflows.view", "executions.view_summary"]
};

export const actorSchema = z.object({ accountId: idSchema, sessionId: idSchema, deviceId: idSchema.optional() });
export type Actor = z.infer<typeof actorSchema>;

export const invitationSchema = z.object({
  id: idSchema,
  organisationId: idSchema,
  workspaceIds: z.array(idSchema).min(1),
  email: z.string().email(),
  role: z.enum(["owner", "administrator", "developer", "operator", "viewer"]),
  expiresAt: z.string().datetime(),
  status: z.enum(["pending", "accepted", "revoked", "expired"])
});
export type Invitation = z.infer<typeof invitationSchema>;

export const workflowRevisionSchema = z.object({
  workflowId: idSchema,
  revisionId: idSchema,
  parentRevisionId: idSchema.nullable(),
  schemaVersion: z.number().int().positive(),
  contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  editorDeviceId: idSchema,
  updatedAt: z.string().datetime(),
  syncState: z.enum(["local", "synced", "conflicted", "deleted"]),
  encryption: z.object({ algorithm: z.literal("aes-256-gcm"), keyVersion: z.number().int().positive() }),
  encryptedPayload: z.string().base64().min(20).max(3_000_000),
  payloadKeyEnvelope: z.string().base64().min(20).max(1_024),
  searchableMetadata: z.object({
    name: z.string().trim().min(1).max(200),
    folderId: idSchema.nullable(),
    requiredPlugins: z.array(z.object({
      pluginId: z.string().min(3).max(200),
      version: z.string().min(1).max(50),
      packageIntegrity: z.string().regex(/^sha256:[a-f0-9]{64}$/)
    })).max(100),
    permissionRequirements: z.array(z.string().min(1).max(200)).max(200),
    runnerPolicy: z.record(z.string(), z.unknown())
  })
});
export type WorkflowRevision = z.infer<typeof workflowRevisionSchema>;

export const runnerAuthorizationContextSchema = z.object({
  principalType: z.enum(["user", "personal_access_token", "service_account"]),
  principalId: idSchema,
  credentialId: idSchema.nullable(),
  requiredPermission: z.enum(permissions),
  environmentId: idSchema,
  environment: z.enum(["development", "staging", "production"]),
  credentialScopes: z.array(z.enum(permissions)).max(permissions.length).nullable(),
  workspaceRestrictions: z.array(idSchema).max(100).nullable(),
  environmentRestrictions: z.array(idSchema).max(100).nullable(),
  principalPermissions: z.array(z.enum(permissions)).max(permissions.length).nullable()
}).strict();
export type RunnerAuthorizationContext = z.infer<typeof runnerAuthorizationContextSchema>;

export const runnerCommandSchema = z.object({
  commandId: idSchema,
  issuerAccountId: idSchema,
  workspaceId: idSchema,
  targetRunnerId: idSchema,
  action: z.enum(["run_workflow", "cancel_execution", "pause_workflow", "resume_workflow", "request_diagnostics", "sync_revision"]),
  workflowRevisionId: idSchema.nullable(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  idempotencyKey: z.string().min(16).max(200),
  payload: z.record(z.string(), z.unknown()),
  authorizationContext: runnerAuthorizationContextSchema,
  keyId: z.string().min(1),
  signature: z.string().min(1),
  status: z.enum(["queued", "delivered", "accepted", "rejected", "completed", "expired", "rerouted"])
});
export type RunnerCommand = z.infer<typeof runnerCommandSchema>;

export const runnerRecordSchema = z.object({
  runnerId: idSchema,
  displayName: z.string().min(1).max(100),
  workspaceId: idSchema.nullable(),
  operatingSystem: z.string().min(1).max(80),
  architecture: z.string().min(1).max(80),
  applicationVersion: z.string().min(1).max(50),
  protocolVersion: z.number().int().positive(),
  pluginRuntimeVersion: z.string().min(1).max(50),
  capabilities: z.record(z.string(), z.unknown()),
  safeFolderLabels: z.array(z.string().min(1).max(100)).max(100),
  browserEngine: z.record(z.string(), z.unknown()).nullable(),
  installedPluginVersions: z.array(z.object({
    pluginId: z.string().min(3).max(200),
    version: z.string().min(1).max(50),
    packageIntegrity: z.string().regex(/^sha256:[a-f0-9]{64}$/)
  })).max(500),
  tags: z.array(z.string().min(1).max(50)).max(50),
  status: z.enum(["online", "offline", "paused", "draining", "maintenance", "revoked"]),
  currentWorkload: z.number().int().nonnegative(),
  pairedAt: z.string().datetime(),
  lastSeenAt: z.string().datetime().nullable()
});
export type RunnerRecord = z.infer<typeof runnerRecordSchema>;

export const RUNNER_PROTOCOL_VERSION = 2 as const;
export const RUNNER_PROTOCOL_MINIMUM_VERSION = 2 as const;

export const runnerTypeSchema = z.enum([
  "desktop",
  "hosted",
  "managed_browser",
  "self_hosted_server",
  "nas",
  "raspberry_pi"
]);
export type RunnerType = z.infer<typeof runnerTypeSchema>;

export const runnerArchitectureSchema = z.enum(["x86_64", "aarch64"]);
export type RunnerArchitecture = z.infer<typeof runnerArchitectureSchema>;

export const runnerMaintenanceStateSchema = z.enum(["active", "draining", "maintenance", "updating", "revoked"]);
export type RunnerMaintenanceState = z.infer<typeof runnerMaintenanceStateSchema>;

export const nodeCapabilitySchema = z.object({
  nodeType: z.string().min(1).max(200),
  nodeVersions: z.array(z.number().int().positive()).min(1).max(100),
  constraints: z.record(z.string(), z.unknown()).default({})
}).strict();
export type NodeCapability = z.infer<typeof nodeCapabilitySchema>;

export const codeRuntimeConstraintsSchema = z.object({
  runtime: z.enum(["javascript", "python"]),
  runtimeVersion: z.string().min(1).max(50),
  helperLanguageVersion: z.number().int().positive(),
  architecture: runnerArchitectureSchema.optional(),
  packageEnvironmentId: z.string().min(1).max(200).nullable().default(null),
  networkPolicy: z.enum(["none", "approved_domains"]).default("none"),
  filesystemPolicy: z.enum(["none", "approved_roots"]).default("none"),
  credentialBindings: z.array(z.string().min(1).max(200)).max(100).default([]),
  maximumMemoryBytes: z.number().int().positive(),
  maximumDurationMs: z.number().int().positive(),
  binaryData: z.boolean()
}).strict();
export type CodeRuntimeConstraints = z.infer<typeof codeRuntimeConstraintsSchema>;

export const runnerPluginAvailabilitySchema = z.object({
  pluginId: z.string().min(3).max(200),
  version: z.string().min(1).max(50),
  packageIntegrity: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  nodeVersions: z.record(z.string(), z.array(z.number().int().positive()).min(1)).default({})
}).strict();

export const runnerConnectionAvailabilitySchema = z.object({
  connectionId: idSchema,
  environmentId: idSchema,
  operations: z.array(z.string().min(1).max(120)).max(200),
  status: z.enum(["available", "authorization_required", "expired", "unavailable"])
}).strict();

export const runnerIdentitySchema = z.object({
  runnerId: idSchema,
  keyId: z.string().min(1).max(200),
  runnerType: runnerTypeSchema,
  protocolVersion: z.number().int().positive(),
  engineVersion: z.string().min(1).max(50),
  pluginRuntimeVersion: z.string().min(1).max(50),
  architecture: runnerArchitectureSchema,
  operatingSystem: z.string().min(1).max(80),
  workspaceId: idSchema,
  environmentId: idSchema,
  region: z.string().min(1).max(80),
  tags: z.array(z.string().min(1).max(50)).max(50),
  concurrencyLimit: z.number().int().min(1).max(1_000),
  maintenanceState: runnerMaintenanceStateSchema,
  nodeCapabilities: z.array(nodeCapabilitySchema).max(1_000),
  plugins: z.array(runnerPluginAvailabilitySchema).max(1_000),
  connections: z.array(runnerConnectionAvailabilitySchema).max(1_000)
}).strict();
export type RunnerIdentity = z.infer<typeof runnerIdentitySchema>;

const runnerProtocolBaseSchema = z.object({
  protocolVersion: z.literal(RUNNER_PROTOCOL_VERSION),
  messageId: idSchema,
  runnerId: idSchema,
  sentAt: z.string().datetime(),
  correlationId: idSchema
});

export const runnerRegistrationSchema = runnerProtocolBaseSchema.extend({
  kind: z.literal("registration"),
  identity: runnerIdentitySchema,
  publicKeyDerBase64: z.string().base64().max(2_048),
  pairingToken: z.string().min(32).max(1_024),
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  updateChannel: z.enum(["stable", "preview", "development"])
}).strict();

export const runnerHeartbeatSchema = runnerProtocolBaseSchema.extend({
  kind: z.literal("heartbeat"),
  health: z.enum(["healthy", "degraded", "unhealthy"]),
  currentWorkload: z.number().int().nonnegative(),
  availableConcurrency: z.number().int().nonnegative(),
  maintenanceState: runnerMaintenanceStateSchema,
  nodeCapabilities: z.array(nodeCapabilitySchema).max(1_000),
  plugins: z.array(runnerPluginAvailabilitySchema).max(1_000),
  connections: z.array(runnerConnectionAvailabilitySchema).max(1_000),
  resourceUsage: z.object({ cpuPercent: z.number().min(0).max(100), memoryBytes: z.number().int().nonnegative(), temporaryStorageBytes: z.number().int().nonnegative() }).strict(),
  warnings: z.array(z.string().max(500)).max(100)
}).strict();

export const workClaimRequestSchema = runnerProtocolBaseSchema.extend({
  kind: z.literal("work_claim"),
  maximumItems: z.number().int().min(1).max(100),
  availableConcurrency: z.number().int().positive()
}).strict();

export const executionLeaseSchema = z.object({
  leaseId: idSchema,
  executionId: idSchema,
  runnerId: idSchema,
  generation: z.number().int().positive(),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  renewalAfter: z.string().datetime(),
  leaseToken: z.string().min(32).max(1_024)
}).strict();
export type ExecutionLease = z.infer<typeof executionLeaseSchema>;

export const workAssignmentSchema = z.object({
  executionId: idSchema,
  eventId: idSchema,
  workspaceId: idSchema,
  environmentId: idSchema,
  deploymentId: idSchema,
  workflowId: idSchema,
  workflowRevisionId: idSchema,
  trigger: z.string().min(1).max(120),
  encryptedPayloadReference: z.string().min(1).max(2_048),
  permissionSnapshotId: idSchema,
  region: z.string().min(1).max(80),
  requiredCapabilities: z.array(nodeCapabilitySchema).max(1_000),
  requiredPlugins: z.array(runnerPluginAvailabilitySchema).max(1_000),
  requiredConnectionIds: z.array(idSchema).max(1_000),
  lease: executionLeaseSchema,
  timeoutAt: z.string().datetime(),
  recoveryMode: z.enum(["fresh", "resume", "operator_resolved"]),
  checkpointId: idSchema.nullable()
}).strict();
export type WorkAssignment = z.infer<typeof workAssignmentSchema>;

export const workClaimResponseSchema = z.object({
  protocolVersion: z.literal(RUNNER_PROTOCOL_VERSION),
  kind: z.literal("work_claim_result"),
  messageId: idSchema,
  runnerId: idSchema,
  sentAt: z.string().datetime(),
  correlationId: idSchema,
  assignments: z.array(workAssignmentSchema).max(100),
  retryAfterMs: z.number().int().min(100).max(300_000)
}).strict();

export const leaseRenewalSchema = runnerProtocolBaseSchema.extend({
  kind: z.literal("lease_renewal"),
  executionId: idSchema,
  leaseId: idSchema,
  generation: z.number().int().positive(),
  leaseToken: z.string().min(32).max(1_024),
  requestedExtensionSeconds: z.number().int().min(5).max(300)
}).strict();

export const runnerCancellationSchema = runnerProtocolBaseSchema.extend({
  kind: z.literal("cancellation_ack"),
  executionId: idSchema,
  leaseId: idSchema,
  outcome: z.enum(["cancelled", "already_terminal", "not_running", "unable_to_confirm"]),
  checkpointId: idSchema.nullable()
}).strict();

export const sideEffectClassificationSchema = z.enum(["none", "idempotent", "safe_retry", "unsafe", "unknown"]);
export type SideEffectClassification = z.infer<typeof sideEffectClassificationSchema>;

export const runnerProgressEventSchema = runnerProtocolBaseSchema.extend({
  kind: z.literal("progress"),
  executionId: idSchema,
  leaseId: idSchema,
  generation: z.number().int().positive(),
  sequence: z.number().int().nonnegative(),
  eventType: z.enum(["starting", "node_started", "node_completed", "node_failed", "approval_wait", "retrying", "log", "artifact", "completed", "health"]),
  nodeId: z.string().min(1).max(200).nullable(),
  nodeVersion: z.number().int().positive().nullable(),
  level: z.enum(["trace", "debug", "info", "warn", "error"]).nullable(),
  message: z.string().max(8_192).nullable(),
  redactedMetadata: z.record(z.string(), z.unknown()),
  outputMetadata: z.object({ reference: z.string().max(2_048), contentType: z.string().max(200), sizeBytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().nullable(),
  artifact: z.object({ artifactId: idSchema, uploadUrl: z.string().url(), expiresAt: z.string().datetime(), maximumBytes: z.number().int().positive() }).strict().nullable(),
  sideEffect: sideEffectClassificationSchema.nullable(),
  idempotencyKey: z.string().min(16).max(200).nullable()
}).strict();

export const runnerDrainSchema = runnerProtocolBaseSchema.extend({
  kind: z.literal("drain_status"),
  maintenanceState: z.enum(["draining", "maintenance"]),
  activeExecutionIds: z.array(idSchema).max(1_000),
  estimatedCompleteAt: z.string().datetime().nullable()
}).strict();

export const runnerUpdateStatusSchema = runnerProtocolBaseSchema.extend({
  kind: z.literal("update_status"),
  channel: z.enum(["stable", "preview", "development"]),
  currentVersion: z.string().min(1).max(50),
  targetVersion: z.string().min(1).max(50).nullable(),
  status: z.enum(["idle", "available", "downloading", "ready", "installing", "failed", "pinned"]),
  detail: z.string().max(1_000).nullable()
}).strict();

export const runnerProtocolMessageSchema = z.discriminatedUnion("kind", [
  runnerRegistrationSchema,
  runnerHeartbeatSchema,
  workClaimRequestSchema,
  leaseRenewalSchema,
  runnerCancellationSchema,
  runnerProgressEventSchema,
  runnerDrainSchema,
  runnerUpdateStatusSchema
]);
export type RunnerProtocolMessage = z.infer<typeof runnerProtocolMessageSchema>;

export const runnerRequirementsSchema = z.object({
  protocolVersion: z.literal(RUNNER_PROTOCOL_VERSION),
  engineVersion: z.string().min(1).max(50),
  pluginRuntimeVersion: z.string().min(1).max(50),
  runnerTypes: z.array(runnerTypeSchema).min(1),
  architectures: z.array(runnerArchitectureSchema).min(1),
  workspaceId: idSchema,
  environmentId: idSchema,
  region: z.string().min(1).max(80).nullable(),
  requiredTags: z.array(z.string().min(1).max(50)).max(50),
  capabilities: z.array(nodeCapabilitySchema).max(1_000),
  plugins: z.array(runnerPluginAvailabilitySchema).max(1_000),
  connectionIds: z.array(idSchema).max(1_000),
  minimumAvailableConcurrency: z.number().int().positive().default(1)
}).strict();
export type RunnerRequirements = z.infer<typeof runnerRequirementsSchema>;

export interface RunnerCompatibilityResult { compatible: boolean; reasons: string[] }

export function checkRunnerCompatibility(identity: RunnerIdentity, requirements: RunnerRequirements): RunnerCompatibilityResult {
  const reasons: string[] = [];
  if (identity.protocolVersion !== requirements.protocolVersion) reasons.push(`Protocol ${identity.protocolVersion} does not satisfy ${requirements.protocolVersion}.`);
  if (identity.engineVersion !== requirements.engineVersion) reasons.push(`Engine ${identity.engineVersion} does not satisfy ${requirements.engineVersion}.`);
  if (identity.pluginRuntimeVersion !== requirements.pluginRuntimeVersion) reasons.push(`Plugin runtime ${identity.pluginRuntimeVersion} does not satisfy ${requirements.pluginRuntimeVersion}.`);
  if (!requirements.runnerTypes.includes(identity.runnerType)) reasons.push(`Runner type ${identity.runnerType} is not allowed.`);
  if (!requirements.architectures.includes(identity.architecture)) reasons.push(`Architecture ${identity.architecture} is not allowed.`);
  if (identity.workspaceId !== requirements.workspaceId) reasons.push("Runner belongs to a different workspace.");
  if (identity.environmentId !== requirements.environmentId) reasons.push("Runner belongs to a different environment.");
  if (requirements.region !== null && identity.region !== requirements.region) reasons.push(`Region ${identity.region} does not satisfy ${requirements.region}.`);
  for (const tag of requirements.requiredTags) if (!identity.tags.includes(tag)) reasons.push(`Missing runner tag ${tag}.`);
  if (identity.maintenanceState !== "active") reasons.push(`Runner is ${identity.maintenanceState}.`);
  if (identity.concurrencyLimit < requirements.minimumAvailableConcurrency) reasons.push("Runner concurrency limit is insufficient.");
  for (const required of requirements.capabilities) {
    const available = identity.nodeCapabilities.find(item => item.nodeType === required.nodeType);
    if (!available) { reasons.push(`Missing capability ${required.nodeType}.`); continue; }
    for (const version of required.nodeVersions) if (!available.nodeVersions.includes(version)) reasons.push(`Missing capability ${required.nodeType}@${version}.`);
    if (available) reasons.push(...capabilityConstraintReasons(required.nodeType, required.constraints, available.constraints));
  }
  for (const required of requirements.plugins) {
    const available = identity.plugins.find(item => item.pluginId === required.pluginId && item.version === required.version && item.packageIntegrity === required.packageIntegrity);
    if (!available) reasons.push(`Missing exact plugin ${required.pluginId}@${required.version}.`);
  }
  for (const connectionId of requirements.connectionIds) {
    if (!identity.connections.some(item => item.connectionId === connectionId && item.environmentId === requirements.environmentId && item.status === "available")) reasons.push(`Connection ${connectionId} is unavailable.`);
  }
  return { compatible: reasons.length === 0, reasons };
}

function capabilityConstraintReasons(nodeType:string, required:Record<string,unknown>, available:Record<string,unknown>):string[] {
  const reasons:string[]=[];
  for(const key of ["runtime","helperLanguageVersion","architecture","packageEnvironmentId","networkPolicy","filesystemPolicy","binaryData"]){
    if(key in required && required[key]!==available[key]) reasons.push(`${nodeType} requires ${key} ${String(required[key])}, but the runner declares ${String(available[key]??"none")}.`);
  }
  if(typeof required.runtimeVersion==="string"){
    const versions=Array.isArray(available.runtimeVersions)?available.runtimeVersions.filter((value):value is string=>typeof value==="string"):typeof available.runtimeVersion==="string"?[available.runtimeVersion]:[];
    if(!versions.some(version=>runtimeVersionSatisfies(version,required.runtimeVersion as string))) reasons.push(`${nodeType} requires runtime ${required.runtimeVersion}, but the runner declares ${versions.join(", ")||"none"}.`);
  }
  for(const [requiredKey,availableKey,label] of [["maximumMemoryBytes","maximumMemoryBytes","memory"],["maximumDurationMs","maximumDurationMs","duration"]] as const){
    if(typeof required[requiredKey]==="number"&&(typeof available[availableKey]!=="number"||(available[availableKey] as number)<(required[requiredKey] as number))) reasons.push(`${nodeType} runner ${label} limit is insufficient.`);
  }
  if(Array.isArray(required.credentialBindings)){const bindings=Array.isArray(available.credentialBindings)?available.credentialBindings:[];for(const binding of required.credentialBindings)if(!bindings.includes(binding))reasons.push(`${nodeType} credential binding ${String(binding)} is unavailable.`);}
  return reasons;
}
function runtimeVersionSatisfies(actual:string,requirement:string){const parse=(value:string)=>value.replace(/^v/,"").split(".").map(Number);const a=parse(actual),r=parse(requirement.replace(/^>=/,""));if(a.some(Number.isNaN)||r.some(Number.isNaN))return actual===requirement;return requirement.startsWith(">=")?(a[0]>r[0]||(a[0]===r[0]&&(a[1]??0)>=(r[1]??0))):r.every((value,index)=>a[index]===value);}

export const environmentKeySchema = z.enum(["development", "staging", "production"]);
export type EnvironmentKey = z.infer<typeof environmentKeySchema>;

export const executionTargetSchema = z.enum(["this_computer", "paired_desktop", "managed_cloud_runner", "managed_browser_worker", "self_hosted_server", "nas_or_raspberry_pi", "runner_pool"]);
export type ExecutionTarget = z.infer<typeof executionTargetSchema>;

export const deploymentStatusSchema = z.enum(["draft", "validating", "awaiting_approval", "deploying", "active", "degraded", "paused", "failed", "superseded", "rolled_back"]);
export type DeploymentStatus = z.infer<typeof deploymentStatusSchema>;

export const usageEstimateSchema = z.object({
  periodDays: z.number().int().min(1).max(366),
  expectedExecutions: z.number().int().nonnegative(),
  hostedExecutionSeconds: z.number().nonnegative(),
  browserWorkerSeconds: z.number().nonnegative(),
  expectedConcurrentExecutions: z.number().int().nonnegative(),
  retryMultiplier: z.number().min(1).max(100),
  confidence: z.enum(["low", "medium", "high"]),
  basis: z.array(z.string().min(1).max(500)).max(50),
  disclaimer: z.literal("Estimate only; actual usage and cost may differ.")
}).strict();
export type UsageEstimate = z.infer<typeof usageEstimateSchema>;

export const deploymentRecordSchema = z.object({
  deploymentId: idSchema,
  workspaceId: idSchema,
  workflowId: idSchema,
  workflowRevisionId: idSchema,
  environmentId: idSchema,
  environment: environmentKeySchema,
  target: executionTargetSchema,
  targetRunnerId: idSchema.nullable(),
  runnerPoolId: idSchema.nullable(),
  region: z.string().min(1).max(80),
  requiredConnectionIds: z.array(idSchema).max(1_000),
  requiredPlugins: z.array(runnerPluginAvailabilitySchema).max(1_000),
  permissionSnapshotId: idSchema,
  status: deploymentStatusSchema,
  validation: z.record(z.string(), z.unknown()),
  usageEstimate: usageEstimateSchema,
  createdBy: idSchema,
  createdAt: z.string().datetime(),
  activatedAt: z.string().datetime().nullable(),
  supersedesDeploymentId: idSchema.nullable()
}).strict();
export type DeploymentRecord = z.infer<typeof deploymentRecordSchema>;

export const deploymentValidationIssueSchema = z.object({
  code: z.string().min(1).max(120),
  severity: z.enum(["error", "warning", "info"]),
  message: z.string().min(1).max(1_000),
  nodeId: z.string().max(200).nullable(),
  resourceId: z.string().max(200).nullable()
}).strict();
export type DeploymentValidationIssue = z.infer<typeof deploymentValidationIssueSchema>;

export const runSummarySchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  workflowId: idSchema,
  revisionId: idSchema,
  runnerId: idSchema,
  trigger: z.string().max(100),
  status: z.enum(["waiting", "running", "successful", "failed", "cancelled", "expired"]),
  startedAt: z.string().datetime().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  failedNodeId: z.string().max(200).nullable(),
  redactedErrorSummary: z.string().max(2_000).nullable()
});
export type RunSummary = z.infer<typeof runSummarySchema>;

export const workspaceActivitySummarySchema = z.object({
  generatedAt: z.string().datetime(),
  runners: z.array(runnerRecordSchema),
  runs: z.array(runSummarySchema),
  pendingApprovalCount: z.number().int().nonnegative(),
  webhookFailureCount: z.number().int().nonnegative(),
  syncConflictCount: z.number().int().nonnegative()
}).strict();
export type WorkspaceActivitySummary = z.infer<typeof workspaceActivitySummarySchema>;

export const executionStateSchema = z.enum([
  "queued",
  "waiting_for_runner",
  "claimed",
  "starting",
  "running",
  "waiting_for_approval",
  "retrying",
  "cancelling",
  "succeeded",
  "failed",
  "timed_out",
  "skipped",
  "cancelled",
  "lost",
  "expired"
]);
export type ExecutionState = z.infer<typeof executionStateSchema>;

export const executionActorSchema = z.object({
  actorType: z.enum(["system", "account", "runner"]),
  actorId: idSchema.nullable(),
  runnerId: idSchema.nullable()
}).strict().superRefine((actor, context) => {
  if (actor.actorType === "runner" && actor.runnerId === null) context.addIssue({ code: "custom", message: "Runner transitions require runnerId." });
  if (actor.actorType === "account" && actor.actorId === null) context.addIssue({ code: "custom", message: "Account transitions require actorId." });
});
export type ExecutionActor = z.infer<typeof executionActorSchema>;

export const executionTransitionSchema = z.object({
  transitionId: idSchema,
  executionId: idSchema,
  fromState: executionStateSchema,
  toState: executionStateSchema,
  occurredAt: z.string().datetime(),
  actor: executionActorSchema,
  reason: z.string().min(1).max(500),
  expectedVersion: z.number().int().nonnegative(),
  leaseId: idSchema.nullable(),
  correlationId: idSchema,
  metadata: z.record(z.string(), z.unknown()).default({})
}).strict();
export type ExecutionTransition = z.infer<typeof executionTransitionSchema>;

export const executionCheckpointSchema = z.object({
  checkpointId: idSchema,
  executionId: idSchema,
  workflowRevisionId: idSchema,
  nodeId: z.string().min(1).max(200),
  nodeVersion: z.number().int().positive(),
  attempt: z.number().int().positive(),
  status: z.enum(["completed", "failed"]),
  inputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  outputReference: z.string().max(2_048).nullable(),
  sideEffect: sideEffectClassificationSchema,
  idempotencyKey: z.string().min(16).max(200).nullable(),
  completedAt: z.string().datetime(),
  runnerId: idSchema
}).strict();
export type ExecutionCheckpoint = z.infer<typeof executionCheckpointSchema>;

export const executionRecoverySchema = z.object({
  disposition: z.enum(["resume", "restart", "review_required", "abandon"]),
  certainty: z.enum(["certain", "uncertain"]),
  checkpointId: idSchema.nullable(),
  resumeAfterNodeId: z.string().max(200).nullable(),
  reason: z.string().min(1).max(1_000),
  preserveIdempotencyKey: z.boolean()
}).strict();
export type ExecutionRecovery = z.infer<typeof executionRecoverySchema>;

export const auditEventSchema = z.object({
  eventId: idSchema,
  timestamp: z.string().datetime(),
  actorAccountId: idSchema.nullable(),
  workspaceId: idSchema,
  action: z.string().min(1).max(120),
  resourceType: z.string().min(1).max(80),
  resourceId: z.string().min(1).max(200),
  beforeSummary: z.record(z.string(), z.unknown()).nullable(),
  afterSummary: z.record(z.string(), z.unknown()).nullable(),
  sourceDeviceId: idSchema.nullable(),
  correlationId: idSchema
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

export const entitlementClaimSchema = z.object({
  entitlementId: idSchema,
  owner: ownerRefSchema,
  pluginId: z.string().min(3),
  planId: z.string().min(1),
  status: z.enum(["trial", "active", "past_due", "expired", "refunded", "revoked"]),
  seatAllowance: z.number().int().positive().nullable(),
  validFrom: z.string().datetime(),
  validUntil: z.string().datetime().nullable(),
  offlineGraceUntil: z.string().datetime(),
  issuer: z.string().url(),
  keyId: z.string().min(1),
  signature: z.string().min(1)
});
export type EntitlementClaim = z.infer<typeof entitlementClaimSchema>;

export const webhookEventSchema = z.object({
  deliveryId: idSchema,
  endpointId: idSchema,
  workspaceId: idSchema,
  receivedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  payloadCiphertext: z.string().min(1),
  idempotencyKey: z.string().min(16),
  status: z.enum(["queued", "delivered", "expired", "failed"])
});
export type WebhookEvent = z.infer<typeof webhookEventSchema>;

export const marketplaceListingSchema = z.object({
  pluginId: z.string(), name: z.string(), summary: z.string(), publisher: z.object({ publicId: z.string(), publicName: z.string(), verified: z.boolean() }),
  version: z.string(), packageIntegrity: z.string(), categories: z.array(z.string()), keywords: z.array(z.string()), pricing: z.record(z.string(), z.unknown()), licence: z.string(),
  documentationUrl: z.string().url(), privacyPolicyUrl: z.string().url().nullable(), supportUrl: z.string().url(), screenshots: z.array(z.unknown()), securityNotices: z.array(z.unknown()),
  capabilities: z.array(z.unknown()), networkDomains: z.array(z.unknown()), nodes: z.array(z.unknown()), minimumHostVersion: z.string(), maximumHostVersion: z.string().nullable(),
  installCount: z.number().int().nonnegative(), ratingAverage: z.number().nullable(), ratingCount: z.number().int().nonnegative(), updatedAt: z.string().datetime(), visibility: z.enum(["public", "organisation", "selected_workspaces"])
});
export type MarketplaceListing = z.infer<typeof marketplaceListingSchema>;

export interface Page<T> { items: T[]; nextCursor: string | null }

export function hasPermission(role: BuiltInRole, permission: Permission): boolean {
  return rolePermissionMatrix[role].includes(permission);
}
