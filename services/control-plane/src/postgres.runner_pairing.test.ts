import { createHash, generateKeyPairSync, sign } from "node:crypto";
import type { Pool, QueryResult } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresRepository } from "./postgres.js";
import type { AuthenticatedSession } from "./types.js";

const result = (rows: unknown[] = [], rowCount = rows.length) =>
  ({ rows, rowCount, command: "", oid: 0, fields: [] }) as QueryResult;

describe("Postgres runner pairing", () => {
  it("serializes array-valued runner metadata as JSONB while preserving PostgreSQL tags", async () => {
    const accountId = "11111111-1111-4111-8111-111111111111";
    const workspaceId = "22222222-2222-4222-8222-222222222222";
    const challengeId = "33333333-3333-4333-8333-333333333333";
    const challenge = "runner-pairing-challenge-with-enough-entropy";
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
    const metadata = {
      operatingSystem: "linux",
      architecture: "x86_64",
      applicationVersion: "0.7.10-beta.2",
      protocolVersion: 2,
      pluginRuntimeVersion: "0.7.10-beta.2",
      capabilities: { localFiles: true },
      safeFolderLabels: ["/srv/automation"],
      browserEngine: { name: "chromium" },
      installedPluginVersions: [{ pluginId: "com.example.weather", version: "1.0.0", packageIntegrity: `sha256:${"a".repeat(64)}` }],
      tags: ["self-hosted"],
    };
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) return result();
      if (sql.includes("FROM runner_pairing_challenges")) return result([{ device_public_key: publicKeyDer, challenge_hash: createHash("sha256").update(challenge).digest(), metadata }]);
      if (sql.includes("FROM workspace_memberships")) return result([{}]);
      if (sql.includes("INSERT INTO runners")) return result([{ paired_at: new Date("2026-09-14T12:00:00.000Z") }]);
      return result([], 1);
    });
    const pool = { connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
    const actor: AuthenticatedSession = {
      accountId,
      sessionId: "44444444-4444-4444-8444-444444444444",
      subject: "auth0|runner-owner",
      email: "owner@example.com",
      issuedAt: new Date("2026-09-14T11:00:00.000Z"),
      expiresAt: new Date("2026-09-14T13:00:00.000Z"),
      authenticationMethods: ["pwd"],
      platformPermissions: [],
    };

    await new PostgresRepository(pool).confirmRunnerPairing(actor, {
      challengeId,
      challenge,
      signatureBase64: sign(null, Buffer.from(challenge), privateKey).toString("base64"),
      workspaceId,
      displayName: "Homeserver",
    }, "pairing-correlation-id");

    const runnerInsert = query.mock.calls.find(([sql]) => sql.includes("INSERT INTO runners"));
    expect(runnerInsert?.[1]).toEqual(expect.arrayContaining([
      JSON.stringify(metadata.capabilities),
      JSON.stringify(metadata.safeFolderLabels),
      JSON.stringify(metadata.browserEngine),
      JSON.stringify(metadata.installedPluginVersions),
    ]));
    expect(runnerInsert?.[1]?.[13]).toEqual(metadata.tags);
  });
});
