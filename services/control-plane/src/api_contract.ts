import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { WebhookProtector } from "./webhook_crypto.js";

export interface StoredApiResponse {
  statusCode: number;
  body: unknown;
  contentType: string | null;
  location: string | null;
}

export type IdempotencyClaim =
  | { outcome: "execute"; ownerToken: string }
  | { outcome: "replay"; response: StoredApiResponse }
  | { outcome: "conflict" }
  | { outcome: "in_progress" };

export interface ApiIdempotencyStore {
  claim(scope: string, key: string, requestHash: string): Promise<IdempotencyClaim>;
  complete(scope: string, key: string, ownerToken: string, response: StoredApiResponse): Promise<void>;
  abandon(scope: string, key: string, ownerToken: string): Promise<void>;
}

interface MemoryRecord {
  requestHash: string;
  ownerToken: string;
  response: StoredApiResponse | null;
  expiresAt: number;
}

export class MemoryApiIdempotencyStore implements ApiIdempotencyStore {
  private readonly records = new Map<string, MemoryRecord>();

  async claim(scope: string, key: string, requestHash: string): Promise<IdempotencyClaim> {
    const recordKey = `${scope}\0${key}`;
    const existing = this.records.get(recordKey);
    if (existing && existing.expiresAt > Date.now()) {
      if (existing.requestHash !== requestHash) return { outcome: "conflict" };
      return existing.response ? { outcome: "replay", response: existing.response } : { outcome: "in_progress" };
    }
    const ownerToken = randomUUID();
    this.records.set(recordKey, { requestHash, ownerToken, response: null, expiresAt: Date.now() + 24 * 60 * 60_000 });
    return { outcome: "execute", ownerToken };
  }

  async complete(scope: string, key: string, ownerToken: string, response: StoredApiResponse): Promise<void> {
    const record = this.records.get(`${scope}\0${key}`);
    if (record?.ownerToken === ownerToken) record.response = structuredClone(response);
  }

  async abandon(scope: string, key: string, ownerToken: string): Promise<void> {
    const recordKey = `${scope}\0${key}`;
    if (this.records.get(recordKey)?.ownerToken === ownerToken) this.records.delete(recordKey);
  }
}

export class PostgresApiIdempotencyStore implements ApiIdempotencyStore {
  private nextPruneAt = 0;
  constructor(private readonly pool: Pool, private readonly protector: WebhookProtector) {}

  async claim(scope: string, key: string, requestHash: string): Promise<IdempotencyClaim> {
    if (Date.now() >= this.nextPruneAt) {
      this.nextPruneAt = Date.now() + 60 * 60_000;
      await this.pool.query(`DELETE FROM api_idempotency_records WHERE ctid IN (SELECT ctid FROM api_idempotency_records WHERE expires_at<=now() ORDER BY expires_at LIMIT 1000)`);
    }
    const ownerToken = randomUUID();
    const claimed = await this.pool.query<{ owner_token: string }>(
      `INSERT INTO api_idempotency_records(actor_scope,idempotency_key,request_hash,owner_token,state,expires_at)
       VALUES($1,$2,$3,$4,'processing',now()+interval '24 hours')
       ON CONFLICT(actor_scope,idempotency_key) DO UPDATE SET
         request_hash=excluded.request_hash,owner_token=excluded.owner_token,state='processing',
         response_ciphertext=NULL,expires_at=excluded.expires_at,updated_at=now()
       WHERE api_idempotency_records.expires_at<=now()
       RETURNING owner_token`,
      [scope, key, requestHash, ownerToken]
    );
    if (claimed.rowCount && claimed.rows[0].owner_token === ownerToken) return { outcome: "execute", ownerToken };
    const existing = await this.pool.query<{ request_hash: string; state: string; response_ciphertext: Buffer | null }>(
      `SELECT request_hash,state,response_ciphertext FROM api_idempotency_records WHERE actor_scope=$1 AND idempotency_key=$2`,
      [scope, key]
    );
    const record = existing.rows[0];
    if (!record || record.request_hash !== requestHash) return { outcome: "conflict" };
    if (record.state !== "completed" || !record.response_ciphertext) return { outcome: "in_progress" };
    const response = JSON.parse(this.protector.decrypt(record.response_ciphertext).toString("utf8")) as StoredApiResponse;
    return { outcome: "replay", response };
  }

  async complete(scope: string, key: string, ownerToken: string, response: StoredApiResponse): Promise<void> {
    const ciphertext = this.protector.encrypt(Buffer.from(JSON.stringify(response), "utf8"));
    await this.pool.query(
      `UPDATE api_idempotency_records SET state='completed',response_ciphertext=$4,updated_at=now()
       WHERE actor_scope=$1 AND idempotency_key=$2 AND owner_token=$3 AND state='processing'`,
      [scope, key, ownerToken, ciphertext]
    );
  }

  async abandon(scope: string, key: string, ownerToken: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM api_idempotency_records WHERE actor_scope=$1 AND idempotency_key=$2 AND owner_token=$3 AND state='processing'`,
      [scope, key, ownerToken]
    );
  }
}

export function apiActorScope(authorization: string | undefined, runnerId: string | undefined, ip: string): string {
  const identity = authorization ? `authorization:${authorization}` : runnerId ? `runner:${runnerId}` : `anonymous:${ip}`;
  return `sha256:${createHash("sha256").update(identity).digest("hex")}`;
}

export function apiRequestHash(method: string, url: string, contentType: string | undefined, body: unknown): string {
  const canonical = JSON.stringify({ method: method.toUpperCase(), url, contentType: contentType ?? null, body: canonicalValue(body) });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object" && !Buffer.isBuffer(value)) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalValue(item)]));
  }
  if (Buffer.isBuffer(value)) return { base64: value.toString("base64") };
  return value ?? null;
}

export interface ApiRouteDescription { method: string; url: string }

export function buildOpenApiDocument(routes: ApiRouteDescription[]): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routes
    .filter(route => route.method !== "HEAD" && (["/health", "/ready"].includes(route.url) || route.url.startsWith("/v1/")))
    .sort((left, right) => left.url.localeCompare(right.url) || left.method.localeCompare(right.method))) {
    const path = route.url.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
    const method = route.method.toLowerCase();
    const mutation = ["post", "put", "patch", "delete"].includes(method);
    const idempotencySupported=mutation&&path!=="/v1/service-account-assertions/token";
    const parameters: unknown[] = [...path.matchAll(/\{([^}]+)\}/g)].map(match => ({ name: match[1], in: "path", required: true, schema: { type: "string" } }));
    parameters.push({ $ref: "#/components/parameters/CorrelationId" });
    if (method === "get" && path.endsWith("/collaboration/sessions/{sessionId}/operations")) {
      parameters.push(
        { name: "after", in: "query", required: false, schema: { type: "integer", minimum: 0, default: 0 }, description: "Return operations after this server sequence." },
        { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
      );
    }
    if (idempotencySupported) parameters.push({ $ref: "#/components/parameters/IdempotencyKey" });
    const operation: Record<string, unknown> = {
      operationId: `${method}_${path.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "")}`,
      tags: [path.split("/").filter(Boolean)[1] ?? "service"],
      parameters,
      "x-sandbox-stability": "stable",
      "x-sandbox-idempotency": idempotencySupported ? "supported" : "not-applicable",
      responses: {
        "200": { description: "Successful response.", headers: { "x-correlation-id": { $ref: "#/components/headers/CorrelationId" }, "idempotency-replayed": { $ref: "#/components/headers/IdempotencyReplayed" } }, content: { "application/json": { schema: responseSchema(path, method) } } },
        "400": { $ref: "#/components/responses/ApiError" },
        "401": { $ref: "#/components/responses/ApiError" },
        "403": { $ref: "#/components/responses/ApiError" },
        "404": { $ref: "#/components/responses/ApiError" },
        "409": { $ref: "#/components/responses/ApiError" },
        "429": { $ref: "#/components/responses/RateLimited" },
        "503": { $ref: "#/components/responses/ApiError" },
        "500": { $ref: "#/components/responses/ApiError" }
      }
    };
    if (path === "/ready") operation.responses = {
      "200": { description: "All required dependencies are ready.", content: { "application/json": { schema: { $ref: "#/components/schemas/ReadinessResponse" } } } },
      "503": { description: "At least one required dependency is not ready.", content: { "application/json": { schema: { $ref: "#/components/schemas/ReadinessResponse" } } } },
      "429": { $ref: "#/components/responses/RateLimited" }
    };
    operation.security = path === "/health" || path === "/ready" || path === "/v1/openapi.json" || path === "/v1/service-account-assertions/token" || (method === "get" && path.startsWith("/v1/marketplace/"))
      ? []
      : path.startsWith("/v1/runner/")
        ? [{ runnerDevice: [] }]
        : path === "/v1/billing/stripe/webhook"
          ? [{ stripeSignature: [] }]
          : [{ bearerAuth: [] }];
    if (mutation) operation.requestBody = { required: isExplicitRequestSchema(path, method), content: { "application/json": { schema: requestSchema(path, method) } } };
    paths[path] ??= {};
    paths[path][method] = operation;
  }
  return {
    openapi: "3.1.0",
    info: { title: "sndbox Control Plane API", version: "0.8.0", description: "Versioned v1 route and transport contract for sndbox 8. Resource schemas remain additive within v1." },
    servers: [{ url: "https://api.sndbox.app" }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
        runnerDevice: { type: "apiKey", in: "header", name: "x-sandbox-signature", description: "Ed25519 signature accompanied by runner ID, key ID, timestamp, and nonce headers." },
        stripeSignature: { type: "apiKey", in: "header", name: "stripe-signature" }
      },
      parameters: {
        CorrelationId: { name: "x-correlation-id", in: "header", required: false, schema: { type: "string", minLength: 8, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]+$" }, description: "Caller-supplied correlation ID; the server generates one when omitted." },
        IdempotencyKey: { name: "Idempotency-Key", in: "header", required: false, schema: { type: "string", minLength: 16, maxLength: 200, pattern: "^[A-Za-z0-9._:-]+$" }, description: "Enables exact replay for mutating requests for 24 hours." }
      },
      headers: {
        CorrelationId: { schema: { type: "string" }, description: "Correlation ID for this request." },
        IdempotencyReplayed: { schema: { type: "string", enum: ["true"] }, description: "Present only when the response was replayed." }
      },
      schemas: apiSchemas(routes),
      responses: {
        ApiError: { description: "Structured API error.", headers: { "x-correlation-id": { schema: { type: "string" } } }, content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } } },
        RateLimited: { description: "Rate limit exceeded.", headers: { "retry-after": { schema: { type: "integer" } }, "x-ratelimit-limit": { schema: { type: "integer" } }, "x-ratelimit-remaining": { schema: { type: "integer" } } }, content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } } }
      }
    }
  };
}

function requestSchema(path: string, method: string): { $ref: string } {
  if (path === "/v1/personal-access-tokens" && method === "post") return { $ref: "#/components/schemas/PersonalAccessTokenInput" };
  if (path === "/v1/personal-access-tokens/{tokenId}" && method === "delete") return { $ref: "#/components/schemas/CredentialRevocationInput" };
  if (path === "/v1/workspaces/{workspaceId}/service-accounts" && method === "post") return { $ref: "#/components/schemas/ServiceAccountInput" };
  if (path === "/v1/workspaces/{workspaceId}/service-accounts/{serviceAccountId}/tokens" && method === "post") return { $ref: "#/components/schemas/PersonalAccessTokenInput" };
  if (path === "/v1/workspaces/{workspaceId}/service-accounts/{serviceAccountId}/assertion-keys" && method === "post") return { $ref: "#/components/schemas/ServiceAccountAssertionKeyInput" };
  if (path === "/v1/workspaces/{workspaceId}/service-accounts/{serviceAccountId}/assertion-keys/{keyId}" && method === "delete") return { $ref: "#/components/schemas/CredentialRevocationInput" };
  if (path === "/v1/service-account-assertions/token" && method === "post") return { $ref: "#/components/schemas/ServiceAccountAssertionExchangeInput" };
  if (path === "/v1/service-account-access-reviews/{reviewId}/decision" && method === "post") return { $ref: "#/components/schemas/ServiceAccountAccessReviewDecisionInput" };
  if (path === "/v1/platform/support-access-requests" && method === "post") return { $ref: "#/components/schemas/SupportAccessRequestInput" };
  if (path === "/v1/support-access-requests/{requestId}/decision" && method === "post") return { $ref: "#/components/schemas/SupportAccessDecisionInput" };
  if (path === "/v1/support-access-requests/{requestId}/revoke" && method === "post") return { $ref: "#/components/schemas/SupportAccessRevocationInput" };
  if (path === "/v1/workspaces/{workspaceId}/privacy-retention" && method === "put") return { $ref: "#/components/schemas/RetentionPolicyInput" };
  if (path === "/v1/account/referrals/claim" && method === "post") return { $ref: "#/components/schemas/ReferralClaimInput" };
  if (path === "/v1/workspaces/{workspaceId}/access-tokens/{tokenId}" && method === "delete") return { $ref: "#/components/schemas/CredentialRevocationInput" };
  if (path.endsWith("/collaboration/sessions") && method === "post") return { $ref: "#/components/schemas/CollaborationSessionJoinInput" };
  if (path.endsWith("/collaboration/sessions/{sessionId}/operations") && method === "post") return { $ref: "#/components/schemas/CollaborationOperationInput" };
  if (path.endsWith("/collaboration/sessions/{sessionId}/presence") && method === "put") return { $ref: "#/components/schemas/CollaborationPresenceInput" };
  return { $ref: `#/components/schemas/${operationSchemaName(path, method, "Input")}` };
}

function isExplicitRequestSchema(path: string, method: string): boolean {
  return requestSchema(path, method).$ref !== `#/components/schemas/${operationSchemaName(path, method, "Input")}`;
}

function responseSchema(path: string, method: string): { $ref: string } {
  if (path === "/health") return { $ref: "#/components/schemas/HealthResponse" };
  if (path === "/ready") return { $ref: "#/components/schemas/ReadinessResponse" };
  if (path === "/v1/marketplace/plugins" && method === "get") return { $ref: "#/components/schemas/MarketplacePage" };
  if (path === "/v1/personal-access-tokens" && method === "get") return { $ref: "#/components/schemas/TokenSummaryList" };
  if (path === "/v1/personal-access-tokens" && method === "post") return { $ref: "#/components/schemas/IssuedCredentialEnvelope" };
  if (path === "/v1/workspaces/{workspaceId}/service-accounts" && method === "get") return { $ref: "#/components/schemas/ServiceAccountList" };
  if (path === "/v1/workspaces/{workspaceId}/service-accounts" && method === "post") return { $ref: "#/components/schemas/ServiceAccountEnvelope" };
  if (path === "/v1/workspaces/{workspaceId}/service-accounts/{serviceAccountId}/tokens" && method === "post") return { $ref: "#/components/schemas/IssuedCredentialEnvelope" };
  if (path === "/v1/service-account-assertions/token" && method === "post") return { $ref: "#/components/schemas/IssuedCredentialEnvelope" };
  if (path === "/v1/workspaces/{workspaceId}/service-accounts/{serviceAccountId}/assertion-keys" && method === "post") return { $ref: "#/components/schemas/ServiceAccountAssertionKeyEnvelope" };
  if (path === "/v1/workspaces/{workspaceId}/service-account-access-reviews" && method === "get") return { $ref: "#/components/schemas/ServiceAccountAccessReviewList" };
  if (path === "/v1/service-account-access-reviews/{reviewId}/decision" && method === "post") return { $ref: "#/components/schemas/ServiceAccountAccessReviewEnvelope" };
  if ((path === "/v1/platform/support-access-requests" || path === "/v1/support-access-requests/{requestId}/decision" || path === "/v1/support-access-requests/{requestId}/revoke") && method === "post") return { $ref: "#/components/schemas/SupportAccessRequestEnvelope" };
  if (path === "/v1/workspaces/{workspaceId}/support-access-requests" && method === "get") return { $ref: "#/components/schemas/SupportAccessRequestList" };
  if (path === "/v1/platform/support-access-requests/{requestId}/diagnostics" && method === "get") return { $ref: "#/components/schemas/SupportDiagnosticsEnvelope" };
  if (path === "/v1/workspaces/{workspaceId}/privacy-retention" && (method === "get" || method === "put")) return { $ref: "#/components/schemas/RetentionPolicyEnvelope" };
  if (path === "/v1/account/export" && method === "get") return { $ref: "#/components/schemas/AccountExport" };
  if (path === "/v1/account/referrals" && method === "get") return { $ref: "#/components/schemas/ReferralSummary" };
  if (path === "/v1/account/referrals/claim" && method === "post") return { $ref: "#/components/schemas/ReferralClaimResponse" };
  if (path === "/v1/account" && method === "delete") return { $ref: "#/components/schemas/AccountDeletionResponse" };
  if ((path === "/v1/personal-access-tokens/{tokenId}" || path === "/v1/workspaces/{workspaceId}/access-tokens/{tokenId}" || path === "/v1/workspaces/{workspaceId}/service-accounts/{serviceAccountId}/assertion-keys/{keyId}") && method === "delete") return { $ref: "#/components/schemas/RevocationResponse" };
  if (path.endsWith("/collaboration/sessions") && method === "post") return { $ref: "#/components/schemas/CollaborationSessionEnvelope" };
  if (path.endsWith("/collaboration/sessions/{sessionId}/operations") && method === "post") return { $ref: "#/components/schemas/CollaborationOperationEnvelope" };
  if (path.endsWith("/collaboration/sessions/{sessionId}/operations") && method === "get") return { $ref: "#/components/schemas/CollaborationOperationPage" };
  if (path.endsWith("/collaboration/sessions/{sessionId}/presence") && method === "put") return { $ref: "#/components/schemas/CollaborationPresenceHeartbeatResponse" };
  if (path.endsWith("/collaboration/sessions/{sessionId}/presence") && method === "get") return { $ref: "#/components/schemas/CollaborationPresencePage" };
  if (path.endsWith("/collaboration/sessions/{sessionId}/members/{deviceId}") && method === "delete") return { $ref: "#/components/schemas/CollaborationLeaveResponse" };
  return { $ref: `#/components/schemas/${operationSchemaName(path, method, "Response")}` };
}

function operationSchemaName(path: string, method: string, suffix: "Input" | "Response"): string {
  const operation = `${method}_${path.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "")}`;
  const pascal = operation.split("_").filter(Boolean).map(part => `${part[0].toUpperCase()}${part.slice(1)}`).join("");
  return `${pascal}${suffix}`;
}

function apiSchemas(routes: ApiRouteDescription[]): Record<string, unknown> {
  const uuid = { type: "string", format: "uuid" };
  const dateTime = { type: "string", format: "date-time" };
  const stringArray = { type: "array", items: { type: "string" } };
  const credentialProperties = { id: uuid, name: { type: "string" }, prefix: { type: "string" }, scopes: stringArray, organisationId: uuid, workspaceIds: { type: "array", items: uuid }, environmentIds: { type: "array", items: uuid }, createdAt: dateTime, expiresAt: dateTime };
  const serviceAccountProperties = { id: uuid, organisationId: uuid, workspaceId: { oneOf: [uuid, { type: "null" }] }, name: { type: "string" }, description: { type: "string" }, ownerAccountIds: { type: "array", items: uuid }, roleId: uuid, environmentIds: { type: "array", items: uuid }, expiryPolicyDays: { type: "integer" }, status: { type: "string", enum: ["active", "suspended", "revoked"] }, createdAt: dateTime, lastUsedAt: { oneOf: [dateTime, { type: "null" }] } };
  const schemas: Record<string, unknown> = {
    ApiObject: { type: "object", description: "A versioned API resource object. Resource-specific fields are additive within v1.", additionalProperties: true },
    ApiError: { type: "object", required: ["error", "correlationId"], properties: { error: { type: "object", required: ["code", "message"], properties: { code: { type: "string" }, message: { type: "string" }, details: {} } }, correlationId: { type: "string" } } },
    HealthResponse: { type: "object", required: ["status", "service", "execution"], properties: { status: { const: "ok" }, service: { const: "sandbox-control-plane" }, execution: { const: "local-only" } }, additionalProperties: false },
    ReadinessResponse: { type: "object", required: ["status", "checkedAt", "checks"], properties: { status: { type: "string", enum: ["ready", "not_ready"] }, checkedAt: dateTime, checks: { type: "array", items: { type: "object", required: ["name", "status", "durationMs"], properties: { name: { type: "string" }, status: { type: "string", enum: ["ready", "not_ready"] }, durationMs: { type: "integer", minimum: 0 } }, additionalProperties: false } } }, additionalProperties: false },
    PersonalAccessTokenInput: { type: "object", required: ["name", "scopes", "organisationId", "workspaceIds"], properties: { name: { type: "string", minLength: 1, maxLength: 120 }, scopes: stringArray, organisationId: uuid, workspaceIds: { type: "array", minItems: 1, items: uuid }, environmentIds: { type: "array", items: uuid, default: [] }, expiresInDays: { type: "integer", minimum: 1, maximum: 90, default: 30 } }, additionalProperties: false },
    CredentialRevocationInput: { type: "object", required: ["reason"], properties: { reason: { type: "string", minLength: 1, maxLength: 500 } }, additionalProperties: false },
    ServiceAccountAssertionKeyInput: { type: "object", required: ["keyId","publicKeyDerBase64"], properties: { keyId: { type:"string",pattern:"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" }, publicKeyDerBase64: { type:"string",contentEncoding:"base64",maxLength:2048 } }, additionalProperties:false },
    ServiceAccountAssertionExchangeInput: { type:"object",required:["clientAssertion"],properties:{clientAssertion:{type:"string",minLength:100,maxLength:8192}},additionalProperties:false },
    ServiceAccountAccessReviewDecisionInput: {type:"object",required:["decision","rationale"],properties:{decision:{type:"string",enum:["retain","revoke"]},rationale:{type:"string",minLength:1,maxLength:2000}},additionalProperties:false},
    TokenSummary: { type: "object", required: [...Object.keys(credentialProperties), "kind", "lastUsedAt", "revokedAt"], properties: { ...credentialProperties, kind: { type: "string", enum: ["personal", "service_account"] }, lastUsedAt: { oneOf: [dateTime, { type: "null" }] }, revokedAt: { oneOf: [dateTime, { type: "null" }] } }, additionalProperties: false },
    IssuedCredential: { type: "object", required: [...Object.keys(credentialProperties), "token"], properties: { ...credentialProperties, token: { type: "string", description: "Secret returned only on issuance or exact encrypted idempotent replay." } }, additionalProperties: false },
    TokenSummaryList: { type: "object", required: ["items"], properties: { items: { type: "array", items: { $ref: "#/components/schemas/TokenSummary" } } }, additionalProperties: false },
    IssuedCredentialEnvelope: { type: "object", required: ["credential"], properties: { credential: { $ref: "#/components/schemas/IssuedCredential" } }, additionalProperties: false },
    ServiceAccountInput: { type: "object", required: ["name", "roleId"], properties: { name: { type: "string", minLength: 1, maxLength: 120 }, description: { type: "string", maxLength: 1000, default: "" }, roleId: uuid, environmentIds: { type: "array", items: uuid, default: [] }, expiryPolicyDays: { type: "integer", minimum: 1, maximum: 365, default: 90 } }, additionalProperties: false },
    ServiceAccount: { type: "object", required: Object.keys(serviceAccountProperties), properties: serviceAccountProperties, additionalProperties: false },
    ServiceAccountList: { type: "object", required: ["items"], properties: { items: { type: "array", items: { $ref: "#/components/schemas/ServiceAccount" } } }, additionalProperties: false },
    ServiceAccountEnvelope: { type: "object", required: ["serviceAccount"], properties: { serviceAccount: { $ref: "#/components/schemas/ServiceAccount" } }, additionalProperties: false },
    ServiceAccountAssertionKeyEnvelope: { type:"object",required:["key"],properties:{key:{type:"object",required:["serviceAccountId","workspaceId","keyId","algorithm","createdAt","revokedAt"],properties:{serviceAccountId:uuid,workspaceId:uuid,keyId:{type:"string"},algorithm:{const:"EdDSA"},createdAt:dateTime,revokedAt:{oneOf:[dateTime,{type:"null"}]}},additionalProperties:false}},additionalProperties:false },
    ServiceAccountAccessReview: {type:"object",required:["id","serviceAccountId","organisationId","serviceAccountName","workspaceIds","openedAt","dueAt","status","accessSnapshot","decidedBy","decidedAt","rationale"],properties:{id:uuid,serviceAccountId:uuid,organisationId:uuid,serviceAccountName:{type:"string"},workspaceIds:{type:"array",items:uuid},openedAt:dateTime,dueAt:dateTime,status:{type:"string",enum:["pending","overdue","retained","revoked"]},accessSnapshot:{type:"object",additionalProperties:true},decidedBy:{oneOf:[uuid,{type:"null"}]},decidedAt:{oneOf:[dateTime,{type:"null"}]},rationale:{oneOf:[{type:"string"},{type:"null"}]}},additionalProperties:false},
    ServiceAccountAccessReviewList: {type:"object",required:["items"],properties:{items:{type:"array",items:{$ref:"#/components/schemas/ServiceAccountAccessReview"}}},additionalProperties:false},
    ServiceAccountAccessReviewEnvelope: {type:"object",required:["review"],properties:{review:{$ref:"#/components/schemas/ServiceAccountAccessReview"}},additionalProperties:false},
    SupportAccessRequestInput: {type:"object",required:["workspaceId","reason","scopes","durationMinutes"],properties:{workspaceId:uuid,reason:{type:"string",minLength:10,maxLength:2000},scopes:{type:"array",minItems:1,maxItems:1,items:{const:"diagnostics.read"}},durationMinutes:{type:"integer",minimum:15,maximum:480}},additionalProperties:false},
    SupportAccessDecisionInput: {type:"object",required:["decision","rationale"],properties:{decision:{type:"string",enum:["approve","reject"]},rationale:{type:"string",minLength:1,maxLength:2000}},additionalProperties:false},
    SupportAccessRevocationInput: {type:"object",required:["rationale"],properties:{rationale:{type:"string",minLength:1,maxLength:2000}},additionalProperties:false},
    SupportAccessRequest: {type:"object",required:["id","workspaceId","requestedBy","reason","scopes","requestedAt","expiresAt","status","decidedBy","decidedAt","rationale","revokedBy","revokedAt"],properties:{id:uuid,workspaceId:uuid,requestedBy:uuid,reason:{type:"string"},scopes:{type:"array",items:{const:"diagnostics.read"}},requestedAt:dateTime,expiresAt:dateTime,status:{type:"string",enum:["pending","approved","rejected","revoked","expired"]},decidedBy:{oneOf:[uuid,{type:"null"}]},decidedAt:{oneOf:[dateTime,{type:"null"}]},rationale:{oneOf:[{type:"string"},{type:"null"}]},revokedBy:{oneOf:[uuid,{type:"null"}]},revokedAt:{oneOf:[dateTime,{type:"null"}]}},additionalProperties:false},
    SupportAccessRequestEnvelope: {type:"object",required:["request"],properties:{request:{$ref:"#/components/schemas/SupportAccessRequest"}},additionalProperties:false},
    SupportAccessRequestList: {type:"object",required:["items"],properties:{items:{type:"array",items:{$ref:"#/components/schemas/SupportAccessRequest"}}},additionalProperties:false},
    SupportDiagnosticsEnvelope: {type:"object",required:["diagnostics"],properties:{diagnostics:{type:"object",required:["collectedAt","workspaceId","runners","executionsLast24Hours","queuedEvents","webhookDeliveries"],properties:{collectedAt:dateTime,workspaceId:uuid,runners:{type:"object",additionalProperties:{type:"integer",minimum:0}},executionsLast24Hours:{type:"object",additionalProperties:{type:"integer",minimum:0}},queuedEvents:{type:"object",additionalProperties:{type:"integer",minimum:0}},webhookDeliveries:{type:"object",additionalProperties:{type:"integer",minimum:0}}},additionalProperties:false}},additionalProperties:false},
    RetentionPolicyInput: {type:"object",required:["executionDetailDays","queueEventDays","webhookDeliveryDays","runnerCommandDays","auditEventDays"],properties:{executionDetailDays:{type:"integer",minimum:1,maximum:3650},queueEventDays:{type:"integer",minimum:1,maximum:365},webhookDeliveryDays:{type:"integer",minimum:1,maximum:30},runnerCommandDays:{type:"integer",minimum:1,maximum:365},auditEventDays:{type:"integer",minimum:365,maximum:3650}},additionalProperties:false},
    RetentionPolicy: {type:"object",required:["executionDetailDays","queueEventDays","webhookDeliveryDays","runnerCommandDays","auditEventDays","changedBy","changedAt"],properties:{executionDetailDays:{type:"integer",minimum:1,maximum:3650},queueEventDays:{type:"integer",minimum:1,maximum:365},webhookDeliveryDays:{type:"integer",minimum:1,maximum:30},runnerCommandDays:{type:"integer",minimum:1,maximum:365},auditEventDays:{type:"integer",minimum:365,maximum:3650},changedBy:{oneOf:[uuid,{type:"null"}]},changedAt:{oneOf:[dateTime,{type:"null"}]}},additionalProperties:false},
    RetentionPolicyEnvelope: {type:"object",required:["policy"],properties:{policy:{$ref:"#/components/schemas/RetentionPolicy"}},additionalProperties:false},
    ReferralClaimInput: {type:"object",required:["code"],properties:{code:{type:"string",pattern:"^[a-z0-9]{12,24}$"}},additionalProperties:false},
    ReferralClaimResponse: {type:"object",required:["claimed","status"],properties:{claimed:{const:true},status:{const:"pending"}},additionalProperties:false},
    ReferralSummary: {type:"object",required:["code","shareUrl","policy","stats","claim","referrals"],properties:{code:{type:"string",pattern:"^[a-z0-9]{12,24}$"},shareUrl:{type:"string",format:"uri"},policy:{type:"object",required:["claimWindowDays","qualifyingTopUpCents","rewardMicros","maximumRewardsPerRollingYear"],properties:{claimWindowDays:{type:"integer",minimum:1},qualifyingTopUpCents:{type:"integer",minimum:1},rewardMicros:{type:"integer",minimum:1},maximumRewardsPerRollingYear:{type:"integer",minimum:1}},additionalProperties:false},stats:{type:"object",required:["invited","pending","rewarded","earnedMicros"],properties:{invited:{type:"integer",minimum:0},pending:{type:"integer",minimum:0},rewarded:{type:"integer",minimum:0},earnedMicros:{type:"integer",minimum:0}},additionalProperties:false},claim:{oneOf:[{$ref:"#/components/schemas/ReferralRecord"},{type:"null"}]},referrals:{type:"array",maxItems:100,items:{$ref:"#/components/schemas/ReferralRecord"}}},additionalProperties:false},
    ReferralRecord: {type:"object",required:["status","claimedAt","rewardedAt","reversedAt"],properties:{id:uuid,status:{type:"string",enum:["pending","rewarded","reversed","ineligible"]},claimedAt:dateTime,rewardedAt:{oneOf:[dateTime,{type:"null"}]},reversedAt:{oneOf:[dateTime,{type:"null"}]}},additionalProperties:false},
    AccountExport: {type:"object",required:["exportVersion","exportedAt","classification","account","memberships","workspaceMemberships","sessions","invitations","credentials","personalWorkflows","auditEvents","referrals"],properties:{exportVersion:{const:1},exportedAt:dateTime,classification:{type:"object",additionalProperties:true},account:{type:"object",additionalProperties:true},memberships:{type:"array",items:{$ref:"#/components/schemas/ApiObject"}},workspaceMemberships:{type:"array",items:{$ref:"#/components/schemas/ApiObject"}},sessions:{type:"array",items:{$ref:"#/components/schemas/ApiObject"}},invitations:{type:"array",items:{$ref:"#/components/schemas/ApiObject"}},credentials:{type:"array",items:{$ref:"#/components/schemas/ApiObject"}},personalWorkflows:{type:"array",items:{$ref:"#/components/schemas/ApiObject"}},auditEvents:{type:"array",items:{$ref:"#/components/schemas/ApiObject"}},referrals:{type:"array",items:{$ref:"#/components/schemas/ApiObject"}}},additionalProperties:false},
    AccountDeletionResponse: {type:"object",required:["deleted","requestId","completedAt","summary"],properties:{deleted:{const:true},requestId:uuid,completedAt:dateTime,summary:{type:"object",additionalProperties:{type:"integer",minimum:0}}},additionalProperties:false},
    RevocationResponse: { type: "object", required: ["revoked"], properties: { revoked: { const: true } }, additionalProperties: false },
    CollaborationSessionJoinInput: { type: "object", required: ["deviceId", "color"], properties: { sessionId: uuid, deviceId: uuid, color: { type: "string", pattern: "^#[a-fA-F0-9]{6}$" } }, additionalProperties: false },
    CollaborationSession: { type: "object", required: ["sessionId", "workspaceId", "workflowId", "latestSequence", "joinedAt", "expiresAt"], properties: { sessionId: uuid, workspaceId: uuid, workflowId: uuid, latestSequence: { type: "integer", minimum: 0 }, joinedAt: dateTime, expiresAt: dateTime }, additionalProperties: false },
    CollaborationSessionEnvelope: { type: "object", required: ["session"], properties: { session: { $ref: "#/components/schemas/CollaborationSession" } }, additionalProperties: false },
    CollaborationOperationInput: { type: "object", required: ["operationId", "baseSequence", "clientSequence", "encryptedPayload", "payloadHash", "createdAt"], properties: { operationId: uuid, baseSequence: { type: "integer", minimum: 0 }, clientSequence: { type: "integer", minimum: 0 }, encryptedPayload: { type: "string", contentEncoding: "base64", minLength: 20, maxLength: 1500000 }, payloadHash: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" }, createdAt: dateTime }, additionalProperties: false },
    CollaborationOperation: { type: "object", required: ["operationId", "baseSequence", "clientSequence", "encryptedPayload", "payloadHash", "createdAt", "sessionId", "workflowId", "actorAccountId", "sequence", "acceptedAt"], properties: { operationId: uuid, baseSequence: { type: "integer", minimum: 0 }, clientSequence: { type: "integer", minimum: 0 }, encryptedPayload: { type: "string", contentEncoding: "base64", minLength: 20, maxLength: 1500000 }, payloadHash: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" }, createdAt: dateTime, sessionId: uuid, workflowId: uuid, actorAccountId: uuid, sequence: { type: "integer", minimum: 1 }, acceptedAt: dateTime }, additionalProperties: false },
    CollaborationOperationEnvelope: { type: "object", required: ["operation"], properties: { operation: { $ref: "#/components/schemas/CollaborationOperation" } }, additionalProperties: false },
    CollaborationOperationPage: { type: "object", required: ["items", "latestSequence"], properties: { items: { type: "array", maxItems: 100, items: { $ref: "#/components/schemas/CollaborationOperation" } }, latestSequence: { type: "integer", minimum: 0 } }, additionalProperties: false },
    CollaborationPresenceInput: { type: "object", required: ["deviceId", "color", "encryptedPresence"], properties: { deviceId: uuid, color: { type: "string", pattern: "^#[a-fA-F0-9]{6}$" }, encryptedPresence: { type: "string", contentEncoding: "base64", minLength: 20, maxLength: 16384 } }, additionalProperties: false },
    CollaborationPresence: { type: "object", required: ["deviceId", "color", "encryptedPresence", "accountId", "displayName", "lastSeenAt"], properties: { deviceId: uuid, color: { type: "string", pattern: "^#[a-fA-F0-9]{6}$" }, encryptedPresence: { type: "string", contentEncoding: "base64", minLength: 20, maxLength: 16384 }, accountId: uuid, displayName: { type: "string", minLength: 1, maxLength: 200 }, lastSeenAt: dateTime }, additionalProperties: false },
    CollaborationPresenceHeartbeatResponse: { type: "object", required: ["updated"], properties: { updated: { const: true } }, additionalProperties: false },
    CollaborationPresencePage: { type: "object", required: ["items"], properties: { items: { type: "array", items: { $ref: "#/components/schemas/CollaborationPresence" } } }, additionalProperties: false },
    CollaborationLeaveResponse: { type: "object", required: ["left"], properties: { left: { const: true } }, additionalProperties: false },
    MarketplacePage: { type: "object", required: ["items", "nextCursor"], properties: { items: { type: "array", items: { type: "object", required: ["pluginId", "name", "version", "packageIntegrity"], properties: { pluginId: { type: "string" }, name: { type: "string" }, version: { type: "string" }, packageIntegrity: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" } }, additionalProperties: true } }, nextCursor: { oneOf: [{ type: "string" }, { type: "null" }] } }, additionalProperties: false }
  };
  for (const route of routes.filter(route => route.method !== "HEAD" && (["/health", "/ready"].includes(route.url) || route.url.startsWith("/v1/")))) {
    const path = route.url.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
    const method = route.method.toLowerCase();
    if (["post", "put", "patch", "delete"].includes(method)) {
      const input = requestSchema(path, method).$ref.split("/").at(-1)!;
      schemas[input] ??= { allOf: [{ $ref: "#/components/schemas/ApiObject" }], description: `Request body for ${method.toUpperCase()} ${path}.` };
    }
    const response = responseSchema(path, method).$ref.split("/").at(-1)!;
    schemas[response] ??= { allOf: [{ $ref: "#/components/schemas/ApiObject" }], description: `Successful response for ${method.toUpperCase()} ${path}.` };
  }
  return schemas;
}
