import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresCollaborationService } from "./collaboration.js";
import type { AuthenticatedSession } from "./types.js";

const connectionString = process.env.TEST_DATABASE_URL;
const integration = connectionString ? describe : describe.skip;

integration("durable encrypted workflow collaboration", () => {
  const pool = new Pool({ connectionString, max: 4 });
  const service = new PostgresCollaborationService(pool);
  const accountId = randomUUID();
  const organisationId = randomUUID();
  const workspaceId = randomUUID();
  const workflowId = randomUUID();
  const deviceId = randomUUID();
  const actor: AuthenticatedSession = {
    accountId,
    sessionId: randomUUID(),
    subject: `collaboration-${accountId}`,
    email: `${accountId}@example.invalid`,
    issuedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    authenticationMethods: ["test"],
    platformPermissions: [],
  };

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO accounts(id,identity_subject,primary_email,email_verified,display_name) VALUES($1,$2,$3,true,'Collaborative editor')`,
      [accountId, actor.subject, actor.email],
    );
    await pool.query(
      `INSERT INTO organisations(id,name,slug,created_by) VALUES($1,'Collaboration test',$2,$3)`,
      [organisationId, `collaboration-${organisationId}`, accountId],
    );
    await pool.query(
      `INSERT INTO workspaces(id,organisation_id,name,slug,created_by) VALUES($1,$2,'Collaboration workspace','collaboration',$3)`,
      [workspaceId, organisationId, accountId],
    );
    await pool.query(
      `INSERT INTO synced_workflows(id,owner_type,owner_id,workspace_id,name) VALUES($1,'workspace',$2,$2,'Shared workflow')`,
      [workflowId, workspaceId],
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM organisations WHERE id=$1`, [organisationId]).catch(() => undefined);
    await pool.query(`DELETE FROM accounts WHERE id=$1`, [accountId]).catch(() => undefined);
    await pool.end();
  });

  it("orders concurrent operations, deduplicates retries, persists presence, and revokes access on leave", async () => {
    const session = await service.join(actor, workspaceId, workflowId, { deviceId, color: "#6f8fff" });
    expect(session).toMatchObject({ workspaceId, workflowId, latestSequence: 0 });

    const encryptedPayload = Buffer.alloc(32, 7);
    const input = (clientSequence: number) => ({
      operationId: randomUUID(),
      baseSequence: 0,
      clientSequence,
      encryptedPayload: encryptedPayload.toString("base64"),
      payloadHash: `sha256:${createHash("sha256").update(encryptedPayload).digest("hex")}`,
      createdAt: new Date().toISOString(),
    });
    const firstInput = input(1);
    const secondInput = input(2);
    const accepted = await Promise.all([
      service.append(actor, workspaceId, workflowId, session.sessionId, firstInput),
      service.append(actor, workspaceId, workflowId, session.sessionId, secondInput),
    ]);
    expect(accepted.map(operation => operation.sequence).sort()).toEqual([1, 2]);

    const duplicate = await service.append(actor, workspaceId, workflowId, session.sessionId, firstInput);
    expect(duplicate.operationId).toBe(firstInput.operationId);
    const page = await service.operations(actor, workspaceId, workflowId, session.sessionId, 0, 50);
    expect(page.latestSequence).toBe(2);
    expect(page.items.map(operation => operation.sequence)).toEqual([1, 2]);

    const encryptedPresence = Buffer.alloc(32, 9).toString("base64");
    await service.heartbeat(actor, workspaceId, workflowId, session.sessionId, deviceId, "#6f8fff", encryptedPresence);
    expect(await service.presence(actor, workspaceId, workflowId, session.sessionId)).toEqual([
      expect.objectContaining({ accountId, deviceId, displayName: "Collaborative editor", color: "#6f8fff", encryptedPresence }),
    ]);

    await service.leave(actor, workspaceId, workflowId, session.sessionId, deviceId);
    await expect(service.operations(actor, workspaceId, workflowId, session.sessionId, 0, 50)).rejects.toMatchObject({ code: "collaboration_session_unavailable" });
  });
});
