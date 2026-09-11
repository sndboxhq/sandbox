import type { Invitation, WorkspaceActivitySummary } from "@sandbox/contracts";
export type { Invitation, WorkspaceActivitySummary } from "@sandbox/contracts";

export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type QueryValue = string | number | boolean | null | undefined;

export interface ApiErrorEnvelope {
  error: { code: string; message: string; details?: unknown };
  correlationId: string;
}

export interface ApiRateLimit {
  limit: number | null;
  remaining: number | null;
  resetSeconds: number | null;
}

export interface ApiResult<T> {
  data: T;
  statusCode: number;
  correlationId: string;
  idempotencyReplayed: boolean;
  rateLimit: ApiRateLimit;
}

export interface ApiRequest<T> {
  method?: ApiMethod;
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  idempotencyKey?: string | false;
  parse?: (value: unknown) => T;
  signal?: AbortSignal;
}

export interface SandboxApiClientOptions {
  baseUrl: string;
  accessToken?: string | (() => string | null | Promise<string | null>);
  fetch?: typeof globalThis.fetch;
  maximumRetries?: number;
  correlationId?: () => string;
  idempotencyKey?: () => string;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export class SandboxApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly correlationId: string,
    public readonly details: unknown,
    public readonly retryAfterSeconds: number | null
  ) { super(message); this.name = "SandboxApiError"; }
}

export class SandboxApiCompatibilityError extends Error {
  constructor(public readonly correlationId: string, options?: ErrorOptions) {
    super("The sndbox API response did not match the client contract.", options);
    this.name = "SandboxApiCompatibilityError";
  }
}

export interface MarketplaceListing {
  pluginId: string; name: string; summary: string;
  publisher: { publicId: string; publicName: string; verified: boolean };
  version: string; packageIntegrity: string; categories: string[]; keywords: string[];
  pricing: Record<string, unknown>; licence: string; documentationUrl: string;
  privacyPolicyUrl: string | null; supportUrl: string; screenshots: unknown[];
  securityNotices: unknown[]; capabilities: unknown[];
  networkDomains: Array<{ domain?: string; methods?: string[] }>;
  nodes: Array<{ displayName?: string; description?: string }>;
  minimumHostVersion: string; maximumHostVersion: string | null;
  installCount: number; ratingAverage: number | null; ratingCount: number;
  updatedAt: string; visibility: string;
}

export interface MarketplaceListQuery {
  search?: string;
  category?: string;
  pricing?: "all" | "free" | "paid";
  verifiedOnly?: boolean;
  visibility?: "public" | "workspace" | "all";
  workspaceId?: string;
  teamApprovedOnly?: boolean;
  sort?: "recent" | "installs" | "rating";
  cursor?: string;
  limit?: number;
  hostVersion?: string;
}

export interface ProductPlan {
  id:string;displayName:string;audience:"individual"|"team"|"enterprise";description:string;
  price:{currency:string;unitAmount:number;interval:"month"|"year"}|null;
  includedUsage:Record<string,number>;entitlements:Record<string,boolean|number|string>;
  seatAllowance:number|null;offlineGraceDays:number;localExecutionUnmetered:true;
  overagePolicy:"blocked"|"spending_limit"|"contract";
}
export interface ProductAccountSummary {
  subscriptions:Array<{id:string;ownerType:"personal"|"organisation";ownerId:string;planId:string;planName:string;status:"trial"|"active"|"past_due"|"cancelled"|"expired";currentPeriodEndsAt:string|null;cancelAtPeriodEnd:boolean}>;
  licences:Array<{id:string;ownerType:"personal"|"organisation";ownerId:string;planId:string;status:"active"|"past_due"|"expired"|"revoked";seatAllowance:number|null;seatsAssigned:number;devices:number;offlineGraceUntil:string}>;
}
export interface ProductCheckoutInput { ownerType:"personal"|"organisation";ownerId:string;planId:string }
export interface PrepaidWalletSummary {
  currency:"usd";balanceMicros:number;status:"funded"|"low"|"empty";
  rates:{currency:"usd";minimumComputeSeconds:number;hostedRunnerMicrosPerMinute:number;managedBrowserMicrosPerMinute:number;networkEgressMicrosPerGib:number;artifactStorageMicrosPerGibMonth:number};
  recentEntries:Array<{id:string;kind:"top_up"|"usage"|"refund"|"adjustment";amountMicros:number;balanceAfterMicros:number;description:string;createdAt:string}>;
}
export interface ReferralSummary {
  code:string;shareUrl:string;
  policy:{claimWindowDays:number;qualifyingTopUpCents:number;rewardMicros:number;maximumRewardsPerRollingYear:number};
  stats:{invited:number;pending:number;rewarded:number;earnedMicros:number};
  claim:{status:"pending"|"rewarded"|"reversed"|"ineligible";claimedAt:string;rewardedAt:string|null;reversedAt:string|null}|null;
  referrals:Array<{id:string;status:"pending"|"rewarded"|"reversed"|"ineligible";claimedAt:string;rewardedAt:string|null;reversedAt:string|null}>;
}

export type BuiltInRole="owner"|"administrator"|"developer"|"operator"|"viewer";
export interface AccountWorkspace { id:string;organisationId:string;name:string;slug:string;role:BuiltInRole;createdAt:string }
export interface AccountOrganisation { id:string;name:string;slug:string;role:BuiltInRole;createdAt:string;workspaces:AccountWorkspace[] }
export interface AccountProfile {accountId:string;email:string;displayName:string;sessionId:string}
export interface AccountSession {id:string;deviceName:string;createdAt:string;lastSeenAt:string;expiresAt:string;current:boolean}
export interface WorkspaceMember {accountId:string;email:string;displayName:string;role:BuiltInRole;joinedAt:string}
export interface WorkspaceInvitationResult {
  invitation: Invitation;
  delivery: { status: "sent" } | { status: "manual"; invitationUrl: string };
}
export interface WorkspaceEnvironment {environmentId:string;environment:"development"|"staging"|"production"}
export type UsageMeter="hosted_runner_seconds"|"managed_browser_seconds"|"network_egress_bytes"|"artifact_storage_byte_seconds";
export type UsageUnit="seconds"|"bytes"|"byte_seconds";
export interface WorkspaceUsageSummary {
  workspaceId:string;periodStartedAt:string;periodEndedAt:string;reconciliation:"matched";
  meters:Array<{meter:UsageMeter;unit:UsageUnit;quantity:number}>;
  daily:Array<{date:string;quantities:Record<UsageMeter,number>}>;
}
export interface OrganisationRole {id:string;organisationId:string;key:string;displayName:string;builtIn:boolean;permissions:string[]}
export interface SsoConnection {id:string;organisationId:string;connectionType:"oidc"|"saml";displayName:string;issuerUrl:string;clientIdentifier:string;verifiedDomains:string[];enabled:boolean;createdAt:string;updatedAt:string}
export interface SsoConnectionInput {connectionType:"oidc"|"saml";displayName:string;issuerUrl:string;clientIdentifier:string;verifiedDomains?:string[];enabled?:boolean}
export interface ScimToken {id:string;organisationId:string;name:string;prefix:string;createdAt:string;expiresAt:string;lastUsedAt:string|null;revokedAt:string|null}
export interface SyncedWorkflow { workflowId:string;name:string;currentDraftRevisionId:string|null;currentPublishedRevisionId:string|null;createdAt:string;updatedAt:string|null }
export interface EncryptedWorkflowRevision {
  workflowId:string;revisionId:string;parentRevisionId:string|null;schemaVersion:number;contentHash:string;editorDeviceId:string;updatedAt:string;
  syncState:"local"|"synced"|"conflicted"|"deleted";encryption:{algorithm:"aes-256-gcm";keyVersion:number};encryptedPayload:string;payloadKeyEnvelope:string;
  searchableMetadata:{name:string;folderId:string|null;requiredPlugins:Array<{pluginId:string;version:string;packageIntegrity:string}>;permissionRequirements:string[];runnerPolicy:Record<string,unknown>};
}
export interface WorkflowApproval {approvalId:string;workflowId:string;revisionId:string;status:"pending"|"approved"|"rejected"|"expired";requiredApprovals:number;approvalCount:number;createdAt:string}
export interface RunnerPool {id:string;workspaceId:string;environmentId:string;name:string;strategy:"least_loaded"|"round_robin"|"priority_failover";region:string|null;requiredTags:string[];maximumConcurrency:number;status:"active"|"paused"|"draining";memberCount:number;createdAt:string;updatedAt:string}
export interface RunnerPoolInput {environmentId:string;name:string;strategy:"least_loaded"|"round_robin"|"priority_failover";region?:string|null;requiredTags?:string[];maximumConcurrency:number;status?:"active"|"paused"|"draining";members?:Array<{runnerId:string;priority?:number}>}
export interface PublicRun {runId:string;workspaceId:string;environmentId:string;deploymentId:string;workflowId:string;workflowRevisionId:string;status:string;outcomeCertainty:"certain"|"uncertain";assignedRunnerId:string|null;trigger:string;queuedAt:string;startedAt:string|null;completedAt:string|null;timeoutAt:string;evidence:Array<{checkpointId:string;nodeId:string;nodeVersion:number;attempt:number;status:"completed"|"failed";inputHash:string;outputReference:string|null;sideEffect:string;completedAt:string}>}
export interface StartWorkflowRunInput {workspaceId:string;deploymentId:string;encryptedPayloadReference:string;triggerReference?:string|null;timeoutSeconds?:number}

export interface PersonalAccessTokenInput {
  name: string;
  scopes: string[];
  organisationId: string;
  workspaceIds: string[];
  environmentIds?: string[];
  expiresInDays?: number;
}

export interface ServiceAccountInput {
  name: string;
  description?: string;
  roleId: string;
  environmentIds?: string[];
  expiryPolicyDays?: number;
}

export interface TokenSummary {
  id: string; name: string; prefix: string; kind: "personal" | "service_account"; scopes: string[];
  organisationId: string; workspaceIds: string[]; environmentIds: string[]; createdAt: string; expiresAt: string;
  lastUsedAt: string | null; revokedAt: string | null;
}

export interface IssuedCredential extends Omit<TokenSummary,"kind"|"lastUsedAt"|"revokedAt"> { token: string }
export interface ServiceAccount {
  id: string; organisationId: string; workspaceId: string | null; name: string; description: string;
  ownerAccountIds: string[]; roleId: string; environmentIds: string[]; expiryPolicyDays: number;
  status: "active" | "suspended" | "revoked"; createdAt: string; lastUsedAt: string | null;
}

export class SandboxApiClient {
  private readonly baseUrl: URL;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly maximumRetries: number;
  private readonly newCorrelationId: () => string;
  private readonly newIdempotencyKey: () => string;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly options: SandboxApiClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    if (this.baseUrl.username || this.baseUrl.password) throw new Error("sndbox API baseUrl must not contain credentials.");
    if (this.baseUrl.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(this.baseUrl.hostname)) throw new Error("sndbox API baseUrl must use HTTPS except on localhost.");
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    if (!this.fetchImplementation) throw new Error("A Fetch API implementation is required.");
    this.maximumRetries = options.maximumRetries ?? 2;
    if (!Number.isInteger(this.maximumRetries) || this.maximumRetries < 0 || this.maximumRetries > 5) throw new Error("maximumRetries must be between 0 and 5.");
    this.newCorrelationId = options.correlationId ?? randomIdentifier;
    this.newIdempotencyKey = options.idempotencyKey ?? (() => `sdk-${randomIdentifier()}`);
    this.sleep = options.sleep ?? abortableSleep;
  }

  health(signal?: AbortSignal): Promise<ApiResult<{ status: string; service: string; execution: string }>> {
    return this.request({ path: "/health", signal });
  }

  listMarketplace<T = unknown>(query: MarketplaceListQuery = {}, parse?: (value: unknown) => T): Promise<ApiResult<T>> {
    return this.request({ path: "/v1/marketplace/plugins", query: query as Record<string, QueryValue>, parse });
  }

  listProductPlans<T = {items:ProductPlan[]}>(parse?: (value:unknown)=>T):Promise<ApiResult<T>> {
    return this.request({path:"/v1/product-plans",parse});
  }

  getProductAccount<T = ProductAccountSummary>(parse?: (value:unknown)=>T):Promise<ApiResult<T>> {
    return this.request({path:"/v1/account/commerce",parse});
  }

  createProductCheckout<T = {checkout:{checkoutId:string;url:string;expiresAt:string}}>(input:ProductCheckoutInput,parse?: (value:unknown)=>T):Promise<ApiResult<T>> {
    return this.request({method:"POST",path:"/v1/product-checkout",body:input,parse});
  }

  getAccountWallet<T = PrepaidWalletSummary>(parse?: (value:unknown)=>T):Promise<ApiResult<T>> {
    return this.request({path:"/v1/account/wallet",parse});
  }

  createWalletTopUp<T = {checkout:{checkoutId:string;url:string;expiresAt:string}}>(amountCents:number,parse?: (value:unknown)=>T):Promise<ApiResult<T>> {
    return this.request({method:"POST",path:"/v1/account/wallet/top-ups",body:{amountCents},parse});
  }

  getAccountReferrals<T = ReferralSummary>(parse?: (value:unknown)=>T):Promise<ApiResult<T>> {
    return this.request({path:"/v1/account/referrals",parse});
  }

  claimReferral<T = {claimed:true;status:"pending"}>(code:string,parse?: (value:unknown)=>T):Promise<ApiResult<T>> {
    return this.request({method:"POST",path:"/v1/account/referrals/claim",body:{code},parse});
  }

  listAccountOrganisations<T = {items:AccountOrganisation[]}>(parse?: (value:unknown)=>T):Promise<ApiResult<T>> {
    return this.request({path:"/v1/account/organisations",parse});
  }

  getAccountProfile<T = AccountProfile>(parse?: (value:unknown)=>T):Promise<ApiResult<T>> {
    return this.request({path:"/v1/account/profile",parse});
  }

  listAccountSessions<T = {items:AccountSession[]}>(parse?: (value:unknown)=>T):Promise<ApiResult<T>> {
    return this.request({path:"/v1/account/sessions",parse});
  }

  revokeAccountSession<T = {revoked:true}>(sessionId:string,parse?: (value:unknown)=>T):Promise<ApiResult<T>> {
    return this.request({method:"POST",path:`/v1/account/sessions/${encodeURIComponent(sessionId)}/revoke`,body:{},parse});
  }

  createOrganisation<T = {organisation:{id:string;name:string;slug:string;createdAt:string};workspace:{id:string;organisationId:string;name:string;slug:string;createdAt:string}}>(input:{name:string;slug:string},parse?: (value:unknown)=>T):Promise<ApiResult<T>> {
    return this.request({method:"POST",path:"/v1/organisations",body:input,parse});
  }

  listOrganisationRoles<T = {items:OrganisationRole[]}>(organisationId:string,parse?: (value:unknown)=>T):Promise<ApiResult<T>> {return this.request({path:`/v1/organisations/${encodeURIComponent(organisationId)}/roles`,parse});}
  createOrganisationRole<T = {role:OrganisationRole}>(organisationId:string,input:{key:string;displayName:string;permissions:string[]},parse?: (value:unknown)=>T):Promise<ApiResult<T>> {return this.request({method:"POST",path:`/v1/organisations/${encodeURIComponent(organisationId)}/roles`,body:input,parse});}
  updateOrganisationRole<T = {role:OrganisationRole}>(organisationId:string,roleId:string,input:{displayName:string;permissions:string[]},parse?: (value:unknown)=>T):Promise<ApiResult<T>> {return this.request({method:"PUT",path:`/v1/organisations/${encodeURIComponent(organisationId)}/roles/${encodeURIComponent(roleId)}`,body:input,parse});}
  deleteOrganisationRole<T = {deleted:true}>(organisationId:string,roleId:string,parse?: (value:unknown)=>T):Promise<ApiResult<T>> {return this.request({method:"DELETE",path:`/v1/organisations/${encodeURIComponent(organisationId)}/roles/${encodeURIComponent(roleId)}`,body:{},parse});}
  listSsoConnections<T = {items:SsoConnection[]}>(organisationId:string,parse?: (value:unknown)=>T):Promise<ApiResult<T>> {return this.request({path:`/v1/organisations/${encodeURIComponent(organisationId)}/sso-connections`,parse});}
  createSsoConnection<T = {connection:SsoConnection}>(organisationId:string,input:SsoConnectionInput,parse?: (value:unknown)=>T):Promise<ApiResult<T>> {return this.request({method:"POST",path:`/v1/organisations/${encodeURIComponent(organisationId)}/sso-connections`,body:input,parse});}
  updateSsoConnection<T = {connection:SsoConnection}>(organisationId:string,connectionId:string,input:SsoConnectionInput,parse?: (value:unknown)=>T):Promise<ApiResult<T>> {return this.request({method:"PUT",path:`/v1/organisations/${encodeURIComponent(organisationId)}/sso-connections/${encodeURIComponent(connectionId)}`,body:input,parse});}
  deleteSsoConnection<T = {deleted:true}>(organisationId:string,connectionId:string,parse?: (value:unknown)=>T):Promise<ApiResult<T>> {return this.request({method:"DELETE",path:`/v1/organisations/${encodeURIComponent(organisationId)}/sso-connections/${encodeURIComponent(connectionId)}`,body:{},parse});}
  listScimTokens<T = {items:ScimToken[]}>(organisationId:string,parse?: (value:unknown)=>T):Promise<ApiResult<T>> {return this.request({path:`/v1/organisations/${encodeURIComponent(organisationId)}/scim-tokens`,parse});}
  createScimToken<T = {credential:ScimToken&{token:string}}>(organisationId:string,input:{name:string;expiresInDays?:number},parse?: (value:unknown)=>T):Promise<ApiResult<T>> {return this.request({method:"POST",path:`/v1/organisations/${encodeURIComponent(organisationId)}/scim-tokens`,body:input,parse});}
  revokeScimToken<T = {revoked:true}>(organisationId:string,tokenId:string,parse?: (value:unknown)=>T):Promise<ApiResult<T>> {return this.request({method:"DELETE",path:`/v1/organisations/${encodeURIComponent(organisationId)}/scim-tokens/${encodeURIComponent(tokenId)}`,body:{},parse});}

  listSyncedWorkflows<T = {items:SyncedWorkflow[]}>(workspaceId:string,parse?: (value:unknown)=>T):Promise<ApiResult<T>> {
    return this.request({path:`/v1/workspaces/${encodeURIComponent(workspaceId)}/sync/workflows`,parse});
  }

  enableWorkflowSync<T = {workflowId:string;name:string;ownerType:"workspace";ownerId:string}>(workspaceId:string,input:{workflowId:string;name:string},parse?: (value:unknown)=>T):Promise<ApiResult<T>> {
    return this.request({method:"POST",path:`/v1/workspaces/${encodeURIComponent(workspaceId)}/sync/workflows`,body:input,parse});
  }

  appendWorkflowRevision<T = {revision:EncryptedWorkflowRevision;conflictRevisionId:string|null}>(workspaceId:string,revision:EncryptedWorkflowRevision,parse?: (value:unknown)=>T):Promise<ApiResult<T>> {
    return this.request({method:"POST",path:`/v1/workspaces/${encodeURIComponent(workspaceId)}/sync/revisions`,body:revision,parse});
  }

  listWorkflowRevisions<T = {items:EncryptedWorkflowRevision[];nextCursor:string|null}>(workspaceId:string,workflowId:string,query:{cursor?:string;limit?:number}={},parse?: (value:unknown)=>T):Promise<ApiResult<T>> {
    return this.request({path:`/v1/workspaces/${encodeURIComponent(workspaceId)}/sync/workflows/${encodeURIComponent(workflowId)}/revisions`,query,parse});
  }

  listWorkflowApprovals<T = {items:WorkflowApproval[]}>(workspaceId:string,status:"all"|"pending"|"approved"|"rejected"="pending",parse?: (value:unknown)=>T):Promise<ApiResult<T>> {
    return this.request({path:`/v1/workspaces/${encodeURIComponent(workspaceId)}/workflow-approvals`,query:{status},parse});
  }

  requestWorkflowApproval<T = {approval:WorkflowApproval}>(workspaceId:string,workflowId:string,revisionId:string,parse?: (value:unknown)=>T):Promise<ApiResult<T>> {
    return this.request({method:"POST",path:`/v1/workspaces/${encodeURIComponent(workspaceId)}/workflows/${encodeURIComponent(workflowId)}/revisions/${encodeURIComponent(revisionId)}/request-approval`,body:{},parse});
  }

  decideWorkflowApproval<T = {approval:WorkflowApproval}>(workspaceId:string,approvalId:string,decision:"approved"|"rejected",reason:string|null=null,parse?: (value:unknown)=>T):Promise<ApiResult<T>> {
    return this.request({method:"POST",path:`/v1/workspaces/${encodeURIComponent(workspaceId)}/workflow-approvals/${encodeURIComponent(approvalId)}/decision`,body:{decision,reason},parse});
  }

  publishWorkflow<T = {workflowId:string;publishedRevisionId:string;previousPublishedRevisionId:string|null}>(workspaceId:string,workflowId:string,revisionId:string,changeSummary:string,parse?: (value:unknown)=>T):Promise<ApiResult<T>> {
    return this.request({method:"POST",path:`/v1/workspaces/${encodeURIComponent(workspaceId)}/workflows/${encodeURIComponent(workflowId)}/revisions/${encodeURIComponent(revisionId)}/publish`,body:{changeSummary},parse});
  }

  listDeployments<T = {items:unknown[]}>(workspaceId:string,parse?: (value:unknown)=>T):Promise<ApiResult<T>> {
    return this.request({path:`/v1/workspaces/${encodeURIComponent(workspaceId)}/deployments`,parse});
  }

  createDeployment<T = {deployment:Record<string,unknown>}>(workspaceId:string,input:unknown,parse?: (value:unknown)=>T):Promise<ApiResult<T>> {
    return this.request({method:"POST",path:`/v1/workspaces/${encodeURIComponent(workspaceId)}/deployments`,body:input,parse});
  }

  transitionDeployment<T = {deployment:{deploymentId:string;status:string}}>(workspaceId:string,deploymentId:string,input:{status:"active"|"paused"|"rolled_back";reason:string},parse?: (value:unknown)=>T):Promise<ApiResult<T>> {
    return this.request({method:"POST",path:`/v1/workspaces/${encodeURIComponent(workspaceId)}/deployments/${encodeURIComponent(deploymentId)}/transition`,body:input,parse});
  }

  startWorkflowRun<T = {run:PublicRun;idempotencyReplayed:boolean}>(workflowId:string,input:StartWorkflowRunInput,parse?: (value:unknown)=>T):Promise<ApiResult<T>> {
    return this.request({method:"POST",path:`/v1/workflows/${encodeURIComponent(workflowId)}/runs`,body:input,parse});
  }

  getWorkflowRun<T = {run:PublicRun}>(runId:string,parse?: (value:unknown)=>T):Promise<ApiResult<T>> {
    return this.request({path:`/v1/runs/${encodeURIComponent(runId)}`,parse});
  }

  listWorkspaceMembers<T = {items:WorkspaceMember[]}>(workspaceId:string,parse?: (value:unknown)=>T):Promise<ApiResult<T>> {
    return this.request({path:`/v1/workspaces/${encodeURIComponent(workspaceId)}/members`,parse});
  }

  createWorkspaceInvitation<T = WorkspaceInvitationResult>(workspaceId:string,input:{email:string;role:BuiltInRole;workspaceIds:string[];expiresInHours?:number},parse?: (value:unknown)=>T):Promise<ApiResult<T>> {
    return this.request({method:"POST",path:`/v1/workspaces/${encodeURIComponent(workspaceId)}/invitations`,body:input,parse});
  }

  listWorkspaceRunners<T = {items:unknown[]}>(workspaceId:string,parse?: (value:unknown)=>T):Promise<ApiResult<T>> {
    return this.request({path:`/v1/workspaces/${encodeURIComponent(workspaceId)}/runners`,parse});
  }

  listWorkspaceEnvironments<T = {items:WorkspaceEnvironment[]}>(workspaceId:string,parse?: (value:unknown)=>T):Promise<ApiResult<T>> {
    return this.request({path:`/v1/workspaces/${encodeURIComponent(workspaceId)}/environments`,parse});
  }

  listWorkspaceConnections<T = {items:unknown[]}>(workspaceId:string,environmentId?:string,parse?: (value:unknown)=>T):Promise<ApiResult<T>> {
    return this.request({path:`/v1/workspaces/${encodeURIComponent(workspaceId)}/connections`,query:{environmentId},parse});
  }

  getWorkspaceGovernance<T = {policies:Record<string,unknown>}>(workspaceId:string,parse?: (value:unknown)=>T):Promise<ApiResult<T>> {
    return this.request({path:`/v1/workspaces/${encodeURIComponent(workspaceId)}/governance`,parse});
  }

  listWorkspaceAudit<T = {items:unknown[];nextCursor:string|null}>(workspaceId:string,limit=100,parse?: (value:unknown)=>T):Promise<ApiResult<T>> {
    return this.request({path:`/v1/workspaces/${encodeURIComponent(workspaceId)}/audit`,query:{limit},parse});
  }

  getWorkspaceActivity<T = WorkspaceActivitySummary>(workspaceId:string,limit=30,parse?: (value:unknown)=>T):Promise<ApiResult<T>> {
    return this.request({path:`/v1/workspaces/${encodeURIComponent(workspaceId)}/activity`,query:{limit},parse});
  }

  getWorkspaceUsage<T = WorkspaceUsageSummary>(workspaceId:string,days=30,parse?: (value:unknown)=>T):Promise<ApiResult<T>> {
    return this.request({path:`/v1/workspaces/${encodeURIComponent(workspaceId)}/usage`,query:{days},parse});
  }

  validateDeployment<T = {validation:Record<string,unknown>}>(workspaceId:string,input:unknown,parse?: (value:unknown)=>T):Promise<ApiResult<T>> {
    return this.request({method:"POST",path:`/v1/workspaces/${encodeURIComponent(workspaceId)}/deployments/validate`,body:input,parse});
  }

  listRunnerPools<T = {items:RunnerPool[]}>(workspaceId:string,parse?: (value:unknown)=>T):Promise<ApiResult<T>> {
    return this.request({path:`/v1/workspaces/${encodeURIComponent(workspaceId)}/runner-pools`,parse});
  }

  createRunnerPool<T = {pool:RunnerPool}>(workspaceId:string,input:RunnerPoolInput,parse?: (value:unknown)=>T):Promise<ApiResult<T>> {
    return this.request({method:"POST",path:`/v1/workspaces/${encodeURIComponent(workspaceId)}/runner-pools`,body:input,parse});
  }

  updateRunnerPool<T = {pool:RunnerPool}>(workspaceId:string,poolId:string,input:RunnerPoolInput,parse?: (value:unknown)=>T):Promise<ApiResult<T>> {
    return this.request({method:"PUT",path:`/v1/workspaces/${encodeURIComponent(workspaceId)}/runner-pools/${encodeURIComponent(poolId)}`,body:input,parse});
  }

  deleteRunnerPool<T = {deleted:true}>(workspaceId:string,poolId:string,parse?: (value:unknown)=>T):Promise<ApiResult<T>> {
    return this.request({method:"DELETE",path:`/v1/workspaces/${encodeURIComponent(workspaceId)}/runner-pools/${encodeURIComponent(poolId)}`,body:{},parse});
  }

  listPersonalAccessTokens<T = {items:TokenSummary[]}>(parse?: (value: unknown) => T): Promise<ApiResult<T>> {
    return this.request({ path: "/v1/personal-access-tokens", parse });
  }

  createPersonalAccessToken<T = {credential:IssuedCredential}>(input: PersonalAccessTokenInput, parse?: (value: unknown) => T): Promise<ApiResult<T>> {
    return this.request({ method: "POST", path: "/v1/personal-access-tokens", body: input, parse });
  }

  revokePersonalAccessToken<T = {revoked:true}>(tokenId: string, reason: string, parse?: (value: unknown) => T): Promise<ApiResult<T>> {
    return this.request({ method: "DELETE", path: `/v1/personal-access-tokens/${encodeURIComponent(tokenId)}`, body: { reason }, parse });
  }

  listServiceAccounts<T = {items:ServiceAccount[]}>(workspaceId: string, parse?: (value: unknown) => T): Promise<ApiResult<T>> {
    return this.request({ path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/service-accounts`, parse });
  }

  createServiceAccount<T = {serviceAccount:ServiceAccount}>(workspaceId: string, input: ServiceAccountInput, parse?: (value: unknown) => T): Promise<ApiResult<T>> {
    return this.request({ method: "POST", path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/service-accounts`, body: input, parse });
  }

  issueServiceAccountToken<T = {credential:IssuedCredential}>(workspaceId: string, serviceAccountId: string, input: PersonalAccessTokenInput, parse?: (value: unknown) => T): Promise<ApiResult<T>> {
    return this.request({ method: "POST", path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/service-accounts/${encodeURIComponent(serviceAccountId)}/tokens`, body: input, parse });
  }

  revokeWorkspaceAccessToken<T = {revoked:true}>(workspaceId: string, tokenId: string, reason: string, parse?: (value: unknown) => T): Promise<ApiResult<T>> {
    return this.request({ method: "DELETE", path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/access-tokens/${encodeURIComponent(tokenId)}`, body: { reason }, parse });
  }

  async request<T = unknown>(input: ApiRequest<T>): Promise<ApiResult<T>> {
    const method = input.method ?? "GET";
    const safe = method === "GET";
    validatePath(input.path);
    const url = new URL(input.path, this.baseUrl);
    for (const [key, value] of Object.entries(input.query ?? {})) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    const correlationId = this.newCorrelationId();
    const idempotencyKey = safe || input.idempotencyKey === false ? null : input.idempotencyKey ?? this.newIdempotencyKey();
    if (idempotencyKey !== null && !/^[A-Za-z0-9._:-]{16,200}$/.test(idempotencyKey)) throw new Error("idempotencyKey must contain 16 to 200 safe ASCII characters.");
    const body = input.body === undefined ? undefined : JSON.stringify(input.body);

    for (let attempt = 0; ; attempt += 1) {
      const token = await resolveToken(this.options.accessToken);
      const headers = new Headers({ accept: "application/json", "x-correlation-id": correlationId });
      if (token) headers.set("authorization", `Bearer ${token}`);
      if (body !== undefined) headers.set("content-type", "application/json");
      if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
      if (!safe) headers.set("x-sandbox-request-time", new Date().toISOString());
      let response: Response;
      try {
        response = await this.fetchImplementation(url, { method, headers, body, signal: input.signal, credentials: "omit", redirect: "error" });
      } catch (error) {
        if (attempt >= this.maximumRetries || (!safe && !idempotencyKey) || input.signal?.aborted) throw error;
        await this.sleep(backoffMilliseconds(attempt), input.signal);
        continue;
      }
      if (isRetryable(response.status) && attempt < this.maximumRetries && (safe || idempotencyKey)) {
        await this.sleep(retryDelayMilliseconds(response.headers.get("retry-after"), attempt), input.signal);
        continue;
      }
      const responseCorrelationId = response.headers.get("x-correlation-id") ?? correlationId;
      const payload = await readPayload(response);
      if (!response.ok) throw apiError(response, payload, responseCorrelationId);
      let data: T;
      try { data = input.parse ? input.parse(payload) : payload as T; }
      catch (cause) { throw new SandboxApiCompatibilityError(responseCorrelationId, { cause }); }
      return {
        data,
        statusCode: response.status,
        correlationId: responseCorrelationId,
        idempotencyReplayed: response.headers.get("idempotency-replayed") === "true",
        rateLimit: {
          limit: integerHeader(response.headers, "x-ratelimit-limit"),
          remaining: integerHeader(response.headers, "x-ratelimit-remaining"),
          resetSeconds: integerHeader(response.headers, "x-ratelimit-reset")
        }
      };
    }
  }
}

function validatePath(path: string): void {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || !(path === "/health" || path.startsWith("/v1/"))) throw new Error("API path must be a local /v1 or /health path.");
}

async function resolveToken(token: SandboxApiClientOptions["accessToken"]): Promise<string | null> {
  const value = typeof token === "function" ? await token() : token;
  return value?.trim() || null;
}

async function readPayload(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  if (response.headers.get("content-type")?.includes("json")) {
    try { return JSON.parse(text) as unknown; }
    catch { throw new SandboxApiCompatibilityError(response.headers.get("x-correlation-id") ?? "unknown"); }
  }
  return text;
}

function apiError(response: Response, payload: unknown, correlationId: string): SandboxApiError {
  const envelope = payload && typeof payload === "object" ? payload as Partial<ApiErrorEnvelope> : null;
  const error = envelope?.error;
  return new SandboxApiError(
    response.status,
    error && typeof error.code === "string" ? error.code : `http_${response.status}`,
    error && typeof error.message === "string" ? error.message : "The sndbox API request failed.",
    typeof envelope?.correlationId === "string" ? envelope.correlationId : correlationId,
    error?.details,
    retryAfterSeconds(response.headers.get("retry-after"))
  );
}

function integerHeader(headers: Headers, name: string): number | null {
  const value = headers.get(name); if (value === null) return null;
  const parsed = Number.parseInt(value, 10); return Number.isFinite(parsed) ? parsed : null;
}

function retryAfterSeconds(value: string | null): number | null {
  if (value === null) return null;
  const seconds = Number(value); if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds));
  const date = Date.parse(value); return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1_000)) : null;
}

function retryDelayMilliseconds(retryAfter: string | null, attempt: number): number {
  return Math.min(30_000, (retryAfterSeconds(retryAfter) ?? backoffMilliseconds(attempt) / 1_000) * 1_000);
}

function backoffMilliseconds(attempt: number): number { return Math.min(5_000, 250 * 2 ** attempt); }
function isRetryable(status: number): boolean { return status === 429 || status === 502 || status === 503 || status === 504; }

function randomIdentifier(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  throw new Error("crypto.randomUUID is required.");
}

function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const onAbort = () => { clearTimeout(timeout); reject(signal?.reason); };
    const timeout = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
