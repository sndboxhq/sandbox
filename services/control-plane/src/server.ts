import { createHash, randomBytes, randomUUID } from "node:crypto";
import rateLimit from "@fastify/rate-limit";
import { executionTargetSchema, hasPermission, permissions, runnerIdentitySchema, runnerRequirementsSchema, runSummarySchema, usageEstimateSchema, workflowRevisionSchema, type Permission, type RunnerCommand } from "@sandbox/contracts";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import { Authorizer } from "./authorization.js";
import type { TransactionalEmail } from "./email.js";
import type { BillingProvider } from "./billing.js";
import type { EntitlementClaimSigner } from "./entitlement.js";
import { redactWebhookPayload, verifyWebhookSignature, type WebhookProtector } from "./webhook_crypto.js";
import type { ImmutablePackageStorage, PackageReviewScanner } from "./package_services.js";
import type { AuthenticatedSession, ControlPlaneRepository, ScimManagedUserRecord, SessionVerifier } from "./types.js";
import { DomainError } from "./types.js";
import { buildSignedRunnerCommand, type RunnerCommandSigner } from "./runner_protocol.js";
import type { CredentialAdministration } from "./credentials.js";
import { apiActorScope, apiRequestHash, buildOpenApiDocument, type ApiIdempotencyStore, type ApiRouteDescription } from "./api_contract.js";
import type { PostgresUsageLedger } from "./usage.js";
import type { UsageProducerAuthenticator } from "./usage_producer.js";
import type { ServiceAccountAccessReviewAdministration } from "./access_reviews.js";
import { validMetricsBearer, type ReadinessService, type ServiceMetrics } from "./reliability.js";
import type { SupportAccessAdministration } from "./support_access.js";
import type { PrivacyAdministration } from "./privacy.js";
import type { ProductCommerceAdministration } from "./product_commerce.js";
import { validateDeployment } from "./deployment.js";
import type { PostgresExecutionCoordinator } from "./execution_coordinator.js";
import type { BugReportSink } from "./bug_reports.js";
import type { PrepaidBillingAdministration } from "./prepaid.js";
import type { ReferralAdministration } from "./referrals.js";

const organisationInput = z.object({ name: z.string().trim().min(2).max(100), slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(63) });
const invitationInput = z.object({
  email: z.string().email(),
  role: z.enum(["owner", "administrator", "developer", "operator", "viewer"]),
  workspaceIds: z.array(z.string().uuid()).min(1).max(20),
  expiresInHours: z.number().int().min(1).max(168).default(72)
});
const acceptInvitationInput = z.object({ token: z.string().min(32).max(256) });
const bugReportInput = z.object({
  summary: z.string().trim().min(4).max(120),
  description: z.string().trim().min(10).max(2_000),
  diagnostics: z.record(z.string().trim().min(1).max(40), z.string().trim().max(300))
    .refine(value => Object.keys(value).length <= 10, "At most 10 diagnostic fields are accepted.")
    .default({})
}).strict();
const syncedWorkflowInput = z.object({ workflowId: z.string().uuid(), name: z.string().trim().min(1).max(200) });
const syncConflictResolutionInput = z.object({ revisionId: z.string().uuid() });
const pluginSubmissionInput = z.object({
  pluginId: z.string().regex(/^[a-z0-9]+([.-][a-z0-9]+)+$/).max(200), name: z.string().trim().min(1).max(120), summary: z.string().trim().min(1).max(500),
  visibility: z.enum(["public", "organisation", "selected_workspaces"]), ownerType: z.enum(["personal", "organisation"]), ownerId: z.string().uuid(),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/).max(50), manifestVersion: z.number().int().positive(), manifest: z.record(z.string(), z.unknown()),
  packageIntegrity: z.string().regex(/^sha256:[a-f0-9]{64}$/), packageSize: z.number().int().min(1).max(32 * 1024 * 1024), publisherKeyId: z.string().min(1).max(120),
  minimumHostVersion: z.string().min(1).max(100), maximumHostVersion: z.string().max(100).nullable(), capabilities: z.array(z.unknown()).max(100), networkDomains: z.array(z.unknown()).max(100),
  dependencyInventory: z.array(z.unknown()).max(2_000), reproducibility: z.record(z.string(), z.unknown())
});
const reviewDecisionInput = z.object({ decision: z.enum(["approved", "changes_requested", "rejected"]), reasons: z.array(z.string().min(1).max(1_000)).max(50) });
const revocationInput = z.object({ reason: z.string().trim().min(10).max(2_000), securityNoticeUrl: z.string().url().startsWith("https://") });
const publisherInput = z.object({ publicId: z.string().regex(/^[a-z0-9]+([.-][a-z0-9]+)+$/).max(200), ownerType: z.enum(["personal", "organisation"]), ownerId: z.string().uuid(), publicName: z.string().trim().min(2).max(120), slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(63), description: z.string().max(2_000).default(""), website: z.string().url().startsWith("https://").nullable(), supportContact: z.string().email(), securityContact: z.string().email() });
const publisherKeyInput = z.object({ keyId: z.string().regex(/^[a-zA-Z0-9._-]+$/).max(120), algorithm: z.literal("ed25519"), publicKeyDerBase64: z.string().base64().max(256) });
const marketplaceQuery = z.object({ search: z.string().trim().max(200).nullable().default(null), category: z.string().trim().max(80).nullable().default(null), pricing: z.enum(["all", "free", "paid"]).default("all"), verifiedOnly: z.stringbool().default(false), visibility: z.enum(["public", "workspace", "all"]).default("public"), workspaceId: z.string().uuid().nullable().default(null), teamApprovedOnly: z.stringbool().default(false), sort: z.enum(["recent", "installs", "rating"]).default("recent"), cursor: z.string().max(200).nullable().default(null), limit: z.coerce.number().int().min(1).max(50).default(24), hostVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/).default("0.5.0") });
const installedPluginVersion = z.object({ pluginId: z.string().min(3).max(200), version: z.string().min(1).max(50), packageIntegrity: z.string().regex(/^sha256:[a-f0-9]{64}$/) });
const runnerPairingInput = z.object({
  devicePublicKeyDerBase64: z.string().base64().max(256), operatingSystem: z.string().trim().min(1).max(80), architecture: z.string().trim().min(1).max(80),
  applicationVersion: z.string().trim().min(1).max(50), protocolVersion: z.number().int().positive().max(10_000), pluginRuntimeVersion: z.string().trim().min(1).max(50),
  capabilities: z.record(z.string(), z.unknown()), safeFolderLabels: z.array(z.string().trim().min(1).max(100)).max(100).default([]), browserEngine: z.record(z.string(), z.unknown()).nullable().default(null),
  installedPluginVersions: z.array(installedPluginVersion).max(500).default([]), tags: z.array(z.string().trim().min(1).max(50)).max(50).default([])
});
const runnerPairingConfirmation = z.object({ challengeId: z.string().uuid(), challenge: z.string().min(32).max(256), signatureBase64: z.string().base64().max(256), workspaceId: z.string().uuid().nullable(), displayName: z.string().trim().min(1).max(100) });
const runnerCommandInput = z.object({
  targetRunnerId: z.string().uuid(), action: z.enum(["run_workflow", "cancel_execution", "pause_workflow", "resume_workflow", "request_diagnostics", "sync_revision"]),
  environmentId:z.string().uuid(),workflowRevisionId: z.string().uuid().nullable().default(null), payload: z.record(z.string(), z.unknown()).default({}), idempotencyKey: z.string().min(16).max(200), expiresInSeconds: z.number().int().min(15).max(86_400).default(300)
});
const approvalDecisionInput = z.object({ decision: z.enum(["approved", "rejected"]), reason: z.string().trim().min(1).max(2_000).nullable().default(null) });
const publishWorkflowInput = z.object({ changeSummary: z.string().trim().min(1).max(2_000) });
const rollbackWorkflowInput = z.object({ revisionId: z.string().uuid(), reason: z.string().trim().min(1).max(2_000) });
const governancePolicyValueSchemas = {
  permitted_plugins: z.array(z.string().min(3).max(200)).max(1_000), verified_publishers_only: z.boolean(), private_plugins: z.boolean(), command_execution: z.boolean(), external_communication: z.boolean(),
  approved_network_domains: z.array(z.string().regex(/^(?:\*\.)?[a-z0-9.-]+$/).max(253)).max(1_000), shared_connections: z.boolean(), workflow_publishing: z.boolean(), required_approval_count: z.number().int().min(1).max(10),
  runner_operating_systems: z.array(z.string().trim().min(1).max(80)).max(20), minimum_application_version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/), execution_history_retention_days: z.number().int().min(1).max(3_650),
  screenshot_upload: z.boolean(), remote_execution: z.boolean(), webhook_retention_seconds: z.number().int().min(60).max(604_800)
} as const;
const governancePolicyInput = z.object({ policyKey: z.enum(Object.keys(governancePolicyValueSchemas) as [keyof typeof governancePolicyValueSchemas, ...(keyof typeof governancePolicyValueSchemas)[]]), policyValue: z.unknown() });
const memberRoleInput = z.object({ role: z.enum(["owner", "administrator", "developer", "operator", "viewer"]) });
const runnerHeartbeatInput = z.object({ currentWorkload: z.number().int().min(0).max(10_000), status: z.enum(["online", "paused", "draining", "maintenance"]).default("online") });
const runnerCommandStatusInput = z.object({ status: z.enum(["accepted", "rejected", "completed"]), resultSummary: z.record(z.string(), z.unknown()).nullable().default(null) });
const runnerTriggerEventsInput = z.object({
  events: z.array(z.object({
    eventId: z.string().uuid(), deploymentId: z.string().uuid(), workflowRevisionId: z.string().uuid(),
    nodeId: z.string().min(1).max(200), pluginId: z.string().min(3).max(200), pluginVersion: z.string().min(1).max(50),
    dedupeKey: z.string().min(1).max(500), occurredAt: z.string().datetime({ offset: true }),
    payload: z.record(z.string(), z.unknown()), providerCheckpoint: z.record(z.string(), z.unknown()).nullable().default(null)
  }).strict()).min(1).max(100)
}).strict();
const webhookDeliveryStatusInput = z.object({ outcome: z.enum(["delivered", "retry", "failed"]) }).strict();
const sharedConnectionInput = z.object({
  environmentId: z.string().uuid(), provider: z.string().regex(/^[a-z0-9._-]+$/).max(100), displayName: z.string().trim().min(1).max(120), accountIdentity: z.string().trim().max(200).nullable().default(null),
  grantedScopes: z.array(z.string().min(1).max(200)).max(200).default([]), permittedWorkflowIds: z.array(z.string().uuid()).max(500).default([]), permittedRoleIds: z.array(z.string().uuid()).max(50).default([]),
  approvalRequirements: z.record(z.string(), z.unknown()).default({}), deploymentMode: z.literal("authorize_per_runner")
}).strict();
const sharedConnectionDeploymentInput = z.object({ runnerId: z.string().uuid(), status: z.enum(["authorization_required", "available", "unavailable"]), localCredentialLabel: z.string().trim().min(1).max(120).nullable().default(null) }).strict();
const checkoutInput = z.object({ ownerType: z.enum(["personal", "workspace"]), ownerId: z.string().uuid(), planId: z.string().regex(/^[a-zA-Z0-9._-]+$/).max(100) }).strict();
const productCheckoutInput = z.object({ ownerType:z.enum(["personal","organisation"]),ownerId:z.string().uuid(),planId:z.string().regex(/^[a-z][a-z0-9_-]{1,49}$/) }).strict();
const prepaidTopUpInput = z.object({ amountCents:z.number().int().min(500).max(50_000) }).strict();
const referralClaimInput = z.object({ code:z.string().trim().toLowerCase().regex(/^[a-z0-9]{12,24}$/) }).strict();
const webhookEndpointInput = z.object({ workflowId: z.string().uuid(), allowedMethods: z.array(z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"])).min(1).max(5), schema: z.record(z.string(), z.unknown()).nullable().default(null), maximumRequestBytes: z.number().int().min(1).max(1_048_576).default(262_144), rateLimitPerMinute: z.number().int().min(1).max(1_000).default(60), retentionSeconds: z.number().int().min(60).max(604_800).default(86_400), runnerPolicy: z.record(z.string(), z.unknown()).default({}), offlineExpirySeconds: z.number().int().min(60).max(604_800).default(3_600), redactedFields: z.array(z.string().regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/)).max(100).default([]) }).strict();
const pluginRatingInput = z.object({ versionUsed: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/).max(50), stars: z.number().int().min(1).max(5), review: z.string().trim().max(5_000).default("") }).strict();
const developerResponseInput = z.object({ response: z.string().trim().min(1).max(5_000) }).strict();
const reviewReportInput = z.object({ reason: z.string().trim().min(10).max(2_000) }).strict();
const runnerUpdateInput = z.object({ displayName: z.string().trim().min(1).max(100).nullable().default(null), status: z.enum(["offline", "paused", "draining", "maintenance"]).nullable().default(null) }).strict().refine(value => value.displayName !== null || value.status !== null, "At least one runner field must be changed.");
const runnerMoveInput = z.object({ targetWorkspaceId: z.string().uuid() }).strict();
const runnerKeyRotationInput = z.object({ keyId: z.string().regex(/^[A-Za-z0-9._-]+$/).max(120), publicKeyDerBase64: z.string().base64().max(256) }).strict();
const protectedVariableInput = z.object({ valueType: z.string().regex(/^[a-z][a-z0-9._-]*$/).max(80), isSecret: z.boolean(), value: z.unknown(), description: z.string().trim().max(500).default(""), allowedWorkflowIds: z.array(z.string().uuid()).min(1).max(500) }).strict();
const protectedVariableResolutionInput = z.object({ environmentId: z.string().uuid(), workflowId: z.string().uuid(), names: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/).max(100)).min(1).max(100) }).strict();
const credentialInput=z.object({name:z.string().trim().min(1).max(120),scopes:z.array(z.enum(permissions)).min(1).max(permissions.length),organisationId:z.string().uuid(),workspaceIds:z.array(z.string().uuid()).min(1).max(100),environmentIds:z.array(z.string().uuid()).max(100).default([]),expiresInDays:z.number().int().min(1).max(90).default(30)}).strict();
const serviceAccountInput=z.object({name:z.string().trim().min(1).max(120),description:z.string().trim().max(1000).default(""),roleId:z.string().uuid(),environmentIds:z.array(z.string().uuid()).max(100).default([]),expiryPolicyDays:z.number().int().min(1).max(365).default(90)}).strict();
const serviceAccountAssignmentInput=z.object({workspaceId:z.string().uuid(),roleId:z.string().uuid(),environmentIds:z.array(z.string().uuid()).max(100).default([])}).strict();
const organisationServiceAccountInput=z.object({name:z.string().trim().min(1).max(120),description:z.string().trim().max(1000).default(""),assignments:z.array(serviceAccountAssignmentInput).min(1).max(100),expiryPolicyDays:z.number().int().min(1).max(365).default(90)}).strict();
const credentialRevocationInput=z.object({reason:z.string().trim().min(1).max(500)}).strict();
const serviceAssertionKeyInput=z.object({keyId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),publicKeyDerBase64:z.string().base64().max(2048)}).strict();
const serviceAssertionExchangeInput=z.object({clientAssertion:z.string().min(100).max(8192)}).strict();
const accessReviewDecisionInput=z.object({decision:z.enum(["retain","revoke"]),rationale:z.string().trim().min(1).max(2000)}).strict();
const supportAccessRequestInput=z.object({workspaceId:z.string().uuid(),reason:z.string().trim().min(10).max(2000),scopes:z.array(z.literal("diagnostics.read")).min(1).max(1),durationMinutes:z.number().int().min(15).max(480)}).strict();
const supportAccessDecisionInput=z.object({decision:z.enum(["approve","reject"]),rationale:z.string().trim().min(1).max(2000)}).strict();
const supportAccessRevocationInput=z.object({rationale:z.string().trim().min(1).max(2000)}).strict();
const retentionPolicyInput=z.object({executionDetailDays:z.number().int().min(1).max(3650),queueEventDays:z.number().int().min(1).max(365),webhookDeliveryDays:z.number().int().min(1).max(30),runnerCommandDays:z.number().int().min(1).max(365),auditEventDays:z.number().int().min(365).max(3650)}).strict();
const usageEventInput=z.object({
  eventId:z.string().uuid(),workspaceId:z.string().uuid(),environmentId:z.string().uuid(),executionId:z.string().uuid(),deploymentId:z.string().uuid(),
  meter:z.enum(["hosted_runner_seconds","managed_browser_seconds","network_egress_bytes","artifact_storage_byte_seconds"]),unit:z.enum(["seconds","bytes","byte_seconds"]),quantity:z.number().int().nonnegative(),
  sourceEventId:z.string().min(1).max(200),idempotencyKey:z.string().min(16).max(200),periodStartedAt:z.string().datetime({offset:true}),periodEndedAt:z.string().datetime({offset:true}),region:z.string().min(1).max(80),metadata:z.record(z.string(),z.unknown()).default({})
}).strict();
const deploymentNodeInput=z.object({
  nodeId:z.string().min(1).max(200),nodeType:z.string().min(1).max(200),nodeVersion:z.number().int().positive(),
  plugin:z.object({pluginId:z.string().min(3).max(200),version:z.string().min(1).max(50),packageIntegrity:z.string().regex(/^sha256:[a-f0-9]{64}$/)}).nullable(),
  requiresBrowser:z.boolean(),requiresLocalFile:z.boolean(),localFileLabel:z.string().max(500).nullable(),requiredConnectionIds:z.array(z.string().uuid()).max(1000),
  requiredEnvironmentVariables:z.array(z.string().min(1).max(100)).max(1000),networkTargets:z.array(z.string().min(1).max(253)).max(1000),approvalRequired:z.boolean()
}).strict();
const deploymentValidationInput=z.object({
  target:executionTargetSchema,region:z.string().trim().min(1).max(80),requirements:runnerRequirementsSchema,nodes:z.array(deploymentNodeInput).max(5000),
  graphIssues:z.array(z.object({code:z.string().min(1).max(120),message:z.string().min(1).max(1000),nodeId:z.string().max(200).nullable()}).strict()).max(5000),
  availableRunners:z.array(runnerIdentitySchema).max(5000),availableConnectionIds:z.array(z.string().uuid()).max(1000),availableEnvironmentVariables:z.array(z.string().min(1).max(100)).max(1000),
  approvedNetworkTargets:z.array(z.string().min(1).max(253)).max(1000),approvedPluginPackages:z.array(z.object({pluginId:z.string().min(3).max(200),version:z.string().min(1).max(50),packageIntegrity:z.string().regex(/^sha256:[a-f0-9]{64}$/)}).strict()).max(1000),
  approvalSnapshotPresent:z.boolean(),concurrencyLimit:z.number().int(),retentionDays:z.number().int(),estimatedUsage:usageEstimateSchema
}).strict();
const deploymentCreateInput=z.object({workflowId:z.string().uuid(),workflowRevisionId:z.string().uuid(),environmentId:z.string().uuid(),targetRunnerId:z.string().uuid().nullable().default(null),runnerPoolId:z.string().uuid().nullable().default(null),supersedesDeploymentId:z.string().uuid().nullable().default(null),preflight:deploymentValidationInput}).strict();
const deploymentTransitionInput=z.object({status:z.enum(["active","paused","rolled_back"]),reason:z.string().trim().min(1).max(2000)}).strict();
const publicRunInput=z.object({workspaceId:z.string().uuid(),deploymentId:z.string().uuid(),encryptedPayloadReference:z.string().regex(/^object:\/\/[A-Za-z0-9][A-Za-z0-9/._:-]{0,1990}$/),triggerReference:z.string().trim().min(1).max(500).nullable().default(null),timeoutSeconds:z.number().int().min(30).max(86400).default(3600)}).strict();
const runnerPoolInput=z.object({
  environmentId:z.string().uuid(),name:z.string().trim().min(1).max(100),strategy:z.enum(["least_loaded","round_robin","priority_failover"]),region:z.string().trim().min(1).max(80).nullable().default(null),
  requiredTags:z.array(z.string().trim().min(1).max(50)).max(50).default([]),maximumConcurrency:z.number().int().min(1).max(10000),status:z.enum(["active","paused","draining"]).default("active"),
  members:z.array(z.object({runnerId:z.string().uuid(),priority:z.number().int().min(0).max(10000).default(100)}).strict()).max(5000).default([])
}).strict();
const organisationRoleInput=z.object({key:z.string().regex(/^[a-z][a-z0-9_]{1,62}$/),displayName:z.string().trim().min(2).max(100),permissions:z.array(z.enum(permissions)).min(1).max(permissions.length)}).strict();
const organisationRoleUpdateInput=organisationRoleInput.omit({key:true});
const ssoConnectionInput=z.object({connectionType:z.enum(["oidc","saml"]),displayName:z.string().trim().min(1).max(120),issuerUrl:z.string().url().startsWith("https://"),clientIdentifier:z.string().trim().min(1).max(500),verifiedDomains:z.array(z.string().regex(/^[a-z0-9.-]+$/).max(253)).max(100).default([]),enabled:z.boolean().default(false)}).strict();
const scimTokenInput=z.object({name:z.string().trim().min(1).max(120),expiresInDays:z.number().int().min(1).max(365).default(90)}).strict();
const sandboxScimExtension="urn:sandbox:params:scim:schemas:extension:1.0:User";
const scimManagedUserInput=z.object({externalId:z.string().min(1).max(500),userName:z.string().email(),displayName:z.string().trim().min(1).max(200),active:z.boolean(),role:z.string().regex(/^[a-z][a-z0-9_]{1,62}$/),workspaceIds:z.array(z.string().uuid()).min(1).max(100)}).strict();
const scimExtensionInput=z.object({role:z.string().regex(/^[a-z][a-z0-9_]{1,62}$/),workspaceIds:z.array(z.string().uuid()).min(1).max(100)}).strict();
const scimUserInput=z.object({schemas:z.array(z.string()).max(10).optional(),externalId:z.string().min(1).max(500),userName:z.string().email(),displayName:z.string().trim().min(1).max(200).optional(),name:z.object({formatted:z.string().trim().min(1).max(200).optional(),givenName:z.string().trim().max(100).optional(),familyName:z.string().trim().max(100).optional()}).strict().optional(),active:z.boolean().default(true),role:z.string().regex(/^[a-z][a-z0-9_]{1,62}$/).optional(),workspaceIds:z.array(z.string().uuid()).min(1).max(100).optional(),[sandboxScimExtension]:scimExtensionInput.optional()}).strict().superRefine((value,context)=>{const extension=value[sandboxScimExtension];if(!value.role&&!extension?.role)context.addIssue({code:"custom",message:"A sndbox organisation role is required."});if(!value.workspaceIds&&!extension?.workspaceIds)context.addIssue({code:"custom",message:"At least one sndbox workspace is required."});}).transform(value=>{const extension=value[sandboxScimExtension];return{externalId:value.externalId,userName:value.userName,displayName:value.displayName??value.name?.formatted??value.userName,active:value.active,role:(extension?.role??value.role)!,workspaceIds:(extension?.workspaceIds??value.workspaceIds)!};});
const scimPatchInput=z.object({schemas:z.array(z.string()).max(10).optional(),Operations:z.array(z.object({op:z.enum(["add","replace","remove"]),path:z.string().max(200).optional(),value:z.unknown().optional()}).strict()).min(1).max(50)}).strict();

export interface ApiDependencies {
  repository: ControlPlaneRepository;
  sessions: SessionVerifier;
  email: TransactionalEmail;
  packageStorage: ImmutablePackageStorage;
  packageScanner: PackageReviewScanner;
  runnerCommandSigner?: RunnerCommandSigner;
  billing?: BillingProvider;
  entitlementSigner?: EntitlementClaimSigner;
  webhookProtector?: WebhookProtector;
  protectedValueProtector?: WebhookProtector;
  credentialService?: CredentialAdministration;
  accessReviews?: ServiceAccountAccessReviewAdministration;
  supportAccess?: SupportAccessAdministration;
  privacy?: PrivacyAdministration;
  productCommerce?: ProductCommerceAdministration;
  readiness?: ReadinessService;
  metrics?: ServiceMetrics;
  metricsBearerToken?: string;
  idempotencyStore?: ApiIdempotencyStore;
  usageLedger?: Pick<PostgresUsageLedger,"record">;
  usageReader?: Pick<PostgresUsageLedger,"workspaceSummary">;
  usageProducerAuthenticator?: UsageProducerAuthenticator;
  prepaidBilling?: PrepaidBillingAdministration;
  referrals?: ReferralAdministration;
  executionCoordinator?: Pick<PostgresExecutionCoordinator,"enqueue"|"resolvePublicRunDeployment"|"getPublicRun">;
  bugReports?: BugReportSink;
  webhookBaseUrl?: string;
  webBaseUrl: string;
  logger?: boolean;
}

const documentedRoutes = new WeakMap<FastifyInstance, ApiRouteDescription[]>();

export function getOpenApiDocument(app: FastifyInstance): Record<string, unknown> {
  return buildOpenApiDocument(documentedRoutes.get(app) ?? []);
}

export async function createServer(dependencies: ApiDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    logger: dependencies.logger ? { redact:["req.headers.authorization","req.headers.cookie","req.body.clientAssertion","res.headers.set-cookie","body.token","body.clientAssertion"] } : false,
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
    genReqId: request => {
      const supplied = request.headers["x-correlation-id"];
      return typeof supplied === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(supplied) ? supplied : randomUUID();
    }
  });
  const routes: ApiRouteDescription[] = [];
  documentedRoutes.set(app, routes);
  app.addHook("onRoute", options => {
    for (const method of Array.isArray(options.method) ? options.method : [options.method]) routes.push({ method: method.toUpperCase(), url: options.url });
  });
  await app.register(rateLimit, {
    max: 240,
    timeWindow: "1 minute",
    keyGenerator: request => request.ip,
    errorResponseBuilder: (_request, context) => ({ statusCode: context.statusCode, code: "FST_RATE_LIMIT" })
  });
  const authorizer = new Authorizer(dependencies.repository);
  const idempotencyContexts = new WeakMap<FastifyRequest, { scope: string; key: string; ownerToken: string }>();

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError) {
      void reply.status(error.statusCode).send({ error: { code: error.code, message: error.message }, correlationId: request.id });
      return;
    }
    if (error instanceof z.ZodError) {
      void reply.status(400).send({ error: { code: "invalid_request", message: "The request did not match the API contract.", details: error.issues.map(issue => ({ path: issue.path.join("."), code: issue.code, message: issue.message })) }, correlationId: request.id });
      return;
    }
    const transportError = error as { statusCode?: number; code?: string };
    if (transportError.statusCode && transportError.statusCode >= 400 && transportError.statusCode < 500) {
      const code = transportError.statusCode === 429 ? "rate_limit_exceeded" : transportError.code === "FST_ERR_CTP_INVALID_JSON_BODY" ? "invalid_json" : "request_rejected";
      const message = code === "invalid_json" ? "The request body must be valid JSON." : transportError.statusCode === 429 ? "The request rate limit was exceeded." : "The request could not be accepted.";
      void reply.status(transportError.statusCode).send({ error: { code, message }, correlationId: request.id });
      return;
    }
    request.log.error(error);
    void reply.status(500).send({ error: { code: "internal_error", message: "The request could not be completed." }, correlationId: request.id });
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("x-correlation-id", _request.id);
    reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
    return payload;
  });
  app.addHook("onResponse", async (request, reply) => {
    dependencies.metrics?.recordRequest(request.method, request.routeOptions.url ?? "unmatched", reply.statusCode, reply.elapsedTime);
  });

  app.addHook("preHandler", async (request, reply) => {
    const store = dependencies.idempotencyStore;
    if (!store || request.url==="/v1/service-account-assertions/token" || !request.url.startsWith("/v1/") || !["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return;
    const key = request.headers["idempotency-key"];
    if (key === undefined) return;
    if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{16,200}$/.test(key)) throw new DomainError("idempotency_key_invalid", "Idempotency-Key must contain 16 to 200 safe ASCII characters.", 400);
    const authorization = typeof request.headers.authorization === "string" ? request.headers.authorization : undefined;
    const runnerId = typeof request.headers["x-sandbox-runner-id"] === "string" ? request.headers["x-sandbox-runner-id"] : undefined;
    const scope = apiActorScope(authorization, runnerId, request.ip);
    const requestHash = apiRequestHash(request.method, request.url, typeof request.headers["content-type"] === "string" ? request.headers["content-type"] : undefined, request.body);
    const claim = await store.claim(scope, key, requestHash);
    if (claim.outcome === "conflict") throw new DomainError("idempotency_key_reused", "This idempotency key was already used for a different request.", 409);
    if (claim.outcome === "in_progress") {
      reply.header("retry-after", "1");
      throw new DomainError("idempotency_request_in_progress", "An identical request with this idempotency key is still in progress.", 409);
    }
    if (claim.outcome === "replay") {
      reply.header("idempotency-replayed", "true");
      if (claim.response.contentType) reply.header("content-type", claim.response.contentType);
      if (claim.response.location) reply.header("location", claim.response.location);
      return reply.status(claim.response.statusCode).send(claim.response.body);
    }
    idempotencyContexts.set(request, { scope, key, ownerToken: claim.ownerToken });
  });

  app.addHook("onSend", async (request, reply, payload) => {
    const context = idempotencyContexts.get(request);
    if (!context || !dependencies.idempotencyStore) return payload;
    idempotencyContexts.delete(request);
    if (reply.statusCode >= 500) {
      await dependencies.idempotencyStore.abandon(context.scope, context.key, context.ownerToken);
      return payload;
    }
    try {
      const serialized = Buffer.isBuffer(payload) ? payload.toString("utf8") : typeof payload === "string" ? payload : String(payload);
      const body = serialized.length ? JSON.parse(serialized) as unknown : null;
      await dependencies.idempotencyStore.complete(context.scope, context.key, context.ownerToken, {
        statusCode: reply.statusCode,
        body,
        contentType: typeof reply.getHeader("content-type") === "string" ? String(reply.getHeader("content-type")) : null,
        location: typeof reply.getHeader("location") === "string" ? String(reply.getHeader("location")) : null
      });
    } catch (error) {
      await dependencies.idempotencyStore.abandon(context.scope, context.key, context.ownerToken);
      throw error;
    }
    return payload;
  });

  app.get("/health", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async () => ({ status: "ok", service: "sandbox-control-plane", execution: "local-only" }));
  app.get("/ready", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (_request, reply) => {
    if (!dependencies.readiness) {
      reply.status(503);
      return { status: "not_ready", checkedAt: new Date().toISOString(), checks: [] };
    }
    const result = await dependencies.readiness.check();
    dependencies.metrics?.recordReadiness(result.status === "ready");
    if (result.status !== "ready") reply.status(503);
    return result;
  });
  app.get("/metrics", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (!dependencies.metrics || !dependencies.metricsBearerToken) throw new DomainError("metrics_unavailable", "Metrics are not configured.", 503);
    if (!validMetricsBearer(request.headers.authorization, dependencies.metricsBearerToken)) throw new DomainError("authentication_required", "A valid metrics bearer token is required.", 401);
    reply.type("text/plain; version=0.0.4; charset=utf-8");
    return dependencies.metrics.prometheus();
  });
  app.get("/v1/openapi.json", async () => getOpenApiDocument(app));

  app.post("/v1/internal/usage-events", async request => {
    if (!dependencies.usageLedger || !dependencies.usageProducerAuthenticator) throw new DomainError("usage_ingestion_unavailable","Usage ingestion is not configured.",503);
    const producerId=singleHeader(request,"x-sandbox-usage-producer");
    const timestamp=singleHeader(request,"x-sandbox-usage-timestamp");
    const signature=singleHeader(request,"x-sandbox-usage-signature");
    dependencies.usageProducerAuthenticator.verify({producerId,timestamp,signature,body:request.body});
    const input=usageEventInput.parse(request.body);
    const result=await dependencies.usageLedger.record(input);
    await dependencies.prepaidBilling?.settleExecutionUsage(input.executionId);
    return {usageEventId:result.eventId,created:result.created};
  });

  app.get("/v1/product-plans", async () => {
    if (!dependencies.productCommerce) throw new DomainError("product_commerce_unavailable", "Product plans are not configured.", 503);
    return { items: await dependencies.productCommerce.listPublishedPlans() };
  });

  app.post("/v1/support/bug-reports", {
    bodyLimit: 32 * 1024,
    config: { rateLimit: { max: 4, timeWindow: "15 minutes" } }
  }, async request => {
    if (!dependencies.bugReports) {
      throw new DomainError("bug_reporting_unavailable", "Bug reporting is temporarily unavailable.", 503);
    }
    const report = bugReportInput.parse(request.body);
    return dependencies.bugReports.submit(report);
  });

  app.get("/v1/account/commerce", async request => {
    const session = await authenticate(request, dependencies.sessions);
    requireHumanPrincipal(session);
    if (!dependencies.productCommerce) throw new DomainError("product_commerce_unavailable", "Product subscriptions are not configured.", 503);
    return dependencies.productCommerce.accountSummary(session);
  });

  app.get("/v1/account/wallet", async request => {
    const session=await authenticate(request,dependencies.sessions);
    requireHumanPrincipal(session);
    if(!dependencies.prepaidBilling)throw new DomainError("prepaid_billing_unavailable","Cloud credit is not configured.",503);
    return dependencies.prepaidBilling.accountSummary(session);
  });

  app.post("/v1/account/wallet/top-ups", async request => {
    const session=await authenticate(request,dependencies.sessions);
    requireHumanPrincipal(session);requireFreshRequest(request);
    if(!dependencies.prepaidBilling||!dependencies.billing)throw new DomainError("prepaid_billing_unavailable","Cloud credit checkout is not configured.",503);
    const input=prepaidTopUpInput.parse(request.body);
    return{checkout:await dependencies.prepaidBilling.createTopUpCheckout(session,input.amountCents,dependencies.billing,dependencies.webBaseUrl)};
  });

  app.get("/v1/account/referrals", async request => {
    const session=await authenticate(request,dependencies.sessions);
    requireHumanPrincipal(session);
    if(!dependencies.referrals)throw new DomainError("referrals_unavailable","The referral program is not configured.",503);
    return dependencies.referrals.accountSummary(session,dependencies.webBaseUrl);
  });

  app.post("/v1/account/referrals/claim", {
    config:{rateLimit:{max:10,timeWindow:"1 hour"}}
  }, async request => {
    const session=await authenticate(request,dependencies.sessions);
    requireHumanPrincipal(session);requireFreshRequest(request);
    if(!dependencies.referrals)throw new DomainError("referrals_unavailable","The referral program is not configured.",503);
    return dependencies.referrals.claim(session,referralClaimInput.parse(request.body).code);
  });

  app.post("/v1/product-checkout", async request => {
    const session = await authenticate(request, dependencies.sessions);
    requireHumanPrincipal(session); requireFreshRequest(request);
    if (!dependencies.productCommerce || !dependencies.billing) throw new DomainError("product_commerce_unavailable", "Product checkout is not configured.", 503);
    const input = productCheckoutInput.parse(request.body);
    return { checkout: await dependencies.productCommerce.createCheckout(session,input.ownerType,input.ownerId,input.planId,dependencies.billing,dependencies.webBaseUrl) };
  });

  app.get("/v1/marketplace/plugins", async request => {
    const query = marketplaceQuery.parse(request.query);
    const session = await authenticateOptional(request, dependencies.sessions);
    if (query.workspaceId) {
      if (!session) throw new DomainError("authentication_required", "Sign in to browse workspace-approved or private plugins.", 401);
      await authorizer.require(session, query.workspaceId, "workflows.view");
    }
    if ((query.visibility !== "public" || query.teamApprovedOnly) && !query.workspaceId) throw new DomainError("marketplace_workspace_required", "A workspace is required for team-approved or private plugin filters.", 400);
    return dependencies.repository.searchMarketplace(session, query);
  });

  app.get("/v1/marketplace/plugins/:pluginId", async request => {
    const { pluginId } = z.object({ pluginId: z.string().regex(/^[a-z0-9]+([.-][a-z0-9]+)+$/) }).parse(request.params);
    const { workspaceId } = z.object({ workspaceId: z.string().uuid().nullable().default(null) }).parse(request.query);
    const session = await authenticateOptional(request, dependencies.sessions);
    if (workspaceId) {
      if (!session) throw new DomainError("authentication_required", "Sign in to inspect a private workspace plugin.", 401);
      await authorizer.require(session, workspaceId, "workflows.view");
    }
    const listing = await dependencies.repository.getMarketplaceListing(session, pluginId, workspaceId);
    if (!listing) throw new DomainError("listing_not_found", "Published compatible plugin listing not found.", 404);
    return { listing };
  });

  app.get("/v1/marketplace/plugins/:pluginId/install", async request => {
    const { pluginId } = z.object({ pluginId: z.string().regex(/^[a-z0-9]+([.-][a-z0-9]+)+$/) }).parse(request.params);
    const { workspaceId, ownerType, ownerId } = z.object({ workspaceId: z.string().uuid().nullable().default(null), ownerType: z.enum(["personal", "workspace"]).nullable().default(null), ownerId: z.string().uuid().nullable().default(null) }).parse(request.query);
    const session = await authenticateOptional(request, dependencies.sessions);
    if (workspaceId) {
      if (!session) throw new DomainError("authentication_required", "Sign in to install a private workspace plugin.", 401);
      await authorizer.require(session, workspaceId, "plugins.manage");
    }
    const packageRecord = await dependencies.repository.getMarketplacePackage(session, pluginId, workspaceId);
    if (!packageRecord) throw new DomainError("package_not_available", "The current signed package is unavailable, incompatible, suspended, or revoked.", 404);
    let entitlementClaim = null;
    if (packageRecord.pricingModel !== "free") {
      if (!session || !ownerType || !ownerId) throw new DomainError("entitlement_required", "Sign in and select the licensed owner before installing this paid plugin.", 402);
      if (ownerType === "personal" && ownerId !== session.accountId) throw new DomainError("entitlement_owner_invalid", "A personal entitlement must belong to the authenticated account.", 403);
      if (ownerType === "workspace") await authorizer.require(session, ownerId, "plugins.manage");
      const entitlement = await dependencies.repository.getActiveEntitlement(session, ownerType, ownerId, pluginId);
      if (!entitlement || new Date(entitlement.offlineGraceUntil).getTime() <= Date.now()) throw new DomainError("entitlement_required", "Purchase, renew, or assign an active entitlement before installing this paid plugin.", 402);
      if (!dependencies.entitlementSigner) throw new DomainError("entitlement_signing_unavailable", "Paid plugin claims are temporarily unavailable.", 503);
      entitlementClaim = dependencies.entitlementSigner.sign(entitlement);
    }
    const download = await dependencies.packageStorage.createDownload(packageRecord.packageObjectKey);
    return { pluginId: packageRecord.pluginId, version: packageRecord.version, packageIntegrity: packageRecord.packageIntegrity, packageSize: packageRecord.packageSize, publisher: { publicId: packageRecord.publisherPublicId, keyId: packageRecord.publisherKeyId, publicKeyPem: publicKeyPem(packageRecord.publisherPublicKeyDerBase64) }, entitlementClaim, download };
  });

  app.post("/v1/marketplace/plugins/:pluginId/checkout", async request => {
    const session = await authenticate(request, dependencies.sessions);
    requireFreshRequest(request);
    const { pluginId } = z.object({ pluginId: z.string().regex(/^[a-z0-9]+([.-][a-z0-9]+)+$/) }).parse(request.params);
    const input = checkoutInput.parse(request.body);
    if (input.ownerType === "personal" && input.ownerId !== session.accountId) throw new DomainError("billing_owner_invalid", "Personal checkout must belong to the authenticated account.", 403);
    if (input.ownerType === "workspace") await authorizer.require(session, input.ownerId, "organisation.billing.manage");
    if (!dependencies.billing) throw new DomainError("billing_unavailable", "Marketplace billing is temporarily unavailable.", 503);
    const plan = await dependencies.repository.getPluginBillingPlan(session, input.ownerType, input.ownerId, pluginId, input.planId);
    if (!plan) throw new DomainError("billing_plan_not_found", "This plugin plan is unavailable for the selected owner.", 404);
    const metadata = { accountId: session.accountId, ownerType: input.ownerType, ownerId: input.ownerId, pluginId, planId: input.planId, offlineGraceDays: String(plan.offlineGraceDays), seatAllowance: plan.seatAllowance === null ? "" : String(plan.seatAllowance) };
    const checkout = await dependencies.billing.createCheckout({ priceId: plan.stripePriceId, mode: plan.mode, customerId: plan.customerId ?? undefined, successUrl: `${dependencies.webBaseUrl.replace(/\/$/, "")}/billing/complete?session_id={CHECKOUT_SESSION_ID}`, cancelUrl: `${dependencies.webBaseUrl.replace(/\/$/, "")}/marketplace/${encodeURIComponent(pluginId)}`, metadata });
    await dependencies.repository.recordMarketplaceCheckout(session, checkout.checkoutId, input.ownerType, input.ownerId, pluginId, input.planId, checkout.expiresAt);
    return { checkout };
  });

  app.get("/v1/marketplace/plugins/:pluginId/reviews", async request => {
    const { pluginId } = z.object({ pluginId: z.string().regex(/^[a-z0-9]+([.-][a-z0-9]+)+$/) }).parse(request.params);
    const { cursor, limit } = z.object({ cursor: z.string().uuid().nullable().default(null), limit: z.coerce.number().int().min(1).max(50).default(20) }).parse(request.query);
    return dependencies.repository.listPluginRatings(pluginId, cursor, limit);
  });

  app.put("/v1/marketplace/plugins/:pluginId/reviews/me", async request => {
    const session = await authenticate(request, dependencies.sessions);
    requireFreshRequest(request);
    const { pluginId } = z.object({ pluginId: z.string().regex(/^[a-z0-9]+([.-][a-z0-9]+)+$/) }).parse(request.params);
    const input = pluginRatingInput.parse(request.body);
    return { review: await dependencies.repository.upsertPluginRating(session, pluginId, input.versionUsed, input.stars, input.review) };
  });

  app.post("/v1/publishers/:publisherId/plugins/:pluginId/reviews/:reviewId/response", async request => {
    const session = await authenticate(request, dependencies.sessions);
    requireFreshRequest(request);
    const { publisherId, pluginId, reviewId } = z.object({ publisherId: z.string().uuid(), pluginId: z.string().regex(/^[a-z0-9]+([.-][a-z0-9]+)+$/), reviewId: z.string().uuid() }).parse(request.params);
    const { response } = developerResponseInput.parse(request.body);
    const updated = await dependencies.repository.respondToPluginRating(session, publisherId, pluginId, reviewId, response, request.id);
    if (!updated) throw new DomainError("plugin_review_not_found", "Visible plugin review was not found for this publisher.", 404);
    return { updated: true };
  });

  app.post("/v1/marketplace/plugins/:pluginId/reviews/:reviewId/report", async request => {
    const session = await authenticate(request, dependencies.sessions);
    requireFreshRequest(request);
    const { pluginId, reviewId } = z.object({ pluginId: z.string().regex(/^[a-z0-9]+([.-][a-z0-9]+)+$/), reviewId: z.string().uuid() }).parse(request.params);
    const { reason } = reviewReportInput.parse(request.body);
    const reported = await dependencies.repository.reportPluginRating(session, pluginId, reviewId, reason);
    if (!reported) throw new DomainError("plugin_review_not_found", "Visible plugin review was not found.", 404);
    return { reported: true };
  });

  app.get("/v1/account/export", async request => {
    const session = await authenticate(request, dependencies.sessions);
    requireHumanPrincipal(session);
    return dependencies.privacy?dependencies.privacy.exportAccount(session):dependencies.repository.exportAccountData(session);
  });

  app.get("/v1/account/profile", async request => {
    const session = await authenticate(request, dependencies.sessions);
    return {
      accountId: session.accountId,
      email: session.email,
      displayName: session.email.split("@")[0],
      sessionId: session.sessionId
    };
  });

  app.get("/v1/account/organisations", async request => {
    const session = await authenticate(request, dependencies.sessions);
    return { items: await dependencies.repository.listAccountOrganisations(session) };
  });

  app.delete("/v1/account", async request => {
    const session = await authenticate(request, dependencies.sessions);
    requireHumanPrincipal(session);
    requireFreshRequest(request);
    requireRecentStepUp(session);
    if(dependencies.privacy)return{deleted:true,...await dependencies.privacy.deleteAccount(session,request.id)};
    await dependencies.repository.requestAccountDeletion(session, request.id);return { deleted: true };
  });

  app.get("/v1/account/sessions", async request => {
    const session = await authenticate(request, dependencies.sessions);
    requireHumanPrincipal(session);
    return { items: await dependencies.repository.listSessions(session) };
  });

  app.post("/v1/account/sessions/:sessionId/revoke", async request => {
    const session = await authenticate(request, dependencies.sessions);
    requireHumanPrincipal(session);
    requireFreshRequest(request);
    const { sessionId } = z.object({ sessionId: z.string().uuid() }).parse(request.params);
    const revoked = await dependencies.repository.revokeSession(session, sessionId, request.id);
    if (!revoked) throw new DomainError("session_not_found", "Session not found or already revoked.", 404);
    return { revoked: true };
  });

  app.get("/v1/personal-access-tokens",async request=>{
    const session=await authenticate(request,dependencies.sessions);requireHumanPrincipal(session);
    if(!dependencies.credentialService)throw new DomainError("credential_service_unavailable","API credentials are not configured.",503);
    return{items:await dependencies.credentialService.listPersonalTokens(session)};
  });

  app.post("/v1/personal-access-tokens",async request=>{
    const session=await authenticate(request,dependencies.sessions);requireHumanPrincipal(session);requireFreshRequest(request);
    if(!dependencies.credentialService)throw new DomainError("credential_service_unavailable","API credentials are not configured.",503);
    const input=credentialInput.parse(request.body);
    return{credential:await dependencies.credentialService.issuePersonalToken(session,{...input,expiresAt:new Date(Date.now()+input.expiresInDays*86_400_000)},request.id)};
  });

  app.delete("/v1/personal-access-tokens/:tokenId",async request=>{
    const session=await authenticate(request,dependencies.sessions);requireHumanPrincipal(session);requireFreshRequest(request);
    if(!dependencies.credentialService)throw new DomainError("credential_service_unavailable","API credentials are not configured.",503);
    const{tokenId}=z.object({tokenId:z.string().uuid()}).parse(request.params);const{reason}=credentialRevocationInput.parse(request.body);
    if(!await dependencies.credentialService.revokeToken(session,tokenId,reason,request.id))throw new DomainError("credential_not_found","Credential was not found or was already revoked.",404);
    return{revoked:true};
  });

  app.get("/v1/workspaces/:workspaceId/service-accounts",async request=>{
    const session=await authenticate(request,dependencies.sessions);const{workspaceId}=z.object({workspaceId:z.string().uuid()}).parse(request.params);
    await authorizer.require(session,{workspaceId,permission:"service_accounts.manage",resourceType:"service_account"});
    if(!dependencies.credentialService)throw new DomainError("credential_service_unavailable","Service accounts are not configured.",503);
    return{items:await dependencies.credentialService.listServiceAccounts(session,workspaceId)};
  });

  app.post("/v1/workspaces/:workspaceId/service-accounts",async request=>{
    const session=await authenticate(request,dependencies.sessions);requireHumanPrincipal(session);requireFreshRequest(request);const{workspaceId}=z.object({workspaceId:z.string().uuid()}).parse(request.params);
    await authorizer.require(session,{workspaceId,permission:"service_accounts.manage",resourceType:"service_account"});
    if(!dependencies.credentialService)throw new DomainError("credential_service_unavailable","Service accounts are not configured.",503);
    return{serviceAccount:await dependencies.credentialService.createServiceAccount(session,{workspaceId,...serviceAccountInput.parse(request.body)},request.id)};
  });

  app.post("/v1/organisations/:organisationId/service-accounts",async request=>{
    const session=await authenticate(request,dependencies.sessions);requireHumanPrincipal(session);requireFreshRequest(request);const{organisationId}=z.object({organisationId:z.string().uuid()}).parse(request.params);const input=organisationServiceAccountInput.parse(request.body);
    for(const assignment of input.assignments)await authorizer.require(session,{workspaceId:assignment.workspaceId,organisationId,permission:"service_accounts.manage",resourceType:"service_account_assignment"});
    if(!dependencies.credentialService)throw new DomainError("credential_service_unavailable","Service accounts are not configured.",503);
    return{serviceAccount:await dependencies.credentialService.createOrganisationServiceAccount(session,{organisationId,...input},request.id)};
  });

  app.post("/v1/workspaces/:workspaceId/service-accounts/:serviceAccountId/assertion-keys",async request=>{
    const session=await authenticate(request,dependencies.sessions);requireHumanPrincipal(session);requireFreshRequest(request);const{workspaceId,serviceAccountId}=z.object({workspaceId:z.string().uuid(),serviceAccountId:z.string().uuid()}).parse(request.params);const input=serviceAssertionKeyInput.parse(request.body);
    await authorizer.require(session,{workspaceId,permission:"api_credentials.manage",resourceType:"service_account",resourceId:serviceAccountId});
    if(!dependencies.credentialService)throw new DomainError("credential_service_unavailable","Service-account assertions are not configured.",503);
    return{key:await dependencies.credentialService.registerServiceAccountAssertionKey(session,serviceAccountId,workspaceId,input.keyId,input.publicKeyDerBase64,request.id)};
  });

  app.delete("/v1/workspaces/:workspaceId/service-accounts/:serviceAccountId/assertion-keys/:keyId",async request=>{
    const session=await authenticate(request,dependencies.sessions);requireHumanPrincipal(session);requireFreshRequest(request);const{workspaceId,serviceAccountId,keyId}=z.object({workspaceId:z.string().uuid(),serviceAccountId:z.string().uuid(),keyId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)}).parse(request.params);const{reason}=credentialRevocationInput.parse(request.body);
    await authorizer.require(session,{workspaceId,permission:"api_credentials.manage",resourceType:"service_account",resourceId:serviceAccountId});
    if(!dependencies.credentialService)throw new DomainError("credential_service_unavailable","Service-account assertions are not configured.",503);
    if(!await dependencies.credentialService.revokeServiceAccountAssertionKey(session,serviceAccountId,workspaceId,keyId,reason,request.id))throw new DomainError("assertion_key_not_found","Assertion key was not found or was already revoked.",404);
    return{revoked:true};
  });

  app.post("/v1/service-account-assertions/token",{config:{rateLimit:{max:30,timeWindow:"1 minute"}}},async request=>{
    if(!dependencies.credentialService)throw new DomainError("credential_service_unavailable","Service-account assertions are not configured.",503);
    const input=serviceAssertionExchangeInput.parse(request.body);
    return{credential:await dependencies.credentialService.exchangeServiceAccountAssertion(input.clientAssertion)};
  });

  app.get("/v1/workspaces/:workspaceId/service-account-access-reviews",async request=>{
    const session=await authenticate(request,dependencies.sessions);const{workspaceId}=z.object({workspaceId:z.string().uuid()}).parse(request.params);const{status}=z.object({status:z.enum(["pending","overdue","retained","revoked"]).optional()}).parse(request.query);
    await authorizer.require(session,{workspaceId,permission:"service_accounts.manage",resourceType:"service_account_access_review"});
    if(!dependencies.accessReviews)throw new DomainError("access_reviews_unavailable","Service-account access reviews are not configured.",503);
    return{items:await dependencies.accessReviews.list(session,workspaceId,status)};
  });

  app.post("/v1/service-account-access-reviews/:reviewId/decision",async request=>{
    const session=await authenticate(request,dependencies.sessions);requireHumanPrincipal(session);requireFreshRequest(request);const{reviewId}=z.object({reviewId:z.string().uuid()}).parse(request.params);const input=accessReviewDecisionInput.parse(request.body);
    if(!dependencies.accessReviews)throw new DomainError("access_reviews_unavailable","Service-account access reviews are not configured.",503);
    const workspaceIds=await dependencies.accessReviews.workspaceIds(session,reviewId);for(const workspaceId of workspaceIds)await authorizer.require(session,{workspaceId,permission:"service_accounts.manage",resourceType:"service_account_access_review",resourceId:reviewId});
    return{review:await dependencies.accessReviews.decide(session,reviewId,input.decision,input.rationale,request.id)};
  });

  app.post("/v1/platform/support-access-requests",async request=>{
    const session=await authenticate(request,dependencies.sessions);requireHumanPrincipal(session);requireFreshRequest(request);requirePlatform(session,"support_access.manage");
    if(!dependencies.supportAccess)throw new DomainError("support_access_unavailable","Support access is not configured.",503);
    const input=supportAccessRequestInput.parse(request.body);
    return{request:await dependencies.supportAccess.request(session,input.workspaceId,input.reason,input.scopes,input.durationMinutes,request.id)};
  });

  app.get("/v1/workspaces/:workspaceId/support-access-requests",async request=>{
    const session=await authenticate(request,dependencies.sessions);requireHumanPrincipal(session);const{workspaceId}=z.object({workspaceId:z.string().uuid()}).parse(request.params);
    await authorizer.require(session,{workspaceId,permission:"members.manage",resourceType:"support_access_request"});
    if(!dependencies.supportAccess)throw new DomainError("support_access_unavailable","Support access is not configured.",503);
    return{items:await dependencies.supportAccess.list(workspaceId)};
  });

  app.get("/v1/workspaces/:workspaceId/privacy-retention",async request=>{
    const session=await authenticate(request,dependencies.sessions);const{workspaceId}=z.object({workspaceId:z.string().uuid()}).parse(request.params);await authorizer.require(session,{workspaceId,permission:"policies.manage",resourceType:"privacy_retention"});
    if(!dependencies.privacy)throw new DomainError("privacy_service_unavailable","Privacy controls are not configured.",503);return{policy:await dependencies.privacy.getRetention(workspaceId)};
  });

  app.put("/v1/workspaces/:workspaceId/privacy-retention",async request=>{
    const session=await authenticate(request,dependencies.sessions);requireHumanPrincipal(session);requireFreshRequest(request);const{workspaceId}=z.object({workspaceId:z.string().uuid()}).parse(request.params);await authorizer.require(session,{workspaceId,permission:"policies.manage",resourceType:"privacy_retention"});
    if(!dependencies.privacy)throw new DomainError("privacy_service_unavailable","Privacy controls are not configured.",503);return{policy:await dependencies.privacy.setRetention(session,workspaceId,retentionPolicyInput.parse(request.body))};
  });

  app.post("/v1/support-access-requests/:requestId/decision",async request=>{
    const session=await authenticate(request,dependencies.sessions);requireHumanPrincipal(session);requireFreshRequest(request);requireRecentStepUp(session);const{requestId}=z.object({requestId:z.string().uuid()}).parse(request.params);const input=supportAccessDecisionInput.parse(request.body);
    if(!dependencies.supportAccess)throw new DomainError("support_access_unavailable","Support access is not configured.",503);
    const workspaceId=await dependencies.supportAccess.workspaceId(requestId);await authorizer.require(session,{workspaceId,permission:"members.manage",resourceType:"support_access_request",resourceId:requestId});
    return{request:await dependencies.supportAccess.decide(session,requestId,input.decision,input.rationale,request.id)};
  });

  app.post("/v1/support-access-requests/:requestId/revoke",async request=>{
    const session=await authenticate(request,dependencies.sessions);requireHumanPrincipal(session);requireFreshRequest(request);const{requestId}=z.object({requestId:z.string().uuid()}).parse(request.params);const input=supportAccessRevocationInput.parse(request.body);
    if(!dependencies.supportAccess)throw new DomainError("support_access_unavailable","Support access is not configured.",503);
    const workspaceId=await dependencies.supportAccess.workspaceId(requestId);await authorizer.require(session,{workspaceId,permission:"members.manage",resourceType:"support_access_request",resourceId:requestId});
    return{request:await dependencies.supportAccess.revoke(session,requestId,input.rationale,request.id)};
  });

  app.get("/v1/platform/support-access-requests/:requestId/diagnostics",async request=>{
    const session=await authenticate(request,dependencies.sessions);requireHumanPrincipal(session);requireFreshRequest(request);requirePlatform(session,"support_access.manage");const{requestId}=z.object({requestId:z.string().uuid()}).parse(request.params);
    if(!dependencies.supportAccess)throw new DomainError("support_access_unavailable","Support access is not configured.",503);
    return{diagnostics:await dependencies.supportAccess.diagnostics(session,requestId,request.id)};
  });

  app.post("/v1/workspaces/:workspaceId/service-accounts/:serviceAccountId/tokens",async request=>{
    const session=await authenticate(request,dependencies.sessions);requireFreshRequest(request);const{workspaceId,serviceAccountId}=z.object({workspaceId:z.string().uuid(),serviceAccountId:z.string().uuid()}).parse(request.params);
    await authorizer.require(session,{workspaceId,permission:"api_credentials.manage",resourceType:"service_account",resourceId:serviceAccountId});
    if(!dependencies.credentialService)throw new DomainError("credential_service_unavailable","Service accounts are not configured.",503);
    const input=credentialInput.parse(request.body);
    if(!input.workspaceIds.includes(workspaceId))throw new DomainError("credential_workspace_restricted","Service-account credentials must include the route workspace.",400);
    for(const assignedWorkspaceId of input.workspaceIds)if(assignedWorkspaceId!==workspaceId)await authorizer.require(session,{workspaceId:assignedWorkspaceId,organisationId:input.organisationId,permission:"api_credentials.manage",resourceType:"service_account",resourceId:serviceAccountId});
    return{credential:await dependencies.credentialService.issueServiceAccountToken(session,serviceAccountId,{...input,expiresAt:new Date(Date.now()+input.expiresInDays*86_400_000)},request.id)};
  });

  app.delete("/v1/workspaces/:workspaceId/access-tokens/:tokenId",async request=>{
    const session=await authenticate(request,dependencies.sessions);requireFreshRequest(request);const{workspaceId,tokenId}=z.object({workspaceId:z.string().uuid(),tokenId:z.string().uuid()}).parse(request.params);
    await authorizer.require(session,{workspaceId,permission:"api_credentials.manage",resourceType:"access_token",resourceId:tokenId});
    if(!dependencies.credentialService)throw new DomainError("credential_service_unavailable","API credentials are not configured.",503);
    const{reason}=credentialRevocationInput.parse(request.body);if(!await dependencies.credentialService.revokeToken(session,tokenId,reason,request.id,workspaceId))throw new DomainError("credential_not_found","Credential was not found or was already revoked.",404);
    return{revoked:true};
  });

  app.post("/v1/organisations", async request => {
    const session = await authenticate(request, dependencies.sessions);
    requireHumanPrincipal(session);
    requireFreshRequest(request);
    return dependencies.repository.createOrganisation(session, organisationInput.parse(request.body), request.id);
  });

  app.get("/v1/organisations/:organisationId/roles",async request=>{
    const session=await authenticate(request,dependencies.sessions);const {organisationId}=z.object({organisationId:z.string().uuid()}).parse(request.params);
    await requireOrganisationSecurity(session,organisationId,dependencies.repository);
    return{items:await dependencies.repository.listOrganisationRoles(session,organisationId)};
  });

  app.post("/v1/organisations/:organisationId/roles",async request=>{
    const session=await authenticate(request,dependencies.sessions);requireHumanPrincipal(session);requireFreshRequest(request);const {organisationId}=z.object({organisationId:z.string().uuid()}).parse(request.params);
    await requireOrganisationSecurity(session,organisationId,dependencies.repository);const input=organisationRoleInput.parse(request.body);
    return{role:await dependencies.repository.createOrganisationRole(session,organisationId,input.key,input.displayName,input.permissions,request.id)};
  });

  app.put("/v1/organisations/:organisationId/roles/:roleId",async request=>{
    const session=await authenticate(request,dependencies.sessions);requireHumanPrincipal(session);requireFreshRequest(request);const {organisationId,roleId}=z.object({organisationId:z.string().uuid(),roleId:z.string().uuid()}).parse(request.params);
    await requireOrganisationSecurity(session,organisationId,dependencies.repository);const input=organisationRoleUpdateInput.parse(request.body),role=await dependencies.repository.updateOrganisationRole(session,organisationId,roleId,input.displayName,input.permissions,request.id);
    if(!role)throw new DomainError("custom_role_not_found","Custom role was not found. Built-in roles cannot be changed.",404);return{role};
  });

  app.delete("/v1/organisations/:organisationId/roles/:roleId",async request=>{
    const session=await authenticate(request,dependencies.sessions);requireHumanPrincipal(session);requireFreshRequest(request);const {organisationId,roleId}=z.object({organisationId:z.string().uuid(),roleId:z.string().uuid()}).parse(request.params);
    await requireOrganisationSecurity(session,organisationId,dependencies.repository);if(!await dependencies.repository.deleteOrganisationRole(session,organisationId,roleId,request.id))throw new DomainError("custom_role_not_found","Custom role was not found. Built-in roles cannot be deleted.",404);return{deleted:true};
  });

  app.get("/v1/organisations/:organisationId/sso-connections",async request=>{
    const session=await authenticate(request,dependencies.sessions);const {organisationId}=z.object({organisationId:z.string().uuid()}).parse(request.params);await requireOrganisationSecurity(session,organisationId,dependencies.repository);return{items:await dependencies.repository.listSsoConnections(session,organisationId)};
  });

  app.post("/v1/organisations/:organisationId/sso-connections",async request=>{
    const session=await authenticate(request,dependencies.sessions);requireHumanPrincipal(session);requireFreshRequest(request);requireRecentStepUp(session);const {organisationId}=z.object({organisationId:z.string().uuid()}).parse(request.params);await requireOrganisationSecurity(session,organisationId,dependencies.repository);return{connection:await dependencies.repository.createSsoConnection(session,organisationId,ssoConnectionInput.parse(request.body),request.id)};
  });

  app.put("/v1/organisations/:organisationId/sso-connections/:connectionId",async request=>{
    const session=await authenticate(request,dependencies.sessions);requireHumanPrincipal(session);requireFreshRequest(request);requireRecentStepUp(session);const {organisationId,connectionId}=z.object({organisationId:z.string().uuid(),connectionId:z.string().uuid()}).parse(request.params);await requireOrganisationSecurity(session,organisationId,dependencies.repository);const connection=await dependencies.repository.updateSsoConnection(session,organisationId,connectionId,ssoConnectionInput.parse(request.body),request.id);if(!connection)throw new DomainError("sso_connection_not_found","SSO connection was not found.",404);return{connection};
  });

  app.delete("/v1/organisations/:organisationId/sso-connections/:connectionId",async request=>{
    const session=await authenticate(request,dependencies.sessions);requireHumanPrincipal(session);requireFreshRequest(request);requireRecentStepUp(session);const {organisationId,connectionId}=z.object({organisationId:z.string().uuid(),connectionId:z.string().uuid()}).parse(request.params);await requireOrganisationSecurity(session,organisationId,dependencies.repository);if(!await dependencies.repository.deleteSsoConnection(session,organisationId,connectionId,request.id))throw new DomainError("sso_connection_not_found","SSO connection was not found.",404);return{deleted:true};
  });

  app.get("/v1/organisations/:organisationId/scim-tokens",async request=>{
    const session=await authenticate(request,dependencies.sessions);requireHumanPrincipal(session);const {organisationId}=z.object({organisationId:z.string().uuid()}).parse(request.params);await requireOrganisationSecurity(session,organisationId,dependencies.repository);return{items:await dependencies.repository.listScimTokens(session,organisationId)};
  });

  app.post("/v1/organisations/:organisationId/scim-tokens",async request=>{
    const session=await authenticate(request,dependencies.sessions);requireHumanPrincipal(session);requireFreshRequest(request);requireRecentStepUp(session);const {organisationId}=z.object({organisationId:z.string().uuid()}).parse(request.params);await requireOrganisationSecurity(session,organisationId,dependencies.repository);const input=scimTokenInput.parse(request.body),prefix=`sbx_scim_${randomBytes(6).toString("hex")}`,token=`${prefix}.${randomBytes(32).toString("base64url")}`,tokenHash=createHash("sha256").update(token,"utf8").digest(),expiresAt=new Date(Date.now()+input.expiresInDays*86_400_000);const summary=await dependencies.repository.createScimToken(session,organisationId,input.name,prefix,tokenHash,expiresAt,request.id);return{credential:{...summary,token}};
  });

  app.delete("/v1/organisations/:organisationId/scim-tokens/:tokenId",async request=>{
    const session=await authenticate(request,dependencies.sessions);requireHumanPrincipal(session);requireFreshRequest(request);requireRecentStepUp(session);const {organisationId,tokenId}=z.object({organisationId:z.string().uuid(),tokenId:z.string().uuid()}).parse(request.params);await requireOrganisationSecurity(session,organisationId,dependencies.repository);if(!await dependencies.repository.revokeScimToken(session,organisationId,tokenId,request.id))throw new DomainError("scim_token_not_found","SCIM token was not found or already revoked.",404);return{revoked:true};
  });

  app.post("/v1/workspaces/:workspaceId/invitations", async request => {
    const session = await authenticate(request, dependencies.sessions);
    requireFreshRequest(request);
    const { workspaceId } = z.object({ workspaceId: z.string().uuid() }).parse(request.params);
    await authorizer.require(session, workspaceId, "members.manage");
    const input = invitationInput.parse(request.body);
    if (!input.workspaceIds.includes(workspaceId)) throw new DomainError("invitation_scope_invalid", "The current workspace must be included in the invitation.", 400);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + input.expiresInHours * 60 * 60 * 1_000);
    const invitation = await dependencies.repository.createInvitation(session, workspaceId, {
      email: input.email,
      role: input.role,
      workspaceIds: input.workspaceIds,
      expiresAt,
      tokenHash: createHash("sha256").update(token, "utf8").digest()
    }, request.id);
    const invitationUrl = `${dependencies.webBaseUrl.replace(/\/$/, "")}/invitations/accept?token=${encodeURIComponent(token)}`;
    try {
      await dependencies.email.sendInvitation({
        recipient: input.email,
        organisationName: invitation.organisationId,
        invitationUrl,
        expiresAt
      });
      return { invitation, delivery: { status: "sent" as const } };
    } catch (error) {
      request.log.warn({ err: error, invitationId: invitation.id }, "invitation email unavailable; returning a manual delivery link");
      return { invitation, delivery: { status: "manual" as const, invitationUrl } };
    }
  });

  app.post("/v1/invitations/accept", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async request => {
    const session = await authenticate(request, dependencies.sessions);
    requireHumanPrincipal(session);
    requireFreshRequest(request);
    const input = acceptInvitationInput.parse(request.body);
    return dependencies.repository.acceptInvitation(session, input.token, request.id);
  });

  app.delete("/v1/workspaces/:workspaceId/invitations/:invitationId", async request => {
    const session = await authenticate(request, dependencies.sessions);
    requireFreshRequest(request);
    const { workspaceId, invitationId } = z.object({ workspaceId: z.string().uuid(), invitationId: z.string().uuid() }).parse(request.params);
    await authorizer.require(session, workspaceId, "members.manage");
    const revoked = await dependencies.repository.revokeInvitation(session, workspaceId, invitationId, request.id);
    if (!revoked) throw new DomainError("invitation_not_found", "Pending invitation not found in this workspace.", 404);
    return { revoked: true };
  });

  app.get("/v1/workspaces/:workspaceId/members", async request => {
    const session = await authenticate(request, dependencies.sessions);
    const { workspaceId } = z.object({ workspaceId: z.string().uuid() }).parse(request.params);
    await authorizer.require(session, workspaceId, "workflows.view");
    return { items: await dependencies.repository.listWorkspaceMembers(session, workspaceId) };
  });

  app.put("/v1/workspaces/:workspaceId/members/:accountId/role", async request => {
    const session = await authenticate(request, dependencies.sessions);
    requireFreshRequest(request);
    const { workspaceId, accountId } = z.object({ workspaceId: z.string().uuid(), accountId: z.string().uuid() }).parse(request.params);
    const { role } = memberRoleInput.parse(request.body);
    await authorizer.require(session, workspaceId, role === "owner" ? "organisation.owners.manage" : "members.manage");
    return { member: await dependencies.repository.updateWorkspaceMemberRole(session, workspaceId, accountId, role, request.id) };
  });

  app.delete("/v1/workspaces/:workspaceId/members/:accountId", async request => {
    const session = await authenticate(request, dependencies.sessions);
    requireFreshRequest(request);
    const { workspaceId, accountId } = z.object({ workspaceId: z.string().uuid(), accountId: z.string().uuid() }).parse(request.params);
    await authorizer.require(session, workspaceId, "members.manage");
    const removed = await dependencies.repository.removeWorkspaceMember(session, workspaceId, accountId, request.id);
    if (!removed) throw new DomainError("member_not_found", "Member was not found in this workspace.", 404);
    return { removed: true };
  });

  app.get("/v1/workspaces/:workspaceId/environments", async request => {
    const session = await authenticate(request, dependencies.sessions);
    const { workspaceId } = z.object({ workspaceId: z.string().uuid() }).parse(request.params);
    await authorizer.require(session, workspaceId, "workflows.view");
    return { items: await dependencies.repository.listWorkspaceEnvironments(session, workspaceId) };
  });

  app.get("/v1/workspaces/:workspaceId/environments/:environmentId/variables", async request => {
    const session = await authenticate(request, dependencies.sessions); const { workspaceId, environmentId } = z.object({ workspaceId: z.string().uuid(), environmentId: z.string().uuid() }).parse(request.params);
    await authorizer.require(session, workspaceId, "workflows.view");
    return { items: await dependencies.repository.listProtectedVariables(session, workspaceId, environmentId) };
  });

  app.put("/v1/workspaces/:workspaceId/environments/:environmentId/variables/:name", async request => {
    const session = await authenticate(request, dependencies.sessions); requireFreshRequest(request);
    const { workspaceId, environmentId, name } = z.object({ workspaceId: z.string().uuid(), environmentId: z.string().uuid(), name: z.string().regex(/^[A-Z][A-Z0-9_]*$/).max(100) }).parse(request.params);
    await authorizer.require(session, workspaceId, "connections.manage"); const input = protectedVariableInput.parse(request.body);
    if (input.isSecret && !dependencies.protectedValueProtector) throw new DomainError("protected_value_encryption_unavailable", "Secret variable encryption is not configured.", 503);
    const encoded = Buffer.from(JSON.stringify(input.value), "utf8"); if (encoded.length > 64*1024) throw new DomainError("protected_value_too_large", "Protected variable value exceeds 64 KB.", 413);
    const valueCiphertext = input.isSecret ? dependencies.protectedValueProtector!.encrypt(encoded) : null;
    const variable = await dependencies.repository.upsertProtectedVariable(session, workspaceId, environmentId, name, input.valueType, input.isSecret, valueCiphertext, input.isSecret ? null : input.value, input.description, input.allowedWorkflowIds, request.id);
    return { variable };
  });

  app.get("/v1/workspaces/:workspaceId/connections", async request => {
    const session = await authenticate(request, dependencies.sessions);
    const { workspaceId } = z.object({ workspaceId: z.string().uuid() }).parse(request.params);
    const { environmentId } = z.object({ environmentId: z.string().uuid().nullable().default(null) }).parse(request.query);
    await authorizer.require(session, workspaceId, "connections.use");
    return { items: await dependencies.repository.listSharedConnections(session, workspaceId, environmentId) };
  });

  app.post("/v1/workspaces/:workspaceId/connections", async request => {
    const session = await authenticate(request, dependencies.sessions);
    requireFreshRequest(request);
    const { workspaceId } = z.object({ workspaceId: z.string().uuid() }).parse(request.params);
    await authorizer.require(session, workspaceId, "connections.manage");
    const { deploymentMode: _deploymentMode, ...input } = sharedConnectionInput.parse(request.body);
    return { connection: await dependencies.repository.createSharedConnection(session, workspaceId, input, request.id) };
  });

  app.put("/v1/workspaces/:workspaceId/connections/:connectionId/deployment", async request => {
    const session = await authenticate(request, dependencies.sessions);
    requireFreshRequest(request);
    const { workspaceId, connectionId } = z.object({ workspaceId: z.string().uuid(), connectionId: z.string().uuid() }).parse(request.params);
    await authorizer.require(session, workspaceId, "connections.manage");
    const input = sharedConnectionDeploymentInput.parse(request.body);
    return { deployment: await dependencies.repository.deploySharedConnection(session, workspaceId, connectionId, input.runnerId, input.status, input.localCredentialLabel, request.id) };
  });

  app.post("/v1/runners/pairing/challenges", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async request => {
    const session = await authenticate(request, dependencies.sessions);
    requireRunnerPairingPrincipal(session);
    requireFreshRequest(request);
    const input = runnerPairingInput.parse(request.body);
    validateEd25519PublicKey(input.devicePublicKeyDerBase64);
    const challenge = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    return dependencies.repository.createRunnerPairingChallenge(session, input, challenge, expiresAt);
  });

  app.post("/v1/runners/pairing/confirm", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async request => {
    const session = await authenticate(request, dependencies.sessions);
    requireRunnerPairingPrincipal(session);
    requireFreshRequest(request);
    const input = runnerPairingConfirmation.parse(request.body);
    if (input.workspaceId) await authorizer.require(session, input.workspaceId, "runners.manage");
    return { runner: await dependencies.repository.confirmRunnerPairing(session, input, request.id) };
  });

  app.get("/v1/workspaces/:workspaceId/runners", async request => {
    const session = await authenticate(request, dependencies.sessions);
    const { workspaceId } = z.object({ workspaceId: z.string().uuid() }).parse(request.params);
    await authorizer.require(session, workspaceId, "workflows.view");
    return { items: await dependencies.repository.listRunners(session, workspaceId) };
  });

  app.post("/v1/workspaces/:workspaceId/runner-commands", async request => {
    const session = await authenticate(request, dependencies.sessions);
    requireFreshRequest(request);
    const { workspaceId } = z.object({ workspaceId: z.string().uuid() }).parse(request.params);
    const input = runnerCommandInput.parse(request.body);
    const requiredPermission=runnerActionPermission(input.action);
    await authorizer.require(session,{workspaceId,environmentId:input.environmentId,permission:requiredPermission,resourceType:"runner_command",resourceId:input.targetRunnerId});
    const environment=(await dependencies.repository.listWorkspaceEnvironments(session,workspaceId)).find(item=>item.environmentId===input.environmentId);
    if(!environment)throw new DomainError("environment_not_found","The command environment was not found in this workspace.",404);
    const policies = await dependencies.repository.getGovernancePolicies(session, workspaceId);
    authorizer.enforcePolicy(policies.remote_execution !== false, { policy: "remote_execution", resource: `runner command ${input.action}`, administratorAction: "A workspace administrator can enable remote execution in Governance.", userAction: "Run the workflow directly on an eligible local runner instead." });
    if (!dependencies.runnerCommandSigner) throw new DomainError("runner_signing_unavailable", "Remote commands are unavailable because the control-plane signing key is not configured.", 503);
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + input.expiresInSeconds * 1_000);
    const command = buildSignedRunnerCommand(dependencies.runnerCommandSigner, {
      commandId: randomUUID(), issuerAccountId: session.accountId, workspaceId, targetRunnerId: input.targetRunnerId, action: input.action,
      workflowRevisionId: input.workflowRevisionId, createdAt: createdAt.toISOString(), expiresAt: expiresAt.toISOString(), idempotencyKey: input.idempotencyKey, payload: input.payload,
      authorizationContext:{principalType:session.principalType??"user",principalId:session.principalId??session.accountId,credentialId:(session.principalType??"user")==="user"?null:session.sessionId,requiredPermission,environmentId:input.environmentId,environment:environment.environment,credentialScopes:session.credentialScopes??null,workspaceRestrictions:session.workspaceRestrictions??null,environmentRestrictions:session.environmentRestrictions??null,principalPermissions:session.principalPermissions??null}
    });
    return { command: await dependencies.repository.createRunnerCommand(session, command, request.id) };
  });

  app.get("/v1/workspaces/:workspaceId/governance", async request => {
    const session = await authenticate(request, dependencies.sessions);
    const { workspaceId } = z.object({ workspaceId: z.string().uuid() }).parse(request.params);
    await authorizer.require(session, workspaceId, "workflows.view");
    return { policies: await dependencies.repository.getGovernancePolicies(session, workspaceId) };
  });

  app.put("/v1/workspaces/:workspaceId/governance", async request => {
    const session = await authenticate(request, dependencies.sessions);
    requireFreshRequest(request);
    const { workspaceId } = z.object({ workspaceId: z.string().uuid() }).parse(request.params);
    await authorizer.require(session, workspaceId, "policies.manage");
    const input = governancePolicyInput.parse(request.body);
    const schema = governancePolicyValueSchemas[input.policyKey];
    const policyValue = schema.parse(input.policyValue);
    return dependencies.repository.setGovernancePolicy(session, workspaceId, input.policyKey, policyValue, request.id);
  });

  app.delete("/v1/workspaces/:workspaceId/runners/:runnerId", async request => {
    const session = await authenticate(request, dependencies.sessions);
    requireFreshRequest(request);
    const { workspaceId, runnerId } = z.object({ workspaceId: z.string().uuid(), runnerId: z.string().uuid() }).parse(request.params);
    await authorizer.require(session, workspaceId, "runners.manage");
    const revoked = await dependencies.repository.revokeRunner(session, workspaceId, runnerId, request.id);
    if (!revoked) throw new DomainError("runner_not_found", "Runner not found in this workspace or already revoked.", 404);
    return { revoked: true, localDataDeleted: false };
  });

  app.patch("/v1/workspaces/:workspaceId/runners/:runnerId", async request => {
    const session = await authenticate(request, dependencies.sessions); requireFreshRequest(request);
    const { workspaceId, runnerId } = z.object({ workspaceId: z.string().uuid(), runnerId: z.string().uuid() }).parse(request.params);
    await authorizer.require(session, workspaceId, "runners.manage");
    const input = runnerUpdateInput.parse(request.body);
    const runner = await dependencies.repository.updateRunner(session, workspaceId, runnerId, input.displayName, input.status, request.id);
    if (!runner) throw new DomainError("runner_not_found", "Runner was not found in this workspace.", 404);
    return { runner };
  });

  app.post("/v1/workspaces/:workspaceId/runners/:runnerId/move", async request => {
    const session = await authenticate(request, dependencies.sessions); requireFreshRequest(request);
    const { workspaceId, runnerId } = z.object({ workspaceId: z.string().uuid(), runnerId: z.string().uuid() }).parse(request.params); const { targetWorkspaceId } = runnerMoveInput.parse(request.body);
    await authorizer.require(session, workspaceId, "runners.manage"); await authorizer.require(session, targetWorkspaceId, "runners.manage");
    const runner = await dependencies.repository.moveRunner(session, workspaceId, targetWorkspaceId, runnerId, request.id);
    if (!runner) throw new DomainError("runner_not_found", "Runner was not found in the source workspace.", 404);
    return { runner };
  });

  app.post("/v1/runner/heartbeat", async request => {
    const device = await authenticateRunnerDevice(request, dependencies.repository);
    const input = runnerHeartbeatInput.parse(request.body);
    return { runner: await dependencies.repository.recordRunnerHeartbeat(device, input.currentWorkload, input.status) };
  });

  app.post("/v1/runner/device-key/rotate", async request => {
    const device = await authenticateRunnerDevice(request, dependencies.repository); const input = runnerKeyRotationInput.parse(request.body); validateEd25519PublicKey(input.publicKeyDerBase64);
    return dependencies.repository.rotateRunnerDeviceKey(device, input.keyId, input.publicKeyDerBase64);
  });

  app.post("/v1/runner/environment-values", async request => {
    const device = await authenticateRunnerDevice(request, dependencies.repository); const input = protectedVariableResolutionInput.parse(request.body);
    if (!dependencies.protectedValueProtector) throw new DomainError("protected_value_encryption_unavailable", "Secret variable encryption is not configured.", 503);
    const values = await dependencies.repository.resolveProtectedVariables(device, input.environmentId, input.workflowId, input.names);
    return { values: values.map(variable => ({ name: variable.name, valueType: variable.valueType, isSecret: variable.isSecret, value: variable.isSecret ? JSON.parse(dependencies.protectedValueProtector!.decrypt(variable.valueCiphertext!).toString("utf8")) : variable.nonSecretValue })) };
  });

  app.get("/v1/runner/commands", async request => {
    const device = await authenticateRunnerDevice(request, dependencies.repository);
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }).parse(request.query);
    return { items: await dependencies.repository.dequeueRunnerCommands(device, limit) };
  });

  app.post("/v1/runner/commands/:commandId/status", async request => {
    const device = await authenticateRunnerDevice(request, dependencies.repository);
    const { commandId } = z.object({ commandId: z.string().uuid() }).parse(request.params);
    const input = runnerCommandStatusInput.parse(request.body);
    const updated = await dependencies.repository.updateRunnerCommandStatus(device, commandId, input.status, input.resultSummary);
    if (!updated) throw new DomainError("runner_command_not_found", "Command is unavailable, expired, or not assigned to this runner.", 404);
    return { updated: true };
  });

  app.post("/v1/runner/trigger-events", async request => {
    const device = await authenticateRunnerDevice(request, dependencies.repository);
    const input = runnerTriggerEventsInput.parse(request.body);
    for (const event of input.events) assertSafeTriggerEvent(event.payload, event.providerCheckpoint);
    return dependencies.repository.recordRunnerTriggerEvents(device, input.events);
  });

  app.post("/v1/runner/run-summaries", async request => {
    const device = await authenticateRunnerDevice(request, dependencies.repository);
    const summary = runSummarySchema.parse(request.body);
    if (summary.runnerId !== device.runnerId || summary.workspaceId !== device.workspaceId) throw new DomainError("runner_summary_scope_invalid", "Run summary does not match the authenticated runner and workspace.", 403);
    await dependencies.repository.recordRunSummary(device, summary);
    return { recorded: true };
  });

  app.get("/v1/runner/webhook-deliveries", async request => {
    const device = await authenticateRunnerDevice(request, dependencies.repository);
    if (!dependencies.webhookProtector) throw new DomainError("webhook_relay_unavailable", "Webhook relay encryption is not configured.", 503);
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(25).default(10) }).parse(request.query);
    const deliveries = await dependencies.repository.dequeueWebhookDeliveries(device, limit);
    return { items: deliveries.map(delivery => ({ deliveryId: delivery.deliveryId, endpointId: delivery.endpointId, workspaceId: delivery.workspaceId, workflowId: delivery.workflowId, payload: JSON.parse(dependencies.webhookProtector!.decrypt(delivery.payloadCiphertext).toString("utf8")), idempotencyKey: delivery.idempotencyKey, receivedAt: delivery.receivedAt, expiresAt: delivery.expiresAt, attemptCount: delivery.attemptCount })) };
  });

  app.post("/v1/runner/webhook-deliveries/:deliveryId/status", async request => {
    const device = await authenticateRunnerDevice(request, dependencies.repository);
    const { deliveryId } = z.object({ deliveryId: z.string().uuid() }).parse(request.params);
    const { outcome } = webhookDeliveryStatusInput.parse(request.body);
    const updated = await dependencies.repository.acknowledgeWebhookDelivery(device, deliveryId, outcome);
    if (!updated) throw new DomainError("webhook_delivery_not_found", "Webhook delivery is unavailable or assigned to another runner.", 404);
    return { updated: true, outcome };
  });

  app.get("/v1/workspaces/:workspaceId/activity", async request => {
    const session = await authenticate(request, dependencies.sessions);
    const { workspaceId } = z.object({ workspaceId: z.string().uuid() }).parse(request.params);
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }).parse(request.query);
    await authorizer.require(session, workspaceId, "executions.view_summary");
    return dependencies.repository.listWorkspaceActivity(session, workspaceId, limit);
  });

  app.get("/v1/workspaces/:workspaceId/usage", async request => {
    const session=await authenticate(request,dependencies.sessions);
    requireHumanPrincipal(session);
    const {workspaceId}=z.object({workspaceId:z.string().uuid()}).parse(request.params);
    const {days}=z.object({days:z.coerce.number().int().min(7).max(90).default(30)}).parse(request.query);
    await authorizer.require(session,{workspaceId,permission:"executions.view_summary",resourceType:"workspace_usage"});
    if(!dependencies.usageReader)throw new DomainError("usage_reporting_unavailable","Usage reporting is not configured.",503);
    return dependencies.usageReader.workspaceSummary(workspaceId,days);
  });

  app.post("/v1/workflows/:workflowId/runs",async(request,reply)=>{
    const session=await authenticate(request,dependencies.sessions);requireFreshRequest(request);
    if(!dependencies.executionCoordinator)throw new DomainError("hosted_execution_unavailable","Hosted execution coordination is not configured.",503);
    const {workflowId}=z.object({workflowId:z.string().uuid()}).parse(request.params),input=publicRunInput.parse(request.body);
    await authorizer.require(session,input.workspaceId,"workflows.run");
    const context=await dependencies.executionCoordinator.resolvePublicRunDeployment(workflowId,input.deploymentId);
    if(!context||context.workspaceId!==input.workspaceId)throw new DomainError("deployment_not_found","An active deployment was not found for this workflow in the selected workspace.",404);
    await authorizer.require(session,{workspaceId:context.workspaceId,environmentId:context.environmentId,permission:"workflows.run",resourceType:"workflow_deployment",resourceId:context.deploymentId});
    if(context.targetType==="managed_cloud_runner"||context.targetType==="managed_browser_worker"){
      if(!dependencies.prepaidBilling)throw new DomainError("prepaid_billing_unavailable","Managed execution billing is not configured.",503);
      await dependencies.prepaidBilling.assertWorkspaceFunded(context.workspaceId,context.targetType);
    }
    const idempotencyKey=request.headers["idempotency-key"];
    if(typeof idempotencyKey!=="string"||!/^[A-Za-z0-9._:-]{16,200}$/.test(idempotencyKey))throw new DomainError("idempotency_key_required","Idempotency-Key with 16 to 200 safe ASCII characters is required to start a run.",400);
    const queuedAt=new Date(),queued=await dependencies.executionCoordinator.enqueue({executionId:randomUUID(),workspaceId:context.workspaceId,environmentId:context.environmentId,deploymentId:context.deploymentId,workflowId:context.workflowId,workflowRevisionId:context.workflowRevisionId,triggerType:"api",triggerReference:input.triggerReference,queueEventId:null,idempotencyKey,permissionSnapshotId:context.permissionSnapshotId,pluginVersions:context.pluginVersions,connectionReferences:context.connectionReferences,requirements:context.requirements,encryptedPayloadReference:input.encryptedPayloadReference,correlationId:request.id,queuedAt,timeoutAt:new Date(queuedAt.getTime()+input.timeoutSeconds*1000),runnerPoolId:context.runnerPoolId},true);
    const run=await dependencies.executionCoordinator.getPublicRun(queued.executionId);
    if(!run)throw new DomainError("execution_enqueue_failed","The queued run could not be read back.",500);
    reply.header("location",`/v1/runs/${run.runId}`);
    return reply.status(202).send({run:{...run,evidence:[]},idempotencyReplayed:!queued.created});
  });

  app.get("/v1/runs/:runId",async request=>{
    const session=await authenticate(request,dependencies.sessions);
    if(!dependencies.executionCoordinator)throw new DomainError("hosted_execution_unavailable","Hosted execution coordination is not configured.",503);
    const {runId}=z.object({runId:z.string().uuid()}).parse(request.params),run=await dependencies.executionCoordinator.getPublicRun(runId);
    if(!run)throw new DomainError("run_not_found","Run was not found.",404);
    await authorizer.require(session,{workspaceId:run.workspaceId,environmentId:run.environmentId,permission:"executions.view_detail",resourceType:"workflow_run",resourceId:run.runId});
    return{run};
  });

  app.get("/v1/workspaces/:workspaceId/deployments",async request=>{
    const session=await authenticate(request,dependencies.sessions);
    const {workspaceId}=z.object({workspaceId:z.string().uuid()}).parse(request.params);
    await authorizer.require(session,workspaceId,"workflows.view");
    return {items:await dependencies.repository.listDeployments(session,workspaceId)};
  });

  app.post("/v1/workspaces/:workspaceId/deployments/validate",async request=>{
    const session=await authenticate(request,dependencies.sessions);
    const {workspaceId}=z.object({workspaceId:z.string().uuid()}).parse(request.params);
    await authorizer.require(session,workspaceId,"deployments.manage");
    const input=deploymentValidationInput.parse(request.body);
    if(input.requirements.workspaceId!==workspaceId)throw new DomainError("deployment_workspace_mismatch","Runner requirements must target the requested workspace.",400);
    return {validation:validateDeployment(input)};
  });

  app.post("/v1/workspaces/:workspaceId/deployments",async(request,reply)=>{
    const session=await authenticate(request,dependencies.sessions);requireFreshRequest(request);const {workspaceId}=z.object({workspaceId:z.string().uuid()}).parse(request.params);const input=deploymentCreateInput.parse(request.body);
    await authorizer.require(session,{workspaceId,environmentId:input.environmentId,permission:"deployments.manage",resourceType:"workflow_revision",resourceId:input.workflowRevisionId});
    if(input.preflight.requirements.workspaceId!==workspaceId||input.preflight.requirements.environmentId!==input.environmentId)throw new DomainError("deployment_workspace_mismatch","Preflight requirements must match the selected workspace and environment.",400);
    const validation=validateDeployment(input.preflight);if(!validation.valid)throw new DomainError("deployment_validation_failed",`Deployment preflight contains blocking issues: ${validation.issues.filter(issue=>issue.severity==="error").map(issue=>issue.message).join("; ")}`,409);
    const requiredConnectionIds=[...new Set(input.preflight.nodes.flatMap(node=>node.requiredConnectionIds))],protectedVariableNames=[...new Set(input.preflight.nodes.flatMap(node=>node.requiredEnvironmentVariables))],networkTargets=[...new Set(input.preflight.nodes.flatMap(node=>node.networkTargets))];
    const pluginMap=new Map<string,{pluginId:string;version:string;packageIntegrity:string;nodeVersions:Record<string,number[]>}>();for(const node of input.preflight.nodes){if(!node.plugin)continue;const key=`${node.plugin.pluginId}\u0000${node.plugin.version}\u0000${node.plugin.packageIntegrity}`,current=pluginMap.get(key)??{...node.plugin,nodeVersions:{}};current.nodeVersions[node.nodeType]=[...new Set([...(current.nodeVersions[node.nodeType]??[]),node.nodeVersion])].sort((left,right)=>left-right);pluginMap.set(key,current);}const requiredPlugins=[...pluginMap.values()];
    const deployment=await dependencies.repository.createDeployment(session,workspaceId,{workflowId:input.workflowId,workflowRevisionId:input.workflowRevisionId,environmentId:input.environmentId,target:input.preflight.target,targetRunnerId:input.targetRunnerId,runnerPoolId:input.runnerPoolId,region:input.preflight.region,requiredConnectionIds,requiredPlugins,requiredCapabilities:input.preflight.requirements.capabilities,protectedVariableNames,networkTargets,requirements:input.preflight.requirements,validation:{...validation},usageEstimate:input.preflight.estimatedUsage,retentionDays:input.preflight.retentionDays,concurrencyLimit:input.preflight.concurrencyLimit,supersedesDeploymentId:input.supersedesDeploymentId},request.id);return reply.status(201).send({deployment});
  });

  app.post("/v1/workspaces/:workspaceId/deployments/:deploymentId/transition",async request=>{
    const session=await authenticate(request,dependencies.sessions);requireFreshRequest(request);const {workspaceId,deploymentId}=z.object({workspaceId:z.string().uuid(),deploymentId:z.string().uuid()}).parse(request.params),input=deploymentTransitionInput.parse(request.body);await authorizer.require(session,workspaceId,"deployments.manage");const deployment=await dependencies.repository.transitionDeployment(session,workspaceId,deploymentId,input.status,input.reason,request.id);if(!deployment)throw new DomainError("deployment_not_found","Deployment was not found in this workspace.",404);return{deployment};
  });

  app.get("/v1/workspaces/:workspaceId/runner-pools",async request=>{
    const session=await authenticate(request,dependencies.sessions);
    const {workspaceId}=z.object({workspaceId:z.string().uuid()}).parse(request.params);
    await authorizer.require(session,workspaceId,"workflows.view");
    return {items:await dependencies.repository.listRunnerPools(session,workspaceId)};
  });

  app.post("/v1/workspaces/:workspaceId/runner-pools",async request=>{
    const session=await authenticate(request,dependencies.sessions);requireFreshRequest(request);
    const {workspaceId}=z.object({workspaceId:z.string().uuid()}).parse(request.params);
    await authorizer.require(session,workspaceId,"runners.manage");
    return {pool:await dependencies.repository.createRunnerPool(session,workspaceId,runnerPoolInput.parse(request.body),request.id)};
  });

  app.put("/v1/workspaces/:workspaceId/runner-pools/:poolId",async request=>{
    const session=await authenticate(request,dependencies.sessions);requireFreshRequest(request);
    const {workspaceId,poolId}=z.object({workspaceId:z.string().uuid(),poolId:z.string().uuid()}).parse(request.params);
    await authorizer.require(session,workspaceId,"runners.manage");
    const pool=await dependencies.repository.updateRunnerPool(session,workspaceId,poolId,runnerPoolInput.parse(request.body),request.id);
    if(!pool)throw new DomainError("runner_pool_not_found","Runner pool was not found in this workspace.",404);
    return {pool};
  });

  app.delete("/v1/workspaces/:workspaceId/runner-pools/:poolId",async request=>{
    const session=await authenticate(request,dependencies.sessions);requireFreshRequest(request);
    const {workspaceId,poolId}=z.object({workspaceId:z.string().uuid(),poolId:z.string().uuid()}).parse(request.params);
    await authorizer.require(session,workspaceId,"runners.manage");
    const deleted=await dependencies.repository.deleteRunnerPool(session,workspaceId,poolId,request.id);
    if(!deleted)throw new DomainError("runner_pool_not_found","Runner pool was not found in this workspace.",404);
    return {deleted:true};
  });

  app.post("/v1/workspaces/:workspaceId/sync/revisions", async request => {
    const session = await authenticate(request, dependencies.sessions);
    const { workspaceId } = z.object({ workspaceId: z.string().uuid() }).parse(request.params);
    await authorizer.require(session, workspaceId, "workflows.edit");
    const revision = workflowRevisionSchema.parse(request.body);
    const payloadBytes = Buffer.byteLength(revision.encryptedPayload, "base64");
    const envelopeBytes = Buffer.byteLength(revision.payloadKeyEnvelope, "base64");
    if (payloadBytes > 2 * 1024 * 1024) throw new DomainError("sync_payload_too_large", "Encrypted workflow payload exceeds 2 MB.", 413);
    if (envelopeBytes > 512) throw new DomainError("sync_key_envelope_too_large", "Workflow key envelope exceeds 512 bytes.", 413);
    return dependencies.repository.appendWorkflowRevision(session, workspaceId, revision, request.id);
  });

  app.post("/v1/workspaces/:workspaceId/sync/workflows", async request => {
    const session = await authenticate(request, dependencies.sessions);
    requireFreshRequest(request);
    const { workspaceId } = z.object({ workspaceId: z.string().uuid() }).parse(request.params);
    await authorizer.require(session, workspaceId, "workflows.edit");
    return dependencies.repository.createSyncedWorkflow(session, workspaceId, syncedWorkflowInput.parse(request.body), request.id);
  });

  app.get("/v1/workspaces/:workspaceId/sync/workflows", async request => {
    const session = await authenticate(request, dependencies.sessions);
    const { workspaceId } = z.object({ workspaceId: z.string().uuid() }).parse(request.params);
    await authorizer.require(session, workspaceId, "workflows.view");
    return { items: await dependencies.repository.listSyncedWorkflows(session, workspaceId) };
  });

  app.get("/v1/workspaces/:workspaceId/sync/workflows/:workflowId/revisions", async request => {
    const session = await authenticate(request, dependencies.sessions);
    const { workspaceId, workflowId } = z.object({ workspaceId: z.string().uuid(), workflowId: z.string().uuid() }).parse(request.params);
    const { cursor, limit } = z.object({ cursor: z.string().uuid().nullable().default(null), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(request.query);
    await authorizer.require(session, workspaceId, "workflows.view");
    return dependencies.repository.listWorkflowRevisions(session, workspaceId, workflowId, cursor, limit);
  });

  app.get("/v1/workspaces/:workspaceId/sync/workflows/:workflowId/revisions/:revisionId", async request => {
    const session = await authenticate(request, dependencies.sessions);
    const { workspaceId, workflowId, revisionId } = z.object({ workspaceId: z.string().uuid(), workflowId: z.string().uuid(), revisionId: z.string().uuid() }).parse(request.params);
    await authorizer.require(session, workspaceId, "workflows.view");
    const revision = await dependencies.repository.getWorkflowRevision(session, workspaceId, workflowId, revisionId);
    if (!revision) throw new DomainError("revision_not_found", "Workflow revision not found in this workspace.", 404);
    return { revision };
  });

  app.post("/v1/workspaces/:workspaceId/sync/workflows/:workflowId/conflicts/resolve", async request => {
    const session = await authenticate(request, dependencies.sessions);
    requireFreshRequest(request);
    const { workspaceId, workflowId } = z.object({ workspaceId: z.string().uuid(), workflowId: z.string().uuid() }).parse(request.params);
    await authorizer.require(session, workspaceId, "workflows.edit");
    const { revisionId } = syncConflictResolutionInput.parse(request.body);
    return dependencies.repository.resolveSyncConflict(session, workspaceId, workflowId, revisionId, request.id);
  });

  app.post("/v1/workspaces/:workspaceId/workflows/:workflowId/revisions/:revisionId/request-approval", async request => {
    const session = await authenticate(request, dependencies.sessions);
    requireFreshRequest(request);
    const { workspaceId, workflowId, revisionId } = z.object({ workspaceId: z.string().uuid(), workflowId: z.string().uuid(), revisionId: z.string().uuid() }).parse(request.params);
    await authorizer.require(session, workspaceId, "workflows.edit");
    return { approval: await dependencies.repository.requestWorkflowApproval(session, workspaceId, workflowId, revisionId, request.id) };
  });

  app.get("/v1/workspaces/:workspaceId/workflow-approvals", async request => {
    const session = await authenticate(request, dependencies.sessions);
    const { workspaceId } = z.object({ workspaceId: z.string().uuid() }).parse(request.params);
    const { status } = z.object({ status: z.enum(["all", "pending", "approved", "rejected"]).default("pending") }).parse(request.query);
    await authorizer.require(session, workspaceId, "workflows.view");
    return { items: await dependencies.repository.listWorkflowApprovals(session, workspaceId, status) };
  });

  app.post("/v1/workspaces/:workspaceId/workflow-approvals/:approvalId/decision", async request => {
    const session = await authenticate(request, dependencies.sessions);
    requireFreshRequest(request);
    const { workspaceId, approvalId } = z.object({ workspaceId: z.string().uuid(), approvalId: z.string().uuid() }).parse(request.params);
    await authorizer.require(session, workspaceId, "workflows.approve");
    const input = approvalDecisionInput.parse(request.body);
    if (input.decision === "rejected" && !input.reason) throw new DomainError("approval_reason_required", "A rejection reason is required.", 400);
    return { approval: await dependencies.repository.decideWorkflowApproval(session, workspaceId, approvalId, input.decision, input.reason, request.id) };
  });

  app.post("/v1/workspaces/:workspaceId/workflows/:workflowId/revisions/:revisionId/publish", async request => {
    const session = await authenticate(request, dependencies.sessions);
    requireFreshRequest(request);
    const { workspaceId, workflowId, revisionId } = z.object({ workspaceId: z.string().uuid(), workflowId: z.string().uuid(), revisionId: z.string().uuid() }).parse(request.params);
    await authorizer.require(session, workspaceId, "workflows.publish");
    const input = publishWorkflowInput.parse(request.body);
    return dependencies.repository.publishWorkflowRevision(session, workspaceId, workflowId, revisionId, input.changeSummary, request.id);
  });

  app.post("/v1/workspaces/:workspaceId/workflows/:workflowId/rollback", async request => {
    const session = await authenticate(request, dependencies.sessions);
    requireFreshRequest(request);
    const { workspaceId, workflowId } = z.object({ workspaceId: z.string().uuid(), workflowId: z.string().uuid() }).parse(request.params);
    await authorizer.require(session, workspaceId, "workflows.publish");
    const input = rollbackWorkflowInput.parse(request.body);
    return dependencies.repository.rollbackWorkflowRevision(session, workspaceId, workflowId, input.revisionId, input.reason, request.id);
  });

  app.post("/v1/publishers/:publisherId/plugins/submissions", async request => {
    const session = await authenticate(request, dependencies.sessions);
    requireFreshRequest(request);
    const { publisherId } = z.object({ publisherId: z.string().uuid() }).parse(request.params);
    const input = pluginSubmissionInput.parse(request.body);
    const digest = input.packageIntegrity.slice("sha256:".length);
    const objectKey = `plugins/${publisherId}/${input.pluginId}/${input.version}/${digest}.sandbox-plugin`;
    const submission = await dependencies.repository.createPluginSubmission(session, { ...input, publisherId }, objectKey, request.id);
    const upload = await dependencies.packageStorage.createUpload(objectKey, input.packageSize, digest);
    return { submission, upload };
  });

  app.post("/v1/publishers", async request => {
    const session = await authenticate(request, dependencies.sessions);
    requireFreshRequest(request);
    return dependencies.repository.createPublisher(session, publisherInput.parse(request.body), request.id);
  });

  app.post("/v1/publishers/:publisherId/signing-keys", async request => {
    const session = await authenticate(request, dependencies.sessions);
    requireFreshRequest(request);
    const { publisherId } = z.object({ publisherId: z.string().uuid() }).parse(request.params);
    const input = publisherKeyInput.parse(request.body);
    const key = Buffer.from(input.publicKeyDerBase64, "base64");
    const ed25519SpkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
    if (key.length !== 44 || !key.subarray(0, ed25519SpkiPrefix.length).equals(ed25519SpkiPrefix)) throw new DomainError("publisher_key_invalid", "Public key must be an Ed25519 SubjectPublicKeyInfo DER value.", 400);
    return dependencies.repository.registerPublisherSigningKey(session, publisherId, input.keyId, input.publicKeyDerBase64, request.id);
  });

  app.post("/v1/publishers/:publisherId/plugins/submissions/:reviewId/upload", async request => {
    const session = await authenticate(request, dependencies.sessions);
    requireFreshRequest(request);
    const { publisherId, reviewId } = z.object({ publisherId: z.string().uuid(), reviewId: z.string().uuid() }).parse(request.params);
    const submission = await dependencies.repository.getPluginSubmission(session, publisherId, reviewId);
    if (!submission) throw new DomainError("submission_not_found", "Plugin submission not found for this publisher.", 404);
    if (submission.status !== "draft" && submission.status !== "changes_requested") throw new DomainError("review_state_invalid", "Only draft or changes-requested submissions can receive an upload URL.", 409);
    return dependencies.packageStorage.createUpload(submission.packageObjectKey, submission.packageSize, submission.packageIntegrity.slice(7));
  });

  app.post("/v1/publishers/:publisherId/plugins/submissions/:reviewId/submit", async request => {
    const session = await authenticate(request, dependencies.sessions);
    requireFreshRequest(request);
    const { publisherId, reviewId } = z.object({ publisherId: z.string().uuid(), reviewId: z.string().uuid() }).parse(request.params);
    const submission = await dependencies.repository.getPluginSubmission(session, publisherId, reviewId);
    if (!submission) throw new DomainError("submission_not_found", "Plugin submission not found for this publisher.", 404);
    const object = await dependencies.packageStorage.inspect(submission.packageObjectKey);
    if (!object.immutable || object.size !== submission.packageSize || `sha256:${object.sha256}` !== submission.packageIntegrity) {
      throw new DomainError("package_upload_mismatch", "Uploaded package size, checksum, or immutable-storage policy does not match the submission.", 409);
    }
    const scan = await dependencies.packageScanner.scan(submission.packageObjectKey, submission.packageIntegrity, submission.publisherPublicId, submission.publisherKeyId);
    const passed = scan.passed && scan.manifestValid && scan.signatureValid && scan.integrityValid && scan.declaredContentsOnly && scan.malwareScan === "clean";
    const updated = await dependencies.repository.recordAutomatedPluginReview(session, publisherId, reviewId, scan as unknown as Record<string, unknown>, passed, scan.rejectionReasons, request.id);
    return { submission: updated, automatedReview: { passed, rejectionReasons: scan.rejectionReasons } };
  });

  app.post("/v1/publishers/:publisherId/plugins/submissions/:reviewId/publish", async request => {
    const session = await authenticate(request, dependencies.sessions);
    requireFreshRequest(request);
    const { publisherId, reviewId } = z.object({ publisherId: z.string().uuid(), reviewId: z.string().uuid() }).parse(request.params);
    return dependencies.repository.publishPluginVersion(session, publisherId, reviewId, request.id);
  });

  app.post("/v1/internal/plugin-reviews/:reviewId/decision", async request => {
    const session = await authenticate(request, dependencies.sessions);
    requireFreshRequest(request);
    requirePlatform(session, "marketplace.review");
    const { reviewId } = z.object({ reviewId: z.string().uuid() }).parse(request.params);
    const input = reviewDecisionInput.parse(request.body);
    if (input.decision !== "approved" && input.reasons.length === 0) throw new DomainError("review_reason_required", "Changes requested and rejected decisions require at least one reason.", 400);
    await dependencies.repository.decidePluginReview(session, reviewId, input.decision, input.reasons, request.id);
    return { reviewId, status: input.decision };
  });

  app.post("/v1/internal/plugin-versions/:pluginVersionId/revoke", async request => {
    const session = await authenticate(request, dependencies.sessions);
    requireFreshRequest(request);
    requirePlatform(session, "marketplace.security");
    const { pluginVersionId } = z.object({ pluginVersionId: z.string().uuid() }).parse(request.params);
    const input = revocationInput.parse(request.body);
    await dependencies.repository.revokePluginVersion(session, pluginVersionId, input.reason, input.securityNoticeUrl, request.id);
    return { pluginVersionId, revoked: true, scope: "exact_version", dataDeleted: false };
  });

  app.get("/v1/workspaces/:workspaceId/audit", async request => {
    const session = await authenticate(request, dependencies.sessions);
    const { workspaceId } = z.object({ workspaceId: z.string().uuid() }).parse(request.params);
    const { cursor, limit } = z.object({ cursor: z.string().uuid().nullable().default(null), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(request.query);
    await authorizer.require(session, workspaceId, "audit.view");
    return dependencies.repository.listAuditEvents(session, workspaceId, cursor, limit);
  });

  app.get("/v1/workspaces/:workspaceId/audit/stream",async(request,reply)=>{
    const session=await authenticate(request,dependencies.sessions);const {workspaceId}=z.object({workspaceId:z.string().uuid()}).parse(request.params);const {cursor,limit}=z.object({cursor:z.string().uuid().nullable().default(null),limit:z.coerce.number().int().min(1).max(100).default(100)}).parse(request.query);await authorizer.require(session,workspaceId,"audit.view");const page=await dependencies.repository.listAuditEvents(session,workspaceId,cursor,limit);reply.type("application/x-ndjson; charset=utf-8").header("x-next-cursor",page.nextCursor??"");return page.items.map(item=>JSON.stringify(item)).join("\n")+(page.items.length?"\n":"");
  });

  app.get("/v1/workspaces/:workspaceId/webhooks", async request => {
    const session = await authenticate(request, dependencies.sessions);
    const { workspaceId } = z.object({ workspaceId: z.string().uuid() }).parse(request.params);
    await authorizer.require(session, workspaceId, "webhooks.manage");
    return { items: await dependencies.repository.listWebhookEndpoints(session, workspaceId) };
  });

  app.post("/v1/workspaces/:workspaceId/webhooks", async request => {
    const session = await authenticate(request, dependencies.sessions);
    requireFreshRequest(request);
    const { workspaceId } = z.object({ workspaceId: z.string().uuid() }).parse(request.params);
    await authorizer.require(session, workspaceId, "webhooks.manage");
    if (!dependencies.webhookProtector || !dependencies.webhookBaseUrl) throw new DomainError("webhook_relay_unavailable", "Webhook relay encryption is not configured.", 503);
    const input = webhookEndpointInput.parse(request.body);
    const secret = randomBytes(32); const publicId = randomBytes(24).toString("base64url");
    const endpoint = await dependencies.repository.createWebhookEndpoint(session, workspaceId, input, publicId, createHash("sha256").update(secret).digest(), dependencies.webhookProtector.encrypt(secret), request.id);
    const { signingSecretCiphertext: _secretCiphertext, ...publicEndpoint } = endpoint;
    return { endpoint: { ...publicEndpoint, url: `${dependencies.webhookBaseUrl.replace(/\/$/, "")}/hooks/${publicId}` }, signingSecret: secret.toString("base64url"), secretShownOnce: true };
  });

  app.post("/v1/workspaces/:workspaceId/webhooks/:endpointId/rotate-secret", async request => {
    const session = await authenticate(request, dependencies.sessions);
    requireFreshRequest(request);
    const { workspaceId, endpointId } = z.object({ workspaceId: z.string().uuid(), endpointId: z.string().uuid() }).parse(request.params);
    await authorizer.require(session, workspaceId, "webhooks.manage");
    if (!dependencies.webhookProtector) throw new DomainError("webhook_relay_unavailable", "Webhook relay encryption is not configured.", 503);
    const secret = randomBytes(32);
    const rotated = await dependencies.repository.rotateWebhookSecret(session, workspaceId, endpointId, createHash("sha256").update(secret).digest(), dependencies.webhookProtector.encrypt(secret), request.id);
    if (!rotated) throw new DomainError("webhook_endpoint_not_found", "Webhook endpoint was not found in this workspace.", 404);
    return { signingSecret: secret.toString("base64url"), secretShownOnce: true };
  });

  await app.register(async stripeWebhook => {
    stripeWebhook.removeContentTypeParser("application/json");
    stripeWebhook.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => done(null, body));
    stripeWebhook.post("/webhook", async request => {
      if (!dependencies.billing) throw new DomainError("billing_unavailable", "Marketplace billing is unavailable.", 503);
      const signature = request.headers["stripe-signature"];
      if (typeof signature !== "string") throw new DomainError("billing_signature_required", "Stripe-Signature is required.", 400);
      let event;
      try { event = dependencies.billing.parseWebhook(request.body as Buffer, signature); }
      catch { throw new DomainError("billing_signature_invalid", "Billing webhook signature is invalid.", 400); }
      if (event) {
        const prepaidEvent = await dependencies.prepaidBilling?.applyBillingEvent(event) ?? false;
        const productEvent = prepaidEvent ? false : await dependencies.productCommerce?.applyBillingEvent(event) ?? false;
        if (!prepaidEvent&&!productEvent) await dependencies.repository.applyBillingEvent(event);
      }
      return { received: true };
    });
  }, { prefix: "/v1/billing/stripe" });

  app.get("/scim/v2/Users",{config:{rateLimit:{max:120,timeWindow:"1 minute"}}},async request=>{
    const identity=await authenticateScim(request,dependencies.repository),query=z.object({startIndex:z.coerce.number().int().min(1).default(1),count:z.coerce.number().int().min(1).max(200).default(100),filter:z.string().max(500).optional()}).parse(request.query);let userNameFilter:string|null=null;if(query.filter){const matched=/^userName eq "([^"]+)"$/i.exec(query.filter);if(!matched)throw new DomainError("scim_filter_unsupported","Only an exact userName eq filter is supported.",400);userNameFilter=matched[1];}const page=await dependencies.repository.listScimUsers(identity.organisationId,identity.provisioningAccountId,query.startIndex,query.count,userNameFilter);return{schemas:["urn:ietf:params:scim:api:messages:2.0:ListResponse"],totalResults:page.total,startIndex:query.startIndex,itemsPerPage:page.items.length,Resources:page.items.map(scimUserResource)};
  });

  app.post("/scim/v2/Users",{config:{rateLimit:{max:60,timeWindow:"1 minute"}}},async(request,reply)=>{
    const identity=await authenticateScim(request,dependencies.repository),input=scimUserInput.parse(request.body),user=await dependencies.repository.upsertScimUser(identity.organisationId,identity.provisioningAccountId,null,input);reply.status(201).header("location",`/scim/v2/Users/${user.id}`);return scimUserResource(user);
  });

  app.get("/scim/v2/Users/:userId",async request=>{
    const identity=await authenticateScim(request,dependencies.repository),{userId}=z.object({userId:z.string().uuid()}).parse(request.params),user=await dependencies.repository.getScimUser(identity.organisationId,identity.provisioningAccountId,userId);if(!user)throw new DomainError("scim_user_not_found","SCIM user was not found.",404);return scimUserResource(user);
  });

  app.put("/scim/v2/Users/:userId",async request=>{
    const identity=await authenticateScim(request,dependencies.repository),{userId}=z.object({userId:z.string().uuid()}).parse(request.params),input=scimUserInput.parse(request.body);return scimUserResource(await dependencies.repository.upsertScimUser(identity.organisationId,identity.provisioningAccountId,userId,input));
  });

  app.patch("/scim/v2/Users/:userId",async request=>{
    const identity=await authenticateScim(request,dependencies.repository),{userId}=z.object({userId:z.string().uuid()}).parse(request.params),current=await dependencies.repository.getScimUser(identity.organisationId,identity.provisioningAccountId,userId);if(!current)throw new DomainError("scim_user_not_found","SCIM user was not found.",404);const patch=scimPatchInput.parse(request.body),next={externalId:current.externalId,userName:current.userName,displayName:current.displayName,active:current.active,role:current.role,workspaceIds:current.workspaceIds};for(const operation of patch.Operations){if(!operation.path||!(operation.path in next))throw new DomainError("scim_patch_unsupported","SCIM patch path is unsupported.",400);const key=operation.path as keyof typeof next;if(operation.op==="remove"){if(key!=="active")throw new DomainError("scim_patch_unsupported","Only active can be removed.",400);next.active=false;}else (next as Record<string,unknown>)[key]=operation.value;}const input=scimManagedUserInput.parse(next);return scimUserResource(await dependencies.repository.upsertScimUser(identity.organisationId,identity.provisioningAccountId,userId,input));
  });

  app.delete("/scim/v2/Users/:userId",async(request,reply)=>{
    const identity=await authenticateScim(request,dependencies.repository),{userId}=z.object({userId:z.string().uuid()}).parse(request.params),current=await dependencies.repository.getScimUser(identity.organisationId,identity.provisioningAccountId,userId);if(!current)throw new DomainError("scim_user_not_found","SCIM user was not found.",404);await dependencies.repository.upsertScimUser(identity.organisationId,identity.provisioningAccountId,userId,{externalId:current.externalId,userName:current.userName,displayName:current.displayName,active:false,role:current.role,workspaceIds:current.workspaceIds});return reply.status(204).send();
  });

  await app.register(async relay => {
    relay.removeContentTypeParser("application/json");
    relay.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => done(null, body));
    relay.route({ method: ["GET", "POST", "PUT", "PATCH", "DELETE"], url: "/:publicId", handler: async request => {
      if (!dependencies.webhookProtector) throw new DomainError("webhook_relay_unavailable", "Webhook relay encryption is not configured.", 503);
      const { publicId } = z.object({ publicId: z.string().regex(/^[A-Za-z0-9_-]{32}$/) }).parse(request.params);
      const endpoint = await dependencies.repository.getWebhookEndpointByPublicId(publicId);
      if (!endpoint || endpoint.disabled) throw new DomainError("webhook_endpoint_not_found", "Webhook endpoint is unavailable.", 404);
      if (!endpoint.allowedMethods.includes(request.method.toUpperCase())) throw new DomainError("webhook_method_not_allowed", `This webhook accepts ${endpoint.allowedMethods.join(", ")}.`, 405);
      const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      if (rawBody.length > endpoint.maximumRequestBytes) throw new DomainError("webhook_payload_too_large", "Webhook request exceeds the endpoint size limit.", 413);
      const timestamp = singleHeader(request, "x-sandbox-webhook-timestamp"); const nonce = singleHeader(request, "x-sandbox-webhook-nonce"); const signature = singleHeader(request, "x-sandbox-webhook-signature");
      const parsedTime = Date.parse(timestamp);
      if (!Number.isFinite(parsedTime) || Math.abs(Date.now()-parsedTime)>5*60_000) throw new DomainError("webhook_request_stale", "Webhook timestamp is outside the five-minute replay window.", 400);
      const secret = dependencies.webhookProtector.decrypt(endpoint.signingSecretCiphertext);
      if (!verifyWebhookSignature(secret, timestamp, nonce, rawBody, signature)) throw new DomainError("webhook_signature_invalid", "Webhook signature is invalid.", 401);
      let payload: unknown = null;
      if (rawBody.length) { try { payload = JSON.parse(rawBody.toString("utf8")); } catch { throw new DomainError("webhook_json_invalid", "Webhook body must be valid JSON.", 400); } }
      const schemaError = validateWebhookSchema(payload, endpoint.schema);
      if (schemaError) throw new DomainError("webhook_schema_invalid", schemaError, 400);
      const redacted = redactWebhookPayload(payload, endpoint.redactedFields);
      const receivedAt = new Date(); const deliveryId = randomUUID(); const idempotencyKey = typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : createHash("sha256").update(endpoint.id).update(nonce).digest("hex");
      const envelope = Buffer.from(JSON.stringify({ method: request.method, contentType: request.headers["content-type"] ?? null, payload: redacted }), "utf8");
      const queued = await dependencies.repository.enqueueWebhookDelivery(endpoint, deliveryId, nonce, idempotencyKey, dependencies.webhookProtector.encrypt(envelope), `sha256:${createHash("sha256").update(envelope).digest("hex")}`, receivedAt);
      return { deliveryId, status: queued.status, expiresAt: queued.expiresAt, execution: "waiting_for_local_runner" };
    }});
  }, { prefix: "/hooks" });

  return app;
}

async function authenticate(request: FastifyRequest, verifier: SessionVerifier): Promise<AuthenticatedSession> {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) throw new DomainError("authentication_required", "A bearer access token is required.", 401);
  return verifier.verify(authorization.slice("Bearer ".length));
}

async function authenticateOptional(request: FastifyRequest, verifier: SessionVerifier): Promise<AuthenticatedSession | null> {
  const authorization = request.headers.authorization;
  if (!authorization) return null;
  if (!authorization.startsWith("Bearer ")) throw new DomainError("authentication_required", "Bearer authentication is malformed.", 401);
  return verifier.verify(authorization.slice("Bearer ".length));
}

async function requireOrganisationSecurity(session:AuthenticatedSession,organisationId:string,repository:ControlPlaneRepository):Promise<void>{
  const organisation=(await repository.listAccountOrganisations(session)).find(item=>item.id===organisationId);
  if(!organisation)throw new DomainError("organisation_not_found","Organisation was not found or is not accessible.",404);
  if(!hasPermission(organisation.role,"organisation.security.manage"))throw new DomainError("permission_denied","Organisation owner security permission is required.",403);
}

async function authenticateScim(request:FastifyRequest,repository:ControlPlaneRepository){
  const authorization=request.headers.authorization;if(!authorization?.startsWith("Bearer "))throw new DomainError("scim_authentication_required","A SCIM bearer token is required.",401);const token=authorization.slice(7);if(!/^sbx_scim_[a-f0-9]{12}\.[A-Za-z0-9_-]{40,60}$/.test(token))throw new DomainError("scim_authentication_invalid","SCIM bearer token is invalid.",401);const identity=await repository.authenticateScimToken(createHash("sha256").update(token,"utf8").digest());if(!identity)throw new DomainError("scim_authentication_invalid","SCIM bearer token is expired, revoked, or invalid.",401);return identity;
}

function scimUserResource(user:ScimManagedUserRecord){return{schemas:["urn:ietf:params:scim:schemas:core:2.0:User","urn:sandbox:params:scim:schemas:extension:1.0:User"],id:user.id,externalId:user.externalId,userName:user.userName,displayName:user.displayName,active:user.active,meta:{resourceType:"User",created:user.createdAt,lastModified:user.updatedAt,location:`/scim/v2/Users/${user.id}`},"urn:sandbox:params:scim:schemas:extension:1.0:User":{role:user.role,workspaceIds:user.workspaceIds}};}

function requireFreshRequest(request: FastifyRequest): void {
  const value = request.headers["x-sandbox-request-time"];
  if (typeof value !== "string") throw new DomainError("request_freshness_required", "x-sandbox-request-time is required for this operation.", 400);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > 5 * 60 * 1_000) {
    throw new DomainError("stale_request", "The request timestamp is outside the five-minute freshness window.", 400);
  }
}

function requirePlatform(session: AuthenticatedSession, permission: string): void {
  if (!session.platformPermissions.includes(permission)) throw new DomainError("platform_permission_denied", `Platform permission '${permission}' is required.`, 403);
}

function requireHumanPrincipal(session:AuthenticatedSession):void {
  if((session.principalType??"user")!=="user")throw new DomainError("human_principal_required","This account-security operation requires an interactive human session.",403);
}

function requireRunnerPairingPrincipal(session:AuthenticatedSession):void {
  if((session.principalType??"user")==="user")return;
  if(session.principalType==="personal_access_token"&&session.credentialScopes?.includes("runners.manage"))return;
  throw new DomainError("runner_pairing_principal_required","Runner pairing requires an interactive session or a workspace-scoped runner pairing token.",403);
}

function requireRecentStepUp(session:AuthenticatedSession):void {
  if(!session.authenticationMethods.some(method=>method==="mfa"||method==="webauthn"||method==="passkey")||Math.abs(Date.now()-session.issuedAt.getTime())>15*60_000)throw new DomainError("step_up_required","Support access approval requires authentication within the last 15 minutes using a passkey or multi-factor method.",403);
}

function runnerActionPermission(action:RunnerCommand["action"]):Permission {
  if(action==="request_diagnostics")return "runners.manage";
  if(["cancel_execution","pause_workflow","resume_workflow"].includes(action))return "workflows.pause";
  return "workflows.run";
}

function publicKeyPem(derBase64: string): string {
  const lines = derBase64.match(/.{1,64}/g)?.join("\n") ?? derBase64;
  return `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----`;
}

function validateEd25519PublicKey(derBase64: string): void {
  const key = Buffer.from(derBase64, "base64");
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  if (key.length !== 44 || !key.subarray(0, prefix.length).equals(prefix)) throw new DomainError("runner_key_invalid", "Runner public key must be an Ed25519 SubjectPublicKeyInfo DER value.", 400);
}

async function authenticateRunnerDevice(request: FastifyRequest, repository: ControlPlaneRepository) {
  const runnerId = singleHeader(request, "x-sandbox-runner-id");
  const keyId = singleHeader(request, "x-sandbox-key-id");
  const requestTime = singleHeader(request, "x-sandbox-request-time");
  const nonce = singleHeader(request, "x-sandbox-request-nonce");
  const signatureBase64 = singleHeader(request, "x-sandbox-signature");
  const timestamp = Date.parse(requestTime);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > 5 * 60_000) throw new DomainError("stale_runner_request", "Runner request timestamp is outside the five-minute freshness window.", 400);
  return repository.authenticateRunnerRequest({ runnerId, keyId, requestTime, nonce, signatureBase64, method: request.method.toUpperCase(), path: request.url, body: request.body ?? null });
}

function singleHeader(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  if (typeof value !== "string" || !value || value.length > 512) throw new DomainError("required_header_missing", `Required authentication header '${name}' is missing or invalid.`, 401);
  return value;
}

function assertSafeTriggerEvent(payload: unknown, checkpoint: unknown): void {
  const forbiddenKey = /^(?:authorization|token|access_?token|refresh_?token|client_?secret|password|secret|webhook_?secret|local_?path|absolute_?path)$/i;
  const visit = (value: unknown, depth: number): void => {
    if (depth > 20) throw new DomainError("trigger_event_payload_invalid", "Trigger event payload nesting is too deep.", 400);
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (forbiddenKey.test(key)) throw new DomainError("trigger_event_sensitive_data", "Trigger events cannot contain credentials, secrets, or local filesystem paths.", 400);
      visit(item, depth + 1);
    }
  };
  visit(payload, 0);
  visit(checkpoint, 0);
}

function validateWebhookSchema(value: unknown, schema: Record<string, unknown> | null): string | null {
  if (!schema) return null;
  if (schema.type === "object" && (!value || typeof value !== "object" || Array.isArray(value))) return "Webhook payload must be an object.";
  const required = Array.isArray(schema.required) ? schema.required.filter(item => typeof item === "string") : [];
  if (required.length && value && typeof value === "object") for (const key of required) if (!(key in value)) return `Webhook payload is missing required field '${key}'.`;
  return null;
}

export function correlationId(): string {
  return randomUUID();
}
