import { describe, expect, it } from "vitest";
import { checkRunnerCompatibility, collaborationOperationInputSchema, hasPermission, RUNNER_PROTOCOL_VERSION, runnerCommandSchema, runnerHeartbeatSchema, workspaceActivitySummarySchema, type RunnerIdentity, type RunnerRequirements } from "./index.js";

describe("contracts", () => {
  it("uses explicit permission bundles", () => {
    expect(hasPermission("administrator", "plugins.manage")).toBe(true);
    expect(hasPermission("viewer", "workflows.run")).toBe(false);
  });

  it("rejects incomplete runner commands", () => {
    expect(() => runnerCommandSchema.parse({ commandId: crypto.randomUUID() })).toThrow();
  });

  it("rejects runner protocol messages from another protocol version", () => {
    expect(() => runnerHeartbeatSchema.parse({ protocolVersion: RUNNER_PROTOCOL_VERSION + 1, kind: "heartbeat" })).toThrow();
  });

  it("accepts only opaque authenticated collaboration operations", () => {
    const valid = {
      operationId: "11111111-1111-4111-8111-111111111111",
      baseSequence: 0,
      clientSequence: 1,
      encryptedPayload: Buffer.alloc(32, 7).toString("base64"),
      payloadHash: `sha256:${"a".repeat(64)}`,
      createdAt: "2026-09-11T12:00:00.000Z",
    };
    expect(collaborationOperationInputSchema.parse(valid)).toMatchObject({ baseSequence: 0 });
    expect(() => collaborationOperationInputSchema.parse({ ...valid, encryptedPayload: JSON.stringify({ kind: "node_add" }) })).toThrow();
  });

  it("requires every capability, plugin, connection and placement constraint", () => {
    const identity: RunnerIdentity = {
      runnerId: "11111111-1111-4111-8111-111111111111", keyId: "device-1", runnerType: "hosted", protocolVersion: RUNNER_PROTOCOL_VERSION,
      engineVersion: "0.4.0", pluginRuntimeVersion: "0.4.0", architecture: "x86_64", operatingSystem: "linux", workspaceId: "22222222-2222-4222-8222-222222222222",
      environmentId: "33333333-3333-4333-8333-333333333333", region: "eu-west-2", tags: ["standard"], concurrencyLimit: 4, maintenanceState: "active",
      nodeCapabilities: [{ nodeType: "http_request", nodeVersions: [1], constraints: {} }],
      plugins: [{ pluginId: "com.example.weather", version: "1.2.3", packageIntegrity: `sha256:${"a".repeat(64)}`, nodeVersions: { current_weather: [1] } }],
      connections: [{ connectionId: "44444444-4444-4444-8444-444444444444", environmentId: "33333333-3333-4333-8333-333333333333", operations: ["read"], status: "available" }]
    };
    const requirements: RunnerRequirements = {
      protocolVersion: RUNNER_PROTOCOL_VERSION, engineVersion: "0.4.0", pluginRuntimeVersion: "0.4.0", runnerTypes: ["hosted"], architectures: ["x86_64"], workspaceId: identity.workspaceId,
      environmentId: identity.environmentId, region: "eu-west-2", requiredTags: ["standard"], capabilities: [{ nodeType: "http_request", nodeVersions: [1], constraints: {} }],
      plugins: identity.plugins, connectionIds: [identity.connections[0].connectionId], minimumAvailableConcurrency: 1
    };
    expect(checkRunnerCompatibility(identity, requirements)).toEqual({ compatible: true, reasons: [] });
    const mismatch = checkRunnerCompatibility({ ...identity, connections: [], maintenanceState: "draining" }, requirements);
    expect(mismatch.compatible).toBe(false);
    expect(mismatch.reasons).toEqual(expect.arrayContaining(["Runner is draining.", expect.stringContaining("is unavailable") ]));
  });
  it("reports actionable Code runtime constraint mismatches",()=>{
    const available={runtime:"javascript",runtimeVersions:["2.7.0"],helperLanguageVersion:1,packageEnvironmentId:null,networkPolicy:"none",filesystemPolicy:"none",binaryData:true,maximumMemoryBytes:134217728,maximumDurationMs:120000,credentialBindings:[]};
    const required={runtime:"python",runtimeVersion:">=3.11",helperLanguageVersion:1,packageEnvironmentId:null,networkPolicy:"none",filesystemPolicy:"none",binaryData:true,maximumMemoryBytes:134217728,maximumDurationMs:30000,credentialBindings:[]};
    const base={runnerId:"11111111-1111-4111-8111-111111111111",keyId:"key",runnerType:"hosted" as const,protocolVersion:RUNNER_PROTOCOL_VERSION,engineVersion:"1",pluginRuntimeVersion:"1",architecture:"x86_64" as const,operatingSystem:"linux",workspaceId:"22222222-2222-4222-8222-222222222222",environmentId:"33333333-3333-4333-8333-333333333333",region:"eu",tags:[],concurrencyLimit:1,maintenanceState:"active" as const,nodeCapabilities:[{nodeType:"python_code",nodeVersions:[1],constraints:available}],plugins:[],connections:[]};
    const result=checkRunnerCompatibility(base,{protocolVersion:RUNNER_PROTOCOL_VERSION,engineVersion:"1",pluginRuntimeVersion:"1",runnerTypes:["hosted"],architectures:["x86_64"],workspaceId:base.workspaceId,environmentId:base.environmentId,region:"eu",requiredTags:[],capabilities:[{nodeType:"python_code",nodeVersions:[1],constraints:required}],plugins:[],connectionIds:[],minimumAvailableConcurrency:1});
    expect(result.compatible).toBe(false);expect(result.reasons).toEqual(expect.arrayContaining([expect.stringContaining("requires runtime python"),expect.stringContaining("requires runtime >=3.11")]));
  });
  it("validates additive workspace activity health counts and timestamps", () => {
    const generatedAt = "2026-09-10T10:15:00.000Z";
    const result = workspaceActivitySummarySchema.parse({
      generatedAt,
      runners: [],
      runs: [],
      pendingApprovalCount: 2,
      webhookFailureCount: 1,
      syncConflictCount: 3,
    });
    expect(result).toMatchObject({ generatedAt, pendingApprovalCount: 2, webhookFailureCount: 1, syncConflictCount: 3 });
    expect(() => workspaceActivitySummarySchema.parse({ ...result, syncConflictCount: -1 })).toThrow();
    expect(() => workspaceActivitySummarySchema.parse({ ...result, generatedAt: "yesterday" })).toThrow();
  });
});
