import { createHmac } from "node:crypto";
import type { Permission } from "@sandbox/contracts";
import { describe, expect, it, vi } from "vitest";
import type { TransactionalEmail } from "./email.js";
import { createServer } from "./server.js";
import type { AuthenticatedSession, ControlPlaneRepository, SessionVerifier } from "./types.js";
import type { RunnerCommandSigner } from "./runner_protocol.js";
import type { BillingProvider } from "./billing.js";
import type { EntitlementClaimSigner } from "./entitlement.js";
import { WebhookProtector, webhookSignature } from "./webhook_crypto.js";
import type { CredentialAdministration } from "./credentials.js";
import { MemoryApiIdempotencyStore } from "./api_contract.js";
import { HmacUsageProducerAuthenticator } from "./usage_producer.js";
import type { UsageEventInput } from "./usage.js";
import type { ServiceAccountAccessReviewAdministration } from "./access_reviews.js";
import { ReadinessService, ServiceMetrics } from "./reliability.js";
import type { SupportAccessAdministration,SupportAccessRequest } from "./support_access.js";
import type { PrivacyAdministration,WorkspaceRetentionPolicy } from "./privacy.js";
import type { ReferralAdministration,ReferralSummary } from "./referrals.js";
import type { CollaborationService } from "./collaboration.js";

const session: AuthenticatedSession = {
  accountId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  subject: "identity|one",
  email: "one@example.com",
  issuedAt: new Date(),
  expiresAt: new Date(Date.now() + 60_000),
  authenticationMethods: ["passkey"],
  platformPermissions: []
};
const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function dependencies(permissions: string[]) {
  const repository: ControlPlaneRepository = {
    permissions: vi.fn(async () => new Set(permissions as never[])),
    listAccountOrganisations: vi.fn(async () => []),
    createOrganisation: vi.fn(),
    createInvitation: vi.fn(async (_actor, _workspace, input) => ({ id: crypto.randomUUID(), organisationId: crypto.randomUUID(), workspaceIds: input.workspaceIds, email: input.email, role: input.role, expiresAt: input.expiresAt.toISOString(), status: "pending" })),
    acceptInvitation: vi.fn(),
    createSyncedWorkflow: vi.fn(),
    listSyncedWorkflows: vi.fn(async () => []),
    appendWorkflowRevision: vi.fn(async (_actor, _workspace, revision) => ({ revision: { ...revision, syncState: "synced" }, conflictRevisionId: null })),
    listWorkflowRevisions: vi.fn(),
    getWorkflowRevision: vi.fn(),
    resolveSyncConflict: vi.fn(),
    createPublisher: vi.fn(), registerPublisherSigningKey: vi.fn(), createPluginSubmission: vi.fn(), getPluginSubmission: vi.fn(), recordAutomatedPluginReview: vi.fn(), publishPluginVersion: vi.fn(), decidePluginReview: vi.fn(), revokePluginVersion: vi.fn(),
    searchMarketplace: vi.fn(async () => ({ items: [], nextCursor: null })), getMarketplaceListing: vi.fn(), getMarketplacePackage: vi.fn(),
    listAuditEvents: vi.fn(), exportAccountData: vi.fn(), requestAccountDeletion: vi.fn(), listSessions: vi.fn(), revokeSession: vi.fn(),
    createRunnerPairingChallenge: vi.fn(), confirmRunnerPairing: vi.fn(), listRunners: vi.fn(), createRunnerCommand: vi.fn(), revokeRunner: vi.fn(),
    requestWorkflowApproval: vi.fn(), listWorkflowApprovals: vi.fn(async()=>[]), decideWorkflowApproval: vi.fn(), publishWorkflowRevision: vi.fn(), rollbackWorkflowRevision: vi.fn(),
    getGovernancePolicies: vi.fn(async () => ({})), setGovernancePolicy: vi.fn(), listWorkspaceMembers: vi.fn(), updateWorkspaceMemberRole: vi.fn(), removeWorkspaceMember: vi.fn(), revokeInvitation: vi.fn(),
    authenticateRunnerRequest: vi.fn(), recordRunnerHeartbeat: vi.fn(), dequeueRunnerCommands: vi.fn(), updateRunnerCommandStatus: vi.fn(), recordRunnerTriggerEvents: vi.fn(), recordRunSummary: vi.fn(), listWorkspaceActivity: vi.fn(), listDeployments:vi.fn(async()=>[]), createDeployment:vi.fn(), transitionDeployment:vi.fn(), listRunnerPools:vi.fn(async()=>[]), createRunnerPool:vi.fn(), updateRunnerPool:vi.fn(), deleteRunnerPool:vi.fn(),
    listOrganisationRoles:vi.fn(async()=>[]),createOrganisationRole:vi.fn(),updateOrganisationRole:vi.fn(),deleteOrganisationRole:vi.fn(),listSsoConnections:vi.fn(async()=>[]),createSsoConnection:vi.fn(),updateSsoConnection:vi.fn(),deleteSsoConnection:vi.fn(),listScimTokens:vi.fn(async()=>[]),createScimToken:vi.fn(),revokeScimToken:vi.fn(),authenticateScimToken:vi.fn(),listScimUsers:vi.fn(),getScimUser:vi.fn(),upsertScimUser:vi.fn(),
    listWorkspaceEnvironments: vi.fn(), listSharedConnections: vi.fn(), createSharedConnection: vi.fn(), deploySharedConnection: vi.fn(),
    getPluginBillingPlan: vi.fn(), recordMarketplaceCheckout: vi.fn(), applyBillingEvent: vi.fn(), getActiveEntitlement: vi.fn(),
    createWebhookEndpoint: vi.fn(), listWebhookEndpoints: vi.fn(), getWebhookEndpointByPublicId: vi.fn(), rotateWebhookSecret: vi.fn(), enqueueWebhookDelivery: vi.fn(), dequeueWebhookDeliveries: vi.fn(), acknowledgeWebhookDelivery: vi.fn(),
    listPluginRatings: vi.fn(), upsertPluginRating: vi.fn(), respondToPluginRating: vi.fn(), reportPluginRating: vi.fn(), updateRunner: vi.fn(), moveRunner: vi.fn(), rotateRunnerDeviceKey: vi.fn(),
    listProtectedVariables: vi.fn(), upsertProtectedVariable: vi.fn(), resolveProtectedVariables: vi.fn()
  };
  const sessions: SessionVerifier = { verify: vi.fn(async () => session) };
  const email: TransactionalEmail = { sendInvitation: vi.fn(async () => undefined),sendCredentialExpiry:vi.fn(async()=>undefined) };
  const packageStorage = { createUpload: vi.fn(), createDownload: vi.fn(), inspect: vi.fn() };
  const packageScanner = { scan: vi.fn() };
  const runnerCommandSigner: RunnerCommandSigner = { keyId: "control-plane-1", sign: vi.fn(() => Buffer.alloc(64, 7).toString("base64")) };
  const billing: BillingProvider = { createCheckout: vi.fn(), parseWebhook: vi.fn() };
  const entitlementSigner: EntitlementClaimSigner = { keyId: "entitlement-1", issuer: "https://api.sandbox.test", sign: vi.fn(record => ({ entitlementId: record.entitlementId, owner: { ownerType: record.ownerType, ownerId: record.ownerId }, pluginId: record.pluginId, planId: record.planId, status: record.status, seatAllowance: record.seatAllowance, validFrom: record.startsAt, validUntil: record.renewsAt, offlineGraceUntil: record.offlineGraceUntil, issuer: "https://api.sandbox.test", keyId: "entitlement-1", signature: Buffer.alloc(64, 8).toString("base64") })) };
  const credentialService:CredentialAdministration={createServiceAccount:vi.fn(),createOrganisationServiceAccount:vi.fn(),listServiceAccounts:vi.fn(),issuePersonalToken:vi.fn(),issueServiceAccountToken:vi.fn(),listPersonalTokens:vi.fn(),revokeToken:vi.fn(),registerServiceAccountAssertionKey:vi.fn(),revokeServiceAccountAssertionKey:vi.fn(),exchangeServiceAccountAssertion:vi.fn()};
  const accessReviews:ServiceAccountAccessReviewAdministration={list:vi.fn(),workspaceIds:vi.fn(),decide:vi.fn()};
  return { repository, sessions, email, packageStorage, packageScanner, runnerCommandSigner, billing, entitlementSigner, credentialService, accessReviews, webhookProtector: new WebhookProtector(Buffer.alloc(32, 4)), protectedValueProtector: new WebhookProtector(Buffer.alloc(32, 5)), webhookBaseUrl: "https://hooks.sandbox.test", webBaseUrl: "https://app.sandbox.test" };
}

describe("control-plane API", () => {
  it("coordinates encrypted workflow collaboration behind workflow permissions", async () => {
    const workflowId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const collaborationSessionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const deviceId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const operationId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const now = new Date().toISOString();
    const encryptedPayload = Buffer.alloc(32, 7).toString("base64");
    const payloadHash = `sha256:${"a".repeat(64)}`;
    const collaboration: CollaborationService = {
      join: vi.fn(async () => ({ sessionId: collaborationSessionId, workspaceId, workflowId, latestSequence: 0, joinedAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() })),
      append: vi.fn(async (_actor, _workspace, _workflow, sessionId, input) => ({ ...input, sessionId, workflowId, actorAccountId: session.accountId, sequence: 1, acceptedAt: now })),
      operations: vi.fn(async () => ({ items: [], latestSequence: 1 })),
      heartbeat: vi.fn(async () => undefined),
      presence: vi.fn(async () => [{ accountId: session.accountId, deviceId, displayName: "One", color: "#5b8def", encryptedPresence: encryptedPayload, lastSeenAt: now }]),
      leave: vi.fn(async () => undefined),
    };
    const server = await createServer({ ...dependencies(["workflows.edit", "workflows.view"]), collaboration });
    const freshHeaders = { authorization: "Bearer token", "x-sandbox-request-time": now };
    const baseUrl = `/v1/workspaces/${workspaceId}/workflows/${workflowId}/collaboration`;
    const started = await server.inject({ method: "POST", url: `${baseUrl}/sessions`, headers: freshHeaders, payload: { deviceId, color: "#5b8def" } });
    expect(started.statusCode, started.body).toBe(200);
    expect(started.json().session).toMatchObject({ sessionId: collaborationSessionId, workflowId });
    const operationInput = { operationId, baseSequence: 0, clientSequence: 1, encryptedPayload, payloadHash, createdAt: now };
    const appended = await server.inject({ method: "POST", url: `${baseUrl}/sessions/${collaborationSessionId}/operations`, headers: { authorization: "Bearer token" }, payload: operationInput });
    expect(appended.statusCode, appended.body).toBe(200);
    expect(collaboration.append).toHaveBeenCalledWith(session, workspaceId, workflowId, collaborationSessionId, operationInput);
    const polled = await server.inject({ method: "GET", url: `${baseUrl}/sessions/${collaborationSessionId}/operations?after=0&limit=50`, headers: { authorization: "Bearer token" } });
    expect(polled.statusCode, polled.body).toBe(200);
    expect(collaboration.operations).toHaveBeenCalledWith(session, workspaceId, workflowId, collaborationSessionId, 0, 50);
    const presence = await server.inject({ method: "PUT", url: `${baseUrl}/sessions/${collaborationSessionId}/presence`, headers: { authorization: "Bearer token" }, payload: { deviceId, color: "#5b8def", encryptedPresence: encryptedPayload } });
    expect(presence.statusCode, presence.body).toBe(200);
    expect(collaboration.heartbeat).toHaveBeenCalledWith(session, workspaceId, workflowId, collaborationSessionId, deviceId, "#5b8def", encryptedPayload);
    const listed = await server.inject({ method: "GET", url: `${baseUrl}/sessions/${collaborationSessionId}/presence`, headers: { authorization: "Bearer token" } });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().items).toHaveLength(1);
    const left = await server.inject({ method: "DELETE", url: `${baseUrl}/sessions/${collaborationSessionId}/members/${deviceId}`, headers: freshHeaders });
    expect(left.statusCode, left.body).toBe(200);
    expect(collaboration.leave).toHaveBeenCalledWith(session, workspaceId, workflowId, collaborationSessionId, deviceId);
    await server.close();
  });

  it("does not expose collaboration when workflow edit permission is absent", async () => {
    const workflowId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const deviceId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const join = vi.fn();
    const collaboration = { join } as unknown as CollaborationService;
    const server = await createServer({ ...dependencies(["workflows.view"]), collaboration });
    const response = await server.inject({ method: "POST", url: `/v1/workspaces/${workspaceId}/workflows/${workflowId}/collaboration/sessions`, headers: { authorization: "Bearer token", "x-sandbox-request-time": new Date().toISOString() }, payload: { deviceId, color: "#5b8def" } });
    expect(response.statusCode).toBe(403);
    expect(join).not.toHaveBeenCalled();
    await server.close();
  });

  it("exposes and claims referrals only through an authenticated human account",async()=>{
    const now=new Date().toISOString();
    const summary:ReferralSummary={code:"abcdef123456",shareUrl:"https://app.sandbox.test/r/abcdef123456",policy:{claimWindowDays:7,qualifyingTopUpCents:1_000,rewardMicros:5_000_000,maximumRewardsPerRollingYear:50},stats:{invited:1,pending:1,rewarded:0,earnedMicros:0},claim:null,referrals:[{id:"33333333-3333-4333-8333-333333333333",status:"pending",claimedAt:now,rewardedAt:null,reversedAt:null}]};
    const referrals:ReferralAdministration={accountSummary:vi.fn(async()=>summary),claim:vi.fn(async()=>({claimed:true as const,status:"pending" as const}))};
    const deps={...dependencies([]),referrals},server=await createServer(deps),headers={authorization:"Bearer token","x-sandbox-request-time":new Date().toISOString()};
    const listed=await server.inject({method:"GET",url:"/v1/account/referrals",headers});
    expect(listed.statusCode,listed.body).toBe(200);expect(listed.json()).toEqual(summary);expect(referrals.accountSummary).toHaveBeenCalledWith(session,"https://app.sandbox.test");
    const claimed=await server.inject({method:"POST",url:"/v1/account/referrals/claim",headers,payload:{code:"ABCDEF123456"}});
    expect(claimed.statusCode,claimed.body).toBe(200);expect(claimed.json()).toEqual({claimed:true,status:"pending"});expect(referrals.claim).toHaveBeenCalledWith(session,"abcdef123456");
    const invalid=await server.inject({method:"POST",url:"/v1/account/referrals/claim",headers,payload:{code:"../unsafe"}});
    expect(invalid.statusCode).toBe(400);expect(referrals.claim).toHaveBeenCalledTimes(1);
    await server.close();
  });
  it("accepts only signed events from a trusted usage producer",async()=>{
    const secret=Buffer.alloc(32,8),record=vi.fn(async(input:UsageEventInput)=>({eventId:input.eventId,created:true}));
    const deps={...dependencies([]),usageLedger:{record},usageProducerAuthenticator:new HmacUsageProducerAuthenticator(new Map([["hosted-runner",secret]]))};
    const server=await createServer(deps);const payload={eventId:"10000000-0000-4000-8000-000000000001",workspaceId:"20000000-0000-4000-8000-000000000002",environmentId:"30000000-0000-4000-8000-000000000003",executionId:"40000000-0000-4000-8000-000000000004",deploymentId:"50000000-0000-4000-8000-000000000005",meter:"hosted_runner_seconds" as const,quantity:3,unit:"seconds" as const,sourceEventId:"hosted-runner-stop:execution",idempotencyKey:"hosted-runner-usage:execution",periodStartedAt:"2026-08-28T10:00:00.000Z",periodEndedAt:"2026-08-28T10:00:03.000Z",region:"eu-west-2",metadata:{producer:"hosted-runner"}};
    const timestamp=Math.floor(Date.now()/1000).toString(),signature=createHmac("sha256",secret).update(`${timestamp}.${JSON.stringify(payload)}`).digest("hex"),headers={"x-sandbox-usage-producer":"hosted-runner","x-sandbox-usage-timestamp":timestamp,"x-sandbox-usage-signature":signature};
    const accepted=await server.inject({method:"POST",url:"/v1/internal/usage-events",headers,payload});expect(accepted.statusCode,accepted.body).toBe(200);expect(record).toHaveBeenCalledWith(payload);
    const rejected=await server.inject({method:"POST",url:"/v1/internal/usage-events",headers:{...headers,"x-sandbox-usage-signature":"0".repeat(64)},payload});expect(rejected.statusCode).toBe(401);expect(record).toHaveBeenCalledTimes(1);await server.close();
  });
  it("returns reconciled workspace usage to members who can view execution summaries",async()=>{
    const summary={workspaceId,periodStartedAt:"2026-08-04T00:00:00.000Z",periodEndedAt:"2026-09-02T12:00:00.000Z",reconciliation:"matched" as const,meters:[{meter:"hosted_runner_seconds" as const,unit:"seconds" as const,quantity:180}],daily:[{date:"2026-09-02",quantities:{hosted_runner_seconds:180,managed_browser_seconds:0,network_egress_bytes:0,artifact_storage_byte_seconds:0}}]};
    const workspaceSummary=vi.fn(async()=>summary),deps={...dependencies(["executions.view_summary"]),usageReader:{workspaceSummary}};
    const server=await createServer(deps),response=await server.inject({method:"GET",url:`/v1/workspaces/${workspaceId}/usage?days=30`,headers:{authorization:"Bearer token"}});
    expect(response.statusCode,response.body).toBe(200);expect(response.json()).toEqual(summary);expect(workspaceSummary).toHaveBeenCalledWith(workspaceId,30);expect(deps.repository.permissions).toHaveBeenCalledWith(session.accountId,workspaceId);await server.close();
  });
  it("authorizes and returns additive workspace activity health fields", async () => {
    const summary = { generatedAt: "2026-09-10T10:15:00.000Z", runners: [], runs: [], pendingApprovalCount: 2, webhookFailureCount: 1, syncConflictCount: 3 };
    const allowed = dependencies(["executions.view_summary"]);
    allowed.repository.listWorkspaceActivity = vi.fn(async () => summary);
    const server = await createServer(allowed);
    const response = await server.inject({ method: "GET", url: `/v1/workspaces/${workspaceId}/activity?limit=25`, headers: { authorization: "Bearer token" } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual(summary);
    expect(allowed.repository.listWorkspaceActivity).toHaveBeenCalledWith(session, workspaceId, 25);
    await server.close();

    const denied = dependencies([]);
    denied.repository.listWorkspaceActivity = vi.fn(async () => summary);
    const deniedServer = await createServer(denied);
    const forbidden = await deniedServer.inject({ method: "GET", url: `/v1/workspaces/${workspaceId}/activity`, headers: { authorization: "Bearer token" } });
    expect(forbidden.statusCode).toBe(403);
    expect(denied.repository.listWorkspaceActivity).not.toHaveBeenCalled();
    await deniedServer.close();
  });
  it("returns stable structured transport errors and correlation headers",async()=>{
    const deps=dependencies([]);const server=await createServer(deps);
    const response=await server.inject({method:"POST",url:"/v1/personal-access-tokens",headers:{authorization:"Bearer token","content-type":"application/json","x-correlation-id":"client-correlation-0001"},payload:'{"broken":'});
    expect(response.statusCode).toBe(400);
    expect(response.headers["x-correlation-id"]).toBe("client-correlation-0001");
    expect(response.json()).toEqual({error:{code:"invalid_json",message:"The request body must be valid JSON."},correlationId:"client-correlation-0001"});
    await server.close();
  });

  it("accepts bounded first-party bug reports without a user webhook",async()=>{
    const submit=vi.fn(async()=>({delivered:true as const,provider:"discord" as const,status:204,reportId:"BUG-1234ABCD"}));
    const deps={...dependencies([]),bugReports:{submit}},server=await createServer(deps);
    const payload={summary:"Code editor loses diagnostics",description:"The error list disappears after changing language.",diagnostics:{"App version":"0.8.0-beta.1"}};
    const response=await server.inject({method:"POST",url:"/v1/support/bug-reports",headers:{"idempotency-key":"bug-report-request-0001"},payload});
    expect(response.statusCode,response.body).toBe(200);expect(response.json()).toEqual({delivered:true,provider:"discord",status:204,reportId:"BUG-1234ABCD"});
    expect(submit).toHaveBeenCalledWith(payload);expect(deps.sessions.verify).not.toHaveBeenCalled();
    const invalid=await server.inject({method:"POST",url:"/v1/support/bug-reports",payload:{...payload,extra:"not accepted"}});
    expect(invalid.statusCode).toBe(400);expect(submit).toHaveBeenCalledTimes(1);await server.close();
  });

  it("discovers only the signed-in account's workspaces and authorized synced workflows",async()=>{
    const deps=dependencies(["workflows.view"]),organisationId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",now=new Date().toISOString();
    vi.mocked(deps.repository.listAccountOrganisations).mockResolvedValue([{id:organisationId,name:"Acme",slug:"acme",role:"developer",createdAt:now,workspaces:[{id:workspaceId,organisationId,name:"Operations",slug:"operations",role:"developer",createdAt:now}]}]);
    vi.mocked(deps.repository.listSyncedWorkflows).mockResolvedValue([{workflowId:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",name:"Daily report",currentDraftRevisionId:null,currentPublishedRevisionId:null,createdAt:now,updatedAt:null}]);
    const server=await createServer(deps),headers={authorization:"Bearer token"};
    const account=await server.inject({method:"GET",url:"/v1/account/organisations",headers});
    expect(account.statusCode,account.body).toBe(200);expect(account.json().items[0].workspaces[0].id).toBe(workspaceId);expect(deps.repository.listAccountOrganisations).toHaveBeenCalledWith(session);
    const workflows=await server.inject({method:"GET",url:`/v1/workspaces/${workspaceId}/sync/workflows`,headers});
    expect(workflows.statusCode,workflows.body).toBe(200);expect(workflows.json().items[0].name).toBe("Daily report");expect(deps.repository.permissions).toHaveBeenCalledWith(session.accountId,workspaceId);
    await server.close();
  });

  it("replays identical mutating requests and rejects idempotency-key mutation",async()=>{
    const deps={...dependencies(["members.manage"]),idempotencyStore:new MemoryApiIdempotencyStore()};
    const server=await createServer(deps);const key="invitation-request-0001";
    const request={method:"POST" as const,url:`/v1/workspaces/${workspaceId}/invitations`,headers:{authorization:"Bearer token","x-sandbox-request-time":new Date().toISOString(),"idempotency-key":key},payload:{email:"developer@example.com",role:"developer",workspaceIds:[workspaceId],expiresInHours:24}};
    const first=await server.inject(request);const replay=await server.inject(request);
    expect(first.statusCode,first.body).toBe(200);expect(replay.statusCode,replay.body).toBe(200);
    expect(replay.headers["idempotency-replayed"]).toBe("true");expect(replay.json()).toEqual(first.json());
    expect(deps.repository.createInvitation).toHaveBeenCalledTimes(1);expect(deps.email.sendInvitation).toHaveBeenCalledTimes(1);
    const conflict=await server.inject({...request,payload:{...request.payload,email:"different@example.com"}});
    expect(conflict.statusCode).toBe(409);expect(conflict.json().error.code).toBe("idempotency_key_reused");
    await server.close();
  });

  it("publishes rate-limit headers and the machine-readable v1 route contract",async()=>{
    const deps=dependencies([]);const server=await createServer(deps);
    const health=await server.inject({method:"GET",url:"/health"});
    expect(health.headers["x-ratelimit-limit"]).toBe("60");expect(health.headers["x-correlation-id"]).toBeTruthy();
    let limited=health;
    for(let index=1;index<=60;index+=1)limited=await server.inject({method:"GET",url:"/health"});
    expect(limited.statusCode,limited.body).toBe(429);expect(limited.headers["retry-after"]).toBeTruthy();expect(limited.json()).toMatchObject({error:{code:"rate_limit_exceeded"},correlationId:expect.any(String)});
    const contract=await server.inject({method:"GET",url:"/v1/openapi.json"});
    expect(contract.statusCode,contract.body).toBe(200);
    expect(contract.json()).toMatchObject({openapi:"3.1.0",info:{version:"0.5.0"},paths:{"/v1/personal-access-tokens":{get:expect.any(Object),post:expect.any(Object)}}});
    await server.close();
  });

  it("reports dependency readiness and exposes authenticated bounded metrics",async()=>{
    let databaseReady=false;
    const metrics=new ServiceMetrics();
    const readiness=new ReadinessService([{name:"database",check:async()=>{if(!databaseReady)throw new Error("database unavailable");}}]);
    const server=await createServer({...dependencies([]),readiness,metrics,metricsBearerToken:"metrics-secret"});
    const unavailable=await server.inject({method:"GET",url:"/ready"});
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({status:"not_ready",checks:[{name:"database",status:"not_ready"}]});
    databaseReady=true;
    const ready=await server.inject({method:"GET",url:"/ready"});
    expect(ready.statusCode,ready.body).toBe(200);
    expect(ready.json()).toMatchObject({status:"ready",checks:[{name:"database",status:"ready"}]});
    const denied=await server.inject({method:"GET",url:"/metrics",headers:{authorization:"Bearer wrong"}});
    expect(denied.statusCode).toBe(401);
    const exported=await server.inject({method:"GET",url:"/metrics",headers:{authorization:"Bearer metrics-secret"}});
    expect(exported.statusCode,exported.body).toBe(200);
    expect(exported.headers["content-type"]).toContain("text/plain");
    expect(exported.body).toContain('sandbox_http_requests_total{method="GET",route="/ready",status_class="2xx"} 1');
    expect(exported.body).toContain('sandbox_readiness_checks_total{outcome="not_ready"} 1');
    await server.close();
  });

  it("requires customer approval before support can collect redacted diagnostics",async()=>{
    const requestId="99999999-9999-4999-8999-999999999999",now=new Date(),expiresAt=new Date(now.getTime()+3_600_000).toISOString();
    const pending:SupportAccessRequest={id:requestId,workspaceId,requestedBy:"33333333-3333-4333-8333-333333333333",reason:"Investigate runner capacity failures.",scopes:["diagnostics.read"],requestedAt:now.toISOString(),expiresAt,status:"pending",decidedBy:null,decidedAt:null,rationale:null,revokedBy:null,revokedAt:null};
    const supportAccess:SupportAccessAdministration={request:vi.fn(async()=>pending),workspaceId:vi.fn(async()=>workspaceId),list:vi.fn(async()=>[pending]),decide:vi.fn(async(_actor,_id,_decision,rationale):Promise<SupportAccessRequest>=>({...pending,status:"approved",decidedBy:session.accountId,decidedAt:new Date().toISOString(),rationale})),revoke:vi.fn(),diagnostics:vi.fn(async()=>({collectedAt:new Date().toISOString(),workspaceId,runners:{online:2},executionsLast24Hours:{failed:1},queuedEvents:{queued:3},webhookDeliveries:{delivered:4}}))};
    const deps={...dependencies(["members.manage"]),supportAccess};
    const staff={...session,accountId:pending.requestedBy,platformPermissions:["support_access.manage"]},customer={...session,issuedAt:new Date(),platformPermissions:[]};
    vi.mocked(deps.sessions.verify).mockResolvedValueOnce(staff).mockResolvedValueOnce(customer).mockResolvedValueOnce(staff);
    const server=await createServer(deps),headers={authorization:"Bearer token","x-sandbox-request-time":new Date().toISOString()};
    const requested=await server.inject({method:"POST",url:"/v1/platform/support-access-requests",headers,payload:{workspaceId,reason:pending.reason,scopes:["diagnostics.read"],durationMinutes:60}});
    expect(requested.statusCode,requested.body).toBe(200);expect(supportAccess.request).toHaveBeenCalledWith(staff,workspaceId,pending.reason,["diagnostics.read"],60,expect.any(String));
    const approved=await server.inject({method:"POST",url:`/v1/support-access-requests/${requestId}/decision`,headers,payload:{decision:"approve",rationale:"Approved for aggregate diagnostics only."}});
    expect(approved.statusCode,approved.body).toBe(200);expect(deps.repository.permissions).toHaveBeenCalledWith(customer.accountId,workspaceId);expect(supportAccess.decide).toHaveBeenCalled();
    const diagnostics=await server.inject({method:"GET",url:`/v1/platform/support-access-requests/${requestId}/diagnostics`,headers});
    expect(diagnostics.statusCode,diagnostics.body).toBe(200);expect(diagnostics.json().diagnostics).toMatchObject({workspaceId,runners:{online:2}});
    await server.close();
  });

  it("enforces workspace retention administration and the production privacy deletion path",async()=>{
    const policy:WorkspaceRetentionPolicy={executionDetailDays:90,queueEventDays:30,webhookDeliveryDays:7,runnerCommandDays:30,auditEventDays:2555,changedBy:session.accountId,changedAt:new Date().toISOString()};
    const privacy:PrivacyAdministration={getRetention:vi.fn(async()=>policy),setRetention:vi.fn(async()=>policy),exportAccount:vi.fn(async()=>({exportVersion:1,account:{id:session.accountId}})),deleteAccount:vi.fn(async()=>({requestId:"88888888-8888-4888-8888-888888888888",completedAt:new Date().toISOString(),summary:{sessions:1}}))};
    const deps={...dependencies(["policies.manage"]),privacy},server=await createServer(deps),headers={authorization:"Bearer token","x-sandbox-request-time":new Date().toISOString()};
    const updated=await server.inject({method:"PUT",url:`/v1/workspaces/${workspaceId}/privacy-retention`,headers,payload:{executionDetailDays:90,queueEventDays:30,webhookDeliveryDays:7,runnerCommandDays:30,auditEventDays:2555}});expect(updated.statusCode,updated.body).toBe(200);expect(privacy.setRetention).toHaveBeenCalledWith(session,workspaceId,expect.objectContaining({auditEventDays:2555}));
    const exported=await server.inject({method:"GET",url:"/v1/account/export",headers:{authorization:"Bearer token"}});expect(exported.statusCode,exported.body).toBe(200);expect(privacy.exportAccount).toHaveBeenCalled();
    const deleted=await server.inject({method:"DELETE",url:"/v1/account",headers});expect(deleted.statusCode,deleted.body).toBe(200);expect(deleted.json()).toMatchObject({deleted:true,requestId:expect.any(String),summary:{sessions:1}});expect(deps.repository.requestAccountDeletion).not.toHaveBeenCalled();await server.close();
  });

  it("shows a newly issued personal token once and never asks the credential service to persist plaintext",async()=>{
    const deps=dependencies([]);const organisationId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",environmentId="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    vi.mocked(deps.credentialService.issuePersonalToken).mockResolvedValue({id:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",name:"CI",prefix:"sbx_pat_abcdefghijkl",token:"sbx_pat_abcdefghijkl.secret",scopes:["workflows.run"],organisationId,workspaceIds:[workspaceId],environmentIds:[environmentId],createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+86_400_000).toISOString()});
    const server=await createServer(deps);const response=await server.inject({method:"POST",url:"/v1/personal-access-tokens",headers:{authorization:"Bearer token","x-sandbox-request-time":new Date().toISOString()},payload:{name:"CI",scopes:["workflows.run"],organisationId,workspaceIds:[workspaceId],environmentIds:[environmentId],expiresInDays:1}});
    expect(response.statusCode,response.body).toBe(200);expect(response.json().credential.token).toMatch(/^sbx_pat_/);expect(deps.credentialService.issuePersonalToken).toHaveBeenCalledWith(session,expect.not.objectContaining({token:expect.anything()}),expect.any(String));await server.close();
  });

  it("requires server-side service-account management permission",async()=>{
    const deps=dependencies([]);const server=await createServer(deps);const response=await server.inject({method:"POST",url:`/v1/workspaces/${workspaceId}/service-accounts`,headers:{authorization:"Bearer token","x-sandbox-request-time":new Date().toISOString()},payload:{name:"Deploy bot",roleId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}});
    expect(response.statusCode).toBe(403);expect(deps.credentialService.createServiceAccount).not.toHaveBeenCalled();await server.close();
  });

  it("creates an organisation service account only after authorizing every workspace assignment",async()=>{
    const deps=dependencies(["service_accounts.manage"]),organisationId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",secondWorkspaceId="cccccccc-cccc-4ccc-8ccc-cccccccccccc",firstRoleId="dddddddd-dddd-4ddd-8ddd-dddddddddddd",secondRoleId="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",serviceAccountId="ffffffff-ffff-4fff-8fff-ffffffffffff";
    vi.mocked(deps.credentialService.createOrganisationServiceAccount).mockResolvedValue({id:serviceAccountId,organisationId,name:"Deploy fleet",description:"",ownerAccountIds:[session.accountId],assignments:[{workspaceId,roleId:firstRoleId,environmentIds:[]},{workspaceId:secondWorkspaceId,roleId:secondRoleId,environmentIds:[]}],expiryPolicyDays:30,status:"active",createdAt:new Date().toISOString(),lastUsedAt:null});
    const server=await createServer(deps),payload={name:"Deploy fleet",assignments:[{workspaceId,roleId:firstRoleId},{workspaceId:secondWorkspaceId,roleId:secondRoleId}],expiryPolicyDays:30},response=await server.inject({method:"POST",url:`/v1/organisations/${organisationId}/service-accounts`,headers:{authorization:"Bearer token","x-sandbox-request-time":new Date().toISOString()},payload});
    expect(response.statusCode,response.body).toBe(200);expect(deps.repository.permissions).toHaveBeenCalledWith(session.accountId,workspaceId);expect(deps.repository.permissions).toHaveBeenCalledWith(session.accountId,secondWorkspaceId);expect(deps.credentialService.createOrganisationServiceAccount).toHaveBeenCalledWith(session,expect.objectContaining({organisationId,assignments:expect.arrayContaining([expect.objectContaining({workspaceId:secondWorkspaceId})])}),expect.any(String));await server.close();
  });

  it("cannot issue a multi-workspace service token through a single authorized route",async()=>{
    const deps=dependencies(["api_credentials.manage"]),secondWorkspaceId="cccccccc-cccc-4ccc-8ccc-cccccccccccc";vi.mocked(deps.repository.permissions).mockImplementation(async(_accountId,requestedWorkspaceId)=>new Set<Permission>(requestedWorkspaceId===workspaceId?["api_credentials.manage"]:[]));
    const server=await createServer(deps),response=await server.inject({method:"POST",url:`/v1/workspaces/${workspaceId}/service-accounts/dddddddd-dddd-4ddd-8ddd-dddddddddddd/tokens`,headers:{authorization:"Bearer token","x-sandbox-request-time":new Date().toISOString()},payload:{name:"Fleet token",scopes:["workflows.run"],organisationId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",workspaceIds:[workspaceId,secondWorkspaceId],expiresInDays:1}});
    expect(response.statusCode).toBe(403);expect(deps.credentialService.issueServiceAccountToken).not.toHaveBeenCalled();await server.close();
  });

  it("registers assertion keys only through a fresh human credential administrator",async()=>{
    const deps=dependencies(["api_credentials.manage"]),serviceAccountId="dddddddd-dddd-4ddd-8ddd-dddddddddddd",createdAt=new Date().toISOString();
    vi.mocked(deps.credentialService.registerServiceAccountAssertionKey).mockResolvedValue({serviceAccountId,workspaceId,keyId:"ci-2026",algorithm:"EdDSA",createdAt,revokedAt:null});
    const server=await createServer(deps);const response=await server.inject({method:"POST",url:`/v1/workspaces/${workspaceId}/service-accounts/${serviceAccountId}/assertion-keys`,headers:{authorization:"Bearer token","x-sandbox-request-time":new Date().toISOString()},payload:{keyId:"ci-2026",publicKeyDerBase64:Buffer.alloc(44).toString("base64")}});
    expect(response.statusCode,response.body).toBe(200);expect(deps.credentialService.registerServiceAccountAssertionKey).toHaveBeenCalledWith(session,serviceAccountId,workspaceId,"ci-2026",expect.any(String),expect.any(String));await server.close();
  });

  it("exchanges a signed client assertion without requiring an existing bearer token",async()=>{
    const deps=dependencies([]),assertion=`${"a".repeat(40)}.${"b".repeat(40)}.${"c".repeat(40)}`,organisationId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    vi.mocked(deps.credentialService.exchangeServiceAccountAssertion).mockResolvedValue({id:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",name:"assertion:ci",prefix:"sbx_sa_abcdefghijkl",token:"sbx_sa_abcdefghijkl.secret",scopes:["workflows.run"],organisationId,workspaceIds:[workspaceId],environmentIds:[],createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+900_000).toISOString()});
    const server=await createServer(deps);const response=await server.inject({method:"POST",url:"/v1/service-account-assertions/token",payload:{clientAssertion:assertion}});
    expect(response.statusCode,response.body).toBe(200);expect(deps.sessions.verify).not.toHaveBeenCalled();expect(deps.credentialService.exchangeServiceAccountAssertion).toHaveBeenCalledWith(assertion);await server.close();
  });

  it("authorizes an access-review decision in every assigned workspace",async()=>{
    const deps=dependencies(["service_accounts.manage"]),reviewId="dddddddd-dddd-4ddd-8ddd-dddddddddddd",secondWorkspaceId="cccccccc-cccc-4ccc-8ccc-cccccccccccc",now=new Date().toISOString();
    vi.mocked(deps.accessReviews.workspaceIds).mockResolvedValue([workspaceId,secondWorkspaceId]);vi.mocked(deps.accessReviews.decide).mockResolvedValue({id:reviewId,serviceAccountId:"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",organisationId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",serviceAccountName:"Deploy bot",workspaceIds:[workspaceId,secondWorkspaceId],openedAt:now,dueAt:now,status:"retained",accessSnapshot:{},decidedBy:session.accountId,decidedAt:now,rationale:"Still required"});
    const server=await createServer(deps),response=await server.inject({method:"POST",url:`/v1/service-account-access-reviews/${reviewId}/decision`,headers:{authorization:"Bearer token","x-sandbox-request-time":new Date().toISOString()},payload:{decision:"retain",rationale:"Still required"}});
    expect(response.statusCode,response.body).toBe(200);expect(deps.repository.permissions).toHaveBeenCalledWith(session.accountId,workspaceId);expect(deps.repository.permissions).toHaveBeenCalledWith(session.accountId,secondWorkspaceId);expect(deps.accessReviews.decide).toHaveBeenCalledWith(session,reviewId,"retain","Still required",expect.any(String));await server.close();
  });

  it("requires server-side workspace permission for invitations", async () => {
    const deps = dependencies([]);
    const server = await createServer(deps);
    const response = await server.inject({
      method: "POST", url: `/v1/workspaces/${workspaceId}/invitations`,
      headers: { authorization: "Bearer token", "x-sandbox-request-time": new Date().toISOString() },
      payload: { email: "developer@example.com", role: "developer", workspaceIds: [workspaceId], expiresInHours: 24 }
    });
    expect(response.statusCode).toBe(403);
    expect(deps.repository.createInvitation).not.toHaveBeenCalled();
    await server.close();
  });

  it("emails the one-time invitation token without returning it from the API", async () => {
    const deps = dependencies(["members.manage"]);
    const server = await createServer(deps);
    const response = await server.inject({
      method: "POST", url: `/v1/workspaces/${workspaceId}/invitations`,
      headers: { authorization: "Bearer token", "x-sandbox-request-time": new Date().toISOString() },
      payload: { email: "developer@example.com", role: "developer", workspaceIds: [workspaceId], expiresInHours: 24 }
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().delivery).toEqual({ status: "sent" });
    expect(response.body).not.toContain("token=");
    expect(deps.email.sendInvitation).toHaveBeenCalledWith(expect.objectContaining({ recipient: "developer@example.com", invitationUrl: expect.stringContaining("token=") }));
    await server.close();
  });

  it("returns a secure manual invitation link when email delivery is unavailable", async () => {
    const deps = dependencies(["members.manage"]);
    vi.mocked(deps.email.sendInvitation).mockRejectedValueOnce(new Error("provider unavailable"));
    const server = await createServer(deps);
    const response = await server.inject({
      method: "POST", url: `/v1/workspaces/${workspaceId}/invitations`,
      headers: { authorization: "Bearer token", "x-sandbox-request-time": new Date().toISOString() },
      payload: { email: "developer@example.com", role: "developer", workspaceIds: [workspaceId], expiresInHours: 24 }
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ delivery: { status: "manual", invitationUrl: expect.stringMatching(/^https:\/\/app\.sandbox\.test\/invitations\/accept\?token=.+/) } });
    expect(response.json().delivery.invitationUrl).not.toContain("provider unavailable");
    await server.close();
  });

  it("rejects stale privileged requests", async () => {
    const deps = dependencies(["members.manage"]);
    const server = await createServer(deps);
    const response = await server.inject({
      method: "POST", url: `/v1/workspaces/${workspaceId}/invitations`,
      headers: { authorization: "Bearer token", "x-sandbox-request-time": new Date(Date.now() - 10 * 60_000).toISOString() },
      payload: { email: "developer@example.com", role: "developer", workspaceIds: [workspaceId] }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("stale_request");
    await server.close();
  });

  it("preserves the separate client-generated workflow key envelope", async () => {
    const deps = dependencies(["workflows.edit"]);
    const server = await createServer(deps);
    const encryptedPayload = Buffer.alloc(64, 7).toString("base64");
    const payloadKeyEnvelope = Buffer.alloc(60, 9).toString("base64");
    const revision = {
      workflowId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      revisionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      parentRevisionId: null,
      schemaVersion: 3,
      contentHash: `sha256:${"a".repeat(64)}`,
      editorDeviceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      updatedAt: new Date().toISOString(),
      syncState: "local",
      encryption: { algorithm: "aes-256-gcm", keyVersion: 1 },
      encryptedPayload,
      payloadKeyEnvelope,
      searchableMetadata: { name: "Encrypted workflow", folderId: null, requiredPlugins: [], permissionRequirements: [], runnerPolicy: {} }
    };
    const response = await server.inject({ method: "POST", url: `/v1/workspaces/${workspaceId}/sync/revisions`, headers: { authorization: "Bearer token" }, payload: revision });
    expect(response.statusCode).toBe(200);
    expect(deps.repository.appendWorkflowRevision).toHaveBeenCalledWith(session, workspaceId, expect.objectContaining({ encryptedPayload, payloadKeyEnvelope }), expect.any(String));
    expect(payloadKeyEnvelope).not.toBe(encryptedPayload.slice(0, 64));
    await server.close();
  });

  it("creates an immutable upload then runs deterministic automated review", async () => {
    const deps = dependencies([]);
    const publisherId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const reviewId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const versionId = "99999999-9999-4999-8999-999999999999";
    const integrity = `sha256:${"b".repeat(64)}`;
    const submission = { reviewId, pluginVersionId: versionId, publisherPublicId: "com.example.publisher", publisherKeyId: "release-1", pluginId: "com.example.weather", version: "1.0.0", packageIntegrity: integrity, packageSize: 1024, packageObjectKey: `plugins/${publisherId}/package`, status: "draft" };
    vi.mocked(deps.repository.createPluginSubmission).mockResolvedValue(submission);
    vi.mocked(deps.repository.getPluginSubmission).mockResolvedValue(submission);
    vi.mocked(deps.repository.recordAutomatedPluginReview).mockResolvedValue({ ...submission, status: "manual_review" });
    vi.mocked(deps.packageStorage.createUpload).mockResolvedValue({ uploadUrl: "https://objects.example/upload", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    vi.mocked(deps.packageStorage.inspect).mockResolvedValue({ size: 1024, sha256: "b".repeat(64), immutable: true });
    vi.mocked(deps.packageScanner.scan).mockResolvedValue({ passed: true, manifestValid: true, signatureValid: true, integrityValid: true, declaredContentsOnly: true, malwareScan: "clean", capabilityFindings: [], networkFindings: [], dependencyInventory: [], behaviourTests: [{ name: "sandbox", passed: true }], reproducibility: {}, rejectionReasons: [] });
    const server = await createServer(deps);
    const payload = { pluginId: "com.example.weather", name: "Weather", summary: "Weather data", visibility: "public", ownerType: "personal", ownerId: session.accountId, version: "1.0.0", manifestVersion: 1, manifest: { publisherId: "com.example.publisher", pluginId: "com.example.weather", version: "1.0.0", packageIntegrity: integrity }, packageIntegrity: integrity, packageSize: 1024, publisherKeyId: "release-1", minimumHostVersion: ">=0.3.0", maximumHostVersion: null, capabilities: [], networkDomains: [], dependencyInventory: [], reproducibility: {} };
    const initiated = await server.inject({ method: "POST", url: `/v1/publishers/${publisherId}/plugins/submissions`, headers: { authorization: "Bearer token", "x-sandbox-request-time": new Date().toISOString() }, payload });
    expect(initiated.statusCode, initiated.body).toBe(200);
    expect(initiated.json().upload.uploadUrl).toContain("objects.example");
    const finalized = await server.inject({ method: "POST", url: `/v1/publishers/${publisherId}/plugins/submissions/${reviewId}/submit`, headers: { authorization: "Bearer token", "x-sandbox-request-time": new Date().toISOString() } });
    expect(finalized.statusCode, finalized.body).toBe(200);
    expect(finalized.json().submission.status).toBe("manual_review");
    expect(deps.packageScanner.scan).toHaveBeenCalledWith(submission.packageObjectKey, integrity, "com.example.publisher", "release-1");
    await server.close();
  });

  it("allows anonymous public discovery but requires workspace access for private filters", async () => {
    const deps = dependencies(["workflows.view"]);
    const server = await createServer(deps);
    const publicResponse = await server.inject({ method: "GET", url: "/v1/marketplace/plugins?pricing=free&verifiedOnly=true&hostVersion=0.3.0" });
    expect(publicResponse.statusCode, publicResponse.body).toBe(200);
    expect(deps.repository.searchMarketplace).toHaveBeenCalledWith(null, expect.objectContaining({ pricing: "free", verifiedOnly: true, visibility: "public" }));
    const privateResponse = await server.inject({ method: "GET", url: `/v1/marketplace/plugins?visibility=workspace&workspaceId=${workspaceId}` });
    expect(privateResponse.statusCode).toBe(401);
    await server.close();
  });

  it("issues a short-lived free-package grant with the publisher verification key", async () => {
    const deps = dependencies([]);
    const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.alloc(32, 4)]).toString("base64");
    vi.mocked(deps.repository.getMarketplacePackage).mockResolvedValue({ pluginId: "com.example.weather", version: "1.0.0", packageIntegrity: `sha256:${"c".repeat(64)}`, packageSize: 1024, packageObjectKey: "plugins/weather", publisherPublicId: "com.example.publisher", publisherKeyId: "release-1", publisherPublicKeyDerBase64: der, pricingModel: "free" });
    vi.mocked(deps.packageStorage.createDownload).mockResolvedValue({ downloadUrl: "https://objects.example/download?signature=short-lived", expiresAt: new Date(Date.now()+300_000).toISOString() });
    const server = await createServer(deps);
    const response = await server.inject({ method: "GET", url: "/v1/marketplace/plugins/com.example.weather/install" });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().publisher.publicKeyPem).toContain("BEGIN PUBLIC KEY");
    expect(response.json().download.downloadUrl).toContain("signature=short-lived");
    await server.close();
  });

  it("pairs a runner only after workspace authorization and proof of possession", async () => {
    const deps = dependencies(["runners.manage"]);
    const challengeId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const runnerId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.alloc(32, 9)]).toString("base64");
    vi.mocked(deps.repository.createRunnerPairingChallenge).mockResolvedValue({ challengeId, challenge: "challenge-value-with-enough-entropy-123", expiresAt: new Date(Date.now()+600_000).toISOString() });
    vi.mocked(deps.repository.confirmRunnerPairing).mockResolvedValue({ runnerId, displayName: "Studio PC", workspaceId, operatingSystem: "windows", architecture: "x86_64", applicationVersion: "0.3.0", protocolVersion: 1, pluginRuntimeVersion: "0.3.0", capabilities: {}, safeFolderLabels: [], browserEngine: null, installedPluginVersions: [], tags: ["studio"], status: "offline", currentWorkload: 0, pairedAt: new Date().toISOString(), lastSeenAt: null });
    const server = await createServer(deps);
    const started = await server.inject({ method: "POST", url: "/v1/runners/pairing/challenges", headers: { authorization: "Bearer token", "x-sandbox-request-time": new Date().toISOString() }, payload: { devicePublicKeyDerBase64: der, operatingSystem: "windows", architecture: "x86_64", applicationVersion: "0.3.0", protocolVersion: 1, pluginRuntimeVersion: "0.3.0", capabilities: {}, tags: ["studio"] } });
    expect(started.statusCode, started.body).toBe(200);
    const confirmed = await server.inject({ method: "POST", url: "/v1/runners/pairing/confirm", headers: { authorization: "Bearer token", "x-sandbox-request-time": new Date().toISOString() }, payload: { challengeId, challenge: started.json().challenge, signatureBase64: Buffer.alloc(64, 3).toString("base64"), workspaceId, displayName: "Studio PC" } });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(deps.repository.confirmRunnerPairing).toHaveBeenCalledWith(session, expect.objectContaining({ workspaceId, displayName: "Studio PC" }), expect.any(String));
    await server.close();
  });

  it("accepts a workspace-scoped runner pairing token and rejects unrelated API keys", async () => {
    const deps = dependencies(["runners.manage"]);
    const challengeId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.alloc(32, 8)]).toString("base64");
    vi.mocked(deps.repository.createRunnerPairingChallenge).mockResolvedValue({ challengeId, challenge: "challenge-value-with-enough-entropy-123", expiresAt: new Date(Date.now()+600_000).toISOString() });
    vi.mocked(deps.sessions.verify).mockResolvedValue({ ...session, principalType: "personal_access_token", credentialScopes: ["runners.manage"], workspaceRestrictions: [workspaceId] });
    const server = await createServer(deps);
    const payload = { devicePublicKeyDerBase64: der, operatingSystem: "linux", architecture: "x86_64", applicationVersion: "0.8.0-beta.1", protocolVersion: 2, pluginRuntimeVersion: "0.8.0-beta.1", capabilities: {}, tags: ["self-hosted"] };
    const accepted = await server.inject({ method: "POST", url: "/v1/runners/pairing/challenges", headers: { authorization: "Bearer pairing-token", "x-sandbox-request-time": new Date().toISOString() }, payload });
    expect(accepted.statusCode, accepted.body).toBe(200);
    vi.mocked(deps.sessions.verify).mockResolvedValue({ ...session, principalType: "personal_access_token", credentialScopes: ["workflows.view"], workspaceRestrictions: [workspaceId] });
    const rejected = await server.inject({ method: "POST", url: "/v1/runners/pairing/challenges", headers: { authorization: "Bearer unrelated-token", "x-sandbox-request-time": new Date().toISOString() }, payload });
    expect(rejected.statusCode, rejected.body).toBe(403);
    expect(rejected.json().error.code).toBe("runner_pairing_principal_required");
    await server.close();
  });

  it("creates signed expiring idempotent commands for an exact workflow revision", async () => {
    const deps = dependencies(["workflows.run"]);
    const targetRunnerId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const revisionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const environmentId="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    vi.mocked(deps.repository.listWorkspaceEnvironments).mockResolvedValue([{environmentId,environment:"production"}]);
    vi.mocked(deps.repository.createRunnerCommand).mockImplementation(async (_actor, command) => ({ ...command, issuerAccountId: session.accountId, status: "queued" }));
    const server = await createServer(deps);
    const response = await server.inject({ method: "POST", url: `/v1/workspaces/${workspaceId}/runner-commands`, headers: { authorization: "Bearer token", "x-sandbox-request-time": new Date().toISOString() }, payload: { targetRunnerId,environmentId, action: "run_workflow", workflowRevisionId: revisionId, payload: { trigger: "remote" }, idempotencyKey: "remote-run-unique-0001", expiresInSeconds: 300 } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().command).toMatchObject({ workspaceId, targetRunnerId, workflowRevisionId: revisionId, keyId: "control-plane-1", status: "queued",authorizationContext:{principalType:"user",principalId:session.accountId,requiredPermission:"workflows.run",environmentId,environment:"production"} });
    expect(response.json().command.signature).toBeTruthy();
    await server.close();
  });

  it("rejects runner commands outside a token's environment restriction",async()=>{
    const deps=dependencies(["workflows.run"]),environmentId="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    vi.mocked(deps.sessions.verify).mockResolvedValue({...session,principalType:"personal_access_token",principalId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",credentialScopes:["workflows.run"],workspaceRestrictions:[workspaceId],environmentRestrictions:["eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"]});
    const server=await createServer(deps),response=await server.inject({method:"POST",url:`/v1/workspaces/${workspaceId}/runner-commands`,headers:{authorization:"Bearer token","x-sandbox-request-time":new Date().toISOString()},payload:{targetRunnerId:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",environmentId,action:"run_workflow",workflowRevisionId:"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",idempotencyKey:"remote-run-restricted-0001"}});
    expect(response.statusCode).toBe(403);expect(response.json().error.code).toBe("credential_environment_restricted");expect(deps.repository.createRunnerCommand).not.toHaveBeenCalled();await server.close();
  });

  it("keeps draft approval and publication as explicit authorized transitions", async () => {
    const deps = dependencies(["workflows.edit", "workflows.approve", "workflows.publish"]);
    const workflowId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const revisionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const approvalId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const createdAt = new Date().toISOString();
    vi.mocked(deps.repository.requestWorkflowApproval).mockResolvedValue({ approvalId, workflowId, revisionId, status: "pending", requiredApprovals: 1, approvalCount: 0, createdAt });
    vi.mocked(deps.repository.decideWorkflowApproval).mockResolvedValue({ approvalId, workflowId, revisionId, status: "approved", requiredApprovals: 1, approvalCount: 1, createdAt });
    vi.mocked(deps.repository.publishWorkflowRevision).mockResolvedValue({ workflowId, publishedRevisionId: revisionId, previousPublishedRevisionId: null });
    const server = await createServer(deps);
    const headers = { authorization: "Bearer token", "x-sandbox-request-time": new Date().toISOString() };
    const requested = await server.inject({ method: "POST", url: `/v1/workspaces/${workspaceId}/workflows/${workflowId}/revisions/${revisionId}/request-approval`, headers });
    expect(requested.statusCode, requested.body).toBe(200);
    const decided = await server.inject({ method: "POST", url: `/v1/workspaces/${workspaceId}/workflow-approvals/${approvalId}/decision`, headers, payload: { decision: "approved" } });
    expect(decided.statusCode, decided.body).toBe(200);
    const published = await server.inject({ method: "POST", url: `/v1/workspaces/${workspaceId}/workflows/${workflowId}/revisions/${revisionId}/publish`, headers, payload: { changeSummary: "Approved production revision" } });
    expect(published.statusCode, published.body).toBe(200);
    expect(deps.repository.publishWorkflowRevision).toHaveBeenCalledWith(session, workspaceId, workflowId, revisionId, "Approved production revision", expect.any(String));
    await server.close();
  });

  it("returns an actionable governance failure when remote execution is disabled", async () => {
    const deps = dependencies(["workflows.run"]);
    const environmentId="cccccccc-cccc-4ccc-8ccc-cccccccccccc";vi.mocked(deps.repository.listWorkspaceEnvironments).mockResolvedValue([{environmentId,environment:"production"}]);
    vi.mocked(deps.repository.getGovernancePolicies).mockResolvedValue({ remote_execution: false });
    const server = await createServer(deps);
    const response = await server.inject({ method: "POST", url: `/v1/workspaces/${workspaceId}/runner-commands`, headers: { authorization: "Bearer token", "x-sandbox-request-time": new Date().toISOString() }, payload: { targetRunnerId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",environmentId, action: "run_workflow", workflowRevisionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", idempotencyKey: "remote-run-unique-0002" } });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toMatch(/remote_execution.*administrator.*local runner/i);
    expect(deps.repository.createRunnerCommand).not.toHaveBeenCalled();
    await server.close();
  });

  it("requires the distinct owner-management permission when assigning an owner", async () => {
    const deps = dependencies(["members.manage"]);
    const server = await createServer(deps);
    const response = await server.inject({ method: "PUT", url: `/v1/workspaces/${workspaceId}/members/33333333-3333-4333-8333-333333333333/role`, headers: { authorization: "Bearer token", "x-sandbox-request-time": new Date().toISOString() }, payload: { role: "owner" } });
    expect(response.statusCode).toBe(403);
    expect(deps.repository.updateWorkspaceMemberRole).not.toHaveBeenCalled();
    await server.close();
  });

  it("rejects stale runner device requests before reading commands", async () => {
    const deps = dependencies([]);
    const server = await createServer(deps);
    const response = await server.inject({ method: "GET", url: "/v1/runner/commands", headers: { "x-sandbox-runner-id": "dddddddd-dddd-4ddd-8ddd-dddddddddddd", "x-sandbox-key-id": "device-1", "x-sandbox-request-time": new Date(Date.now()-10*60_000).toISOString(), "x-sandbox-request-nonce": "request-nonce-0001", "x-sandbox-signature": Buffer.alloc(64).toString("base64") } });
    expect(response.statusCode).toBe(400);
    expect(deps.repository.authenticateRunnerRequest).not.toHaveBeenCalled();
    await server.close();
  });

  it("persists runner trigger events before acknowledging and rejects secret material", async () => {
    const deps=dependencies([]),runnerId="dddddddd-dddd-4ddd-8ddd-dddddddddddd",deploymentId="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",revisionId="ffffffff-ffff-4fff-8fff-ffffffffffff",eventId="12345678-1234-4234-8234-123456789abc";
    vi.mocked(deps.repository.authenticateRunnerRequest).mockResolvedValue({runnerId,accountId:session.accountId,workspaceId,keyId:"device-1"});
    vi.mocked(deps.repository.recordRunnerTriggerEvents).mockResolvedValue({acceptedEventIds:[eventId],duplicateEventIds:[]});
    const server=await createServer(deps),headers={"x-sandbox-runner-id":runnerId,"x-sandbox-key-id":"device-1","x-sandbox-request-time":new Date().toISOString(),"x-sandbox-request-nonce":"trigger-event-nonce-0001","x-sandbox-signature":Buffer.alloc(64,7).toString("base64")};
    const event={eventId,deploymentId,workflowRevisionId:revisionId,nodeId:"github-trigger",pluginId:"com.sndbox.github",pluginVersion:"1.0.0",dedupeKey:"run:42:attempt:2",occurredAt:new Date().toISOString(),payload:{runId:42,conclusion:"success"},providerCheckpoint:{completedAt:new Date().toISOString()}};
    const accepted=await server.inject({method:"POST",url:"/v1/runner/trigger-events",headers,payload:{events:[event]}});
    expect(accepted.statusCode,accepted.body).toBe(200);expect(accepted.json()).toEqual({acceptedEventIds:[eventId],duplicateEventIds:[]});expect(deps.repository.recordRunnerTriggerEvents).toHaveBeenCalledWith(expect.objectContaining({runnerId}),[event]);
    const rejected=await server.inject({method:"POST",url:"/v1/runner/trigger-events",headers:{...headers,"x-sandbox-request-nonce":"trigger-event-nonce-0002"},payload:{events:[{...event,eventId:"22345678-1234-4234-8234-123456789abc",payload:{accessToken:"must-not-persist"}}]}});
    expect(rejected.statusCode).toBe(400);expect(rejected.json().error.code).toBe("trigger_event_sensitive_data");expect(deps.repository.recordRunnerTriggerEvents).toHaveBeenCalledTimes(1);
    await server.close();
  });

  it("rejects raw secret fields when creating a shared connection", async () => {
    const deps = dependencies(["connections.manage"]);
    const server = await createServer(deps);
    const response = await server.inject({ method: "POST", url: `/v1/workspaces/${workspaceId}/connections`, headers: { authorization: "Bearer token", "x-sandbox-request-time": new Date().toISOString() }, payload: { environmentId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", provider: "gmail", displayName: "Company Gmail", grantedScopes: ["gmail.readonly"], deploymentMode: "authorize_per_runner", accessToken: "must-never-enter-this-api" } });
    expect(response.statusCode).toBe(400);
    expect(deps.repository.createSharedConnection).not.toHaveBeenCalled();
    await server.close();
  });

  it("creates Stripe-hosted checkout without accepting card data", async () => {
    const deps = dependencies([]);
    vi.mocked(deps.repository.getPluginBillingPlan).mockResolvedValue({ pluginId: "com.example.weather", planId: "pro", stripePriceId: "price_123", mode: "subscription", offlineGraceDays: 7, seatAllowance: 5, customerId: null });
    vi.mocked(deps.billing.createCheckout).mockResolvedValue({ checkoutId: "cs_test_123", url: "https://checkout.stripe.com/c/pay/test", expiresAt: new Date(Date.now()+1800_000).toISOString() });
    const server = await createServer(deps);
    const response = await server.inject({ method: "POST", url: "/v1/marketplace/plugins/com.example.weather/checkout", headers: { authorization: "Bearer token", "x-sandbox-request-time": new Date().toISOString() }, payload: { ownerType: "personal", ownerId: session.accountId, planId: "pro" } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().checkout.url).toContain("checkout.stripe.com");
    expect(deps.billing.createCheckout).toHaveBeenCalledWith(expect.objectContaining({ priceId: "price_123", mode: "subscription" }));
    expect(deps.repository.recordMarketplaceCheckout).toHaveBeenCalledWith(session, "cs_test_123", "personal", session.accountId, "com.example.weather", "pro", expect.any(String));
    await server.close();
  });

  it("publishes configured product plans and starts account-owned checkout", async () => {
    const deps=dependencies([]);
    const productCommerce={
      listPublishedPlans:vi.fn(async()=>[{id:"pro",displayName:"Pro",audience:"individual" as const,description:"Hosted execution for individuals",price:{currency:"gbp",unitAmount:1900,interval:"month" as const},includedUsage:{hostedRunnerSeconds:3600},entitlements:{workflowSync:true},seatAllowance:1,offlineGraceDays:14,localExecutionUnmetered:true as const,overagePolicy:"spending_limit" as const}]),
      accountSummary:vi.fn(),
      createCheckout:vi.fn(async()=>({checkoutId:"cs_product_123",url:"https://checkout.stripe.com/c/pay/product",expiresAt:new Date(Date.now()+1800_000).toISOString()})),
      applyBillingEvent:vi.fn(async()=>false),
    };
    const server=await createServer({...deps,productCommerce});
    const plans=await server.inject({method:"GET",url:"/v1/product-plans"});
    expect(plans.statusCode,plans.body).toBe(200);expect(plans.json().items[0]).toMatchObject({id:"pro",price:{unitAmount:1900},localExecutionUnmetered:true});
    const checkout=await server.inject({method:"POST",url:"/v1/product-checkout",headers:{authorization:"Bearer token","x-sandbox-request-time":new Date().toISOString()},payload:{ownerType:"personal",ownerId:session.accountId,planId:"pro"}});
    expect(checkout.statusCode,checkout.body).toBe(200);expect(checkout.json().checkout.url).toContain("checkout.stripe.com");
    expect(productCommerce.createCheckout).toHaveBeenCalledWith(session,"personal",session.accountId,"pro",deps.billing,"https://app.sandbox.test");
    await server.close();
  });

  it("accepts a signed webhook once and queues only encrypted redacted payload", async () => {
    const deps = dependencies([]);
    const publicId = "abcdefghijklmnopqrstuvwxABCDEFGH";
    const secret = Buffer.alloc(32, 6);
    vi.mocked(deps.repository.getWebhookEndpointByPublicId).mockResolvedValue({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", publicId, workspaceId, workflowId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", signingSecretCiphertext: deps.webhookProtector.encrypt(secret), allowedMethods: ["POST"], schema: { type: "object", required: ["event"] }, maximumRequestBytes: 1024, rateLimitPerMinute: 10, retentionSeconds: 3600, runnerPolicy: {}, offlineExpirySeconds: 900, redactedFields: ["user.token"], disabled: false });
    vi.mocked(deps.repository.enqueueWebhookDelivery).mockResolvedValue({ status: "queued", expiresAt: new Date(Date.now()+900_000).toISOString() });
    const server = await createServer(deps);
    const body = Buffer.from(JSON.stringify({ event: "created", user: { token: "secret" } })); const timestamp = new Date().toISOString(); const nonce = "unique-webhook-nonce-1";
    const response = await server.inject({ method: "POST", url: `/hooks/${publicId}`, headers: { "content-type": "application/json", "x-sandbox-webhook-timestamp": timestamp, "x-sandbox-webhook-nonce": nonce, "x-sandbox-webhook-signature": webhookSignature(secret, timestamp, nonce, body) }, payload: body });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().execution).toBe("waiting_for_local_runner");
    const encrypted = vi.mocked(deps.repository.enqueueWebhookDelivery).mock.calls[0][4];
    expect(deps.webhookProtector.decrypt(encrypted).toString()).toContain("[REDACTED]");
    expect(deps.webhookProtector.decrypt(encrypted).toString()).not.toContain("secret");
    await server.close();
  });

  it("encrypts secret environment values before persistence and omits the value from the response", async () => {
    const deps = dependencies(["connections.manage"]); const environmentId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"; const workflowId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    vi.mocked(deps.repository.upsertProtectedVariable).mockImplementation(async (_actor, _workspace, environment, name, valueType, isSecret, _ciphertext, nonSecretValue, description, allowedWorkflowIds) => ({ id: "ffffffff-ffff-4fff-8fff-ffffffffffff", environmentId: environment, name, valueType, isSecret, nonSecretValue, description, allowedWorkflowIds, changedBy: session.accountId, changedAt: new Date().toISOString() }));
    const server = await createServer(deps);
    const response = await server.inject({ method: "PUT", url: `/v1/workspaces/${workspaceId}/environments/${environmentId}/variables/API_KEY`, headers: { authorization: "Bearer token", "x-sandbox-request-time": new Date().toISOString() }, payload: { valueType: "string", isSecret: true, value: "top-secret", description: "Provider key", allowedWorkflowIds: [workflowId] } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).not.toContain("top-secret");
    const call = vi.mocked(deps.repository.upsertProtectedVariable).mock.calls[0];
    expect(call[6]).toBeInstanceOf(Buffer); expect(call[7]).toBeNull(); expect(call[6]?.toString()).not.toContain("top-secret");
    await server.close();
  });

  it("creates a deployment only from a successful exact preflight", async () => {
    const workflowId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",revisionId="cccccccc-cccc-4ccc-8ccc-cccccccccccc",environmentId="dddddddd-dddd-4ddd-8ddd-dddddddddddd",runnerId="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",deploymentId="ffffffff-ffff-4fff-8fff-ffffffffffff",permissionSnapshotId="99999999-9999-4999-8999-999999999999",now=new Date().toISOString();
    const deps=dependencies(["deployments.manage"]);
    vi.mocked(deps.repository.createDeployment).mockResolvedValue({deploymentId,workspaceId,workflowId,workflowRevisionId:revisionId,environmentId,environment:"production",target:"managed_cloud_runner",targetRunnerId:null,runnerPoolId:null,region:"eu-west-2",requiredConnectionIds:[],requiredPlugins:[],permissionSnapshotId,status:"active",validation:{valid:true},usageEstimate:{periodDays:30,expectedExecutions:1,hostedExecutionSeconds:30,browserWorkerSeconds:0,expectedConcurrentExecutions:1,retryMultiplier:1,confidence:"low",basis:["manual run"],disclaimer:"Estimate only; actual usage and cost may differ."},createdBy:session.accountId,createdAt:now,activatedAt:now,supersedesDeploymentId:null});
    const preflight={target:"managed_cloud_runner",region:"eu-west-2",requirements:{protocolVersion:2,engineVersion:"0.7.2-beta.4",pluginRuntimeVersion:"0.7.2-beta.4",runnerTypes:["hosted"],architectures:["x86_64"],workspaceId,environmentId,region:"eu-west-2",requiredTags:[],capabilities:[{nodeType:"manual",nodeVersions:[1],constraints:{}}],plugins:[],connectionIds:[],minimumAvailableConcurrency:1},nodes:[{nodeId:"trigger",nodeType:"manual",nodeVersion:1,plugin:null,requiresBrowser:false,requiresLocalFile:false,localFileLabel:null,requiredConnectionIds:[],requiredEnvironmentVariables:[],networkTargets:[],approvalRequired:false}],graphIssues:[],availableRunners:[{runnerId,keyId:"hosted-1",runnerType:"hosted",protocolVersion:2,engineVersion:"0.7.2-beta.4",pluginRuntimeVersion:"0.7.2-beta.4",architecture:"x86_64",operatingSystem:"linux",workspaceId,environmentId,region:"eu-west-2",tags:[],concurrencyLimit:10,maintenanceState:"active",nodeCapabilities:[{nodeType:"manual",nodeVersions:[1],constraints:{}}],plugins:[],connections:[]}],availableConnectionIds:[],availableEnvironmentVariables:[],approvedNetworkTargets:[],approvedPluginPackages:[],approvalSnapshotPresent:true,concurrencyLimit:1,retentionDays:30,estimatedUsage:{periodDays:30,expectedExecutions:1,hostedExecutionSeconds:30,browserWorkerSeconds:0,expectedConcurrentExecutions:1,retryMultiplier:1,confidence:"low",basis:["manual run"],disclaimer:"Estimate only; actual usage and cost may differ."}};
    const server=await createServer(deps),response=await server.inject({method:"POST",url:`/v1/workspaces/${workspaceId}/deployments`,headers:{authorization:"Bearer token","x-sandbox-request-time":new Date().toISOString()},payload:{workflowId,workflowRevisionId:revisionId,environmentId,targetRunnerId:null,runnerPoolId:null,preflight}});
    expect(response.statusCode,response.body).toBe(201);expect(response.json().deployment).toMatchObject({deploymentId,status:"active"});expect(deps.repository.createDeployment).toHaveBeenCalledWith(session,workspaceId,expect.objectContaining({workflowId,workflowRevisionId:revisionId,target:"managed_cloud_runner",validation:expect.objectContaining({valid:true})}),expect.any(String));await server.close();
  });

  it("starts and reads a versioned run through the public API",async()=>{
    const workflowId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",revisionId="cccccccc-cccc-4ccc-8ccc-cccccccccccc",environmentId="dddddddd-dddd-4ddd-8ddd-dddddddddddd",deploymentId="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",permissionSnapshotId="ffffffff-ffff-4fff-8fff-ffffffffffff",runId="99999999-9999-4999-8999-999999999999",now=new Date().toISOString();
    const requirements={protocolVersion:2 as const,engineVersion:"0.7.2-beta.4",pluginRuntimeVersion:"0.7.2-beta.4",runnerTypes:["hosted" as const],architectures:["x86_64" as const],workspaceId,environmentId,region:"eu-west-2",requiredTags:[],capabilities:[],plugins:[],connectionIds:[],minimumAvailableConcurrency:1};
    const run={runId,workspaceId,environmentId,deploymentId,workflowId,workflowRevisionId:revisionId,status:"queued" as const,outcomeCertainty:"certain" as const,assignedRunnerId:null,trigger:"api",queuedAt:now,startedAt:null,completedAt:null,timeoutAt:new Date(Date.now()+60_000).toISOString(),evidence:[]};
    const executionCoordinator={resolvePublicRunDeployment:vi.fn(async()=>({workspaceId,environmentId,deploymentId,workflowId,workflowRevisionId:revisionId,runnerPoolId:null,permissionSnapshotId,pluginVersions:[],connectionReferences:[],requirements,targetType:"this_computer" as const})),enqueue:vi.fn(async()=>({executionId:runId,created:true})),getPublicRun:vi.fn(async()=>run)};
    const server=await createServer({...dependencies(["workflows.run","executions.view_detail"]),executionCoordinator});
    const started=await server.inject({method:"POST",url:`/v1/workflows/${workflowId}/runs`,headers:{authorization:"Bearer token","x-sandbox-request-time":new Date().toISOString(),"idempotency-key":"public-run-request-0001"},payload:{workspaceId,deploymentId,encryptedPayloadReference:"object://encrypted/revision"}});
    expect(started.statusCode,started.body).toBe(202);expect(started.headers.location).toBe(`/v1/runs/${runId}`);expect(started.json().run).toMatchObject({runId,status:"queued",workflowRevisionId:revisionId});expect(executionCoordinator.enqueue).toHaveBeenCalledWith(expect.objectContaining({workflowId,workflowRevisionId:revisionId,idempotencyKey:"public-run-request-0001"}),true);
    const read=await server.inject({method:"GET",url:`/v1/runs/${runId}`,headers:{authorization:"Bearer token"}});expect(read.statusCode,read.body).toBe(200);expect(read.json().run).toMatchObject({runId,evidence:[]});await server.close();
  });

  it("limits organisation security administration to owners", async () => {
    const organisationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const roleId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const deps = dependencies([]);
    vi.mocked(deps.repository.listAccountOrganisations).mockResolvedValue([{ id: organisationId, name: "Acme", slug: "acme", role: "owner", createdAt: new Date().toISOString(), workspaces: [] }]);
    vi.mocked(deps.repository.createOrganisationRole).mockResolvedValue({ id: roleId, organisationId, key: "auditor", displayName: "Auditor", builtIn: false, permissions: ["audit.view"] });
    const server = await createServer(deps);
    const response = await server.inject({ method: "POST", url: `/v1/organisations/${organisationId}/roles`, headers: { authorization: "Bearer token", "x-sandbox-request-time": new Date().toISOString() }, payload: { key: "auditor", displayName: "Auditor", permissions: ["audit.view"] } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().role).toMatchObject({ id: roleId, key: "auditor", builtIn: false });
    expect(deps.repository.createOrganisationRole).toHaveBeenCalledWith(session, organisationId, "auditor", "Auditor", ["audit.view"], expect.any(String));
    await server.close();

    const deniedDeps = dependencies([]);
    vi.mocked(deniedDeps.repository.listAccountOrganisations).mockResolvedValue([{ id: organisationId, name: "Acme", slug: "acme", role: "administrator", createdAt: new Date().toISOString(), workspaces: [] }]);
    const deniedServer = await createServer(deniedDeps);
    const denied = await deniedServer.inject({ method: "GET", url: `/v1/organisations/${organisationId}/roles`, headers: { authorization: "Bearer token" } });
    expect(denied.statusCode).toBe(403);
    expect(deniedDeps.repository.listOrganisationRoles).not.toHaveBeenCalled();
    await deniedServer.close();
  });

  it("provisions SCIM users with a scoped bearer credential", async () => {
    const organisationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const tokenId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const provisioningAccountId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const userId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const token = `sbx_scim_0123456789ab.${"A".repeat(43)}`;
    const deps = dependencies([]);
    vi.mocked(deps.repository.authenticateScimToken).mockResolvedValue({ organisationId, tokenId, provisioningAccountId });
    vi.mocked(deps.repository.upsertScimUser).mockResolvedValue({ id: userId, organisationId, accountId: "ffffffff-ffff-4fff-8fff-ffffffffffff", externalId: "idp-123", userName: "analyst@example.com", displayName: "Example Analyst", active: true, role: "developer", workspaceIds: [workspaceId], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const server = await createServer(deps);
    const response = await server.inject({ method: "POST", url: "/scim/v2/Users", headers: { authorization: `Bearer ${token}` }, payload: { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User", "urn:sandbox:params:scim:schemas:extension:1.0:User"], externalId: "idp-123", userName: "analyst@example.com", displayName: "Example Analyst", active: true, "urn:sandbox:params:scim:schemas:extension:1.0:User": { role: "developer", workspaceIds: [workspaceId] } } });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.headers.location).toBe(`/scim/v2/Users/${userId}`);
    expect(response.json()).toMatchObject({ id: userId, userName: "analyst@example.com", active: true, "urn:sandbox:params:scim:schemas:extension:1.0:User": { role: "developer", workspaceIds: [workspaceId] } });
    expect(deps.repository.authenticateScimToken).toHaveBeenCalledWith(expect.any(Buffer));
    expect(deps.repository.upsertScimUser).toHaveBeenCalledWith(organisationId, provisioningAccountId, null, { externalId: "idp-123", userName: "analyst@example.com", displayName: "Example Analyst", active: true, role: "developer", workspaceIds: [workspaceId] });
    expect(deps.sessions.verify).not.toHaveBeenCalled();
    await server.close();
  });

  it("streams bounded audit events as newline-delimited JSON", async () => {
    const deps = dependencies(["audit.view"]);
    const eventId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const correlationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    vi.mocked(deps.repository.listAuditEvents).mockResolvedValue({ items: [{ eventId, timestamp: new Date().toISOString(), actorAccountId: session.accountId, workspaceId, action: "organisation.role.created", resourceType: "organisation_role", resourceId: "auditor", beforeSummary: null, afterSummary: { permissions: ["audit.view"] }, sourceDeviceId: null, correlationId }], nextCursor: eventId });
    const server = await createServer(deps);
    const response = await server.inject({ method: "GET", url: `/v1/workspaces/${workspaceId}/audit/stream?limit=1`, headers: { authorization: "Bearer token" } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["content-type"]).toContain("application/x-ndjson");
    expect(response.headers["x-next-cursor"]).toBe(eventId);
    expect(response.body.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(response.body)).toMatchObject({ eventId, action: "organisation.role.created" });
    await server.close();
  });
});
