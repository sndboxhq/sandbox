import { createHash, randomUUID } from "node:crypto";
import type {
  CollaborationOperation,
  CollaborationOperationInput,
  CollaborationPresence,
  CollaborationSession,
} from "@sandbox/contracts";
import type { Pool, PoolClient } from "pg";
import { DomainError, type AuthenticatedSession } from "./types.js";

export interface CollaborationJoinInput {
  sessionId?: string;
  deviceId: string;
  color: string;
}

export interface CollaborationService {
  join(actor: AuthenticatedSession, workspaceId: string, workflowId: string, input: CollaborationJoinInput): Promise<CollaborationSession>;
  append(actor: AuthenticatedSession, workspaceId: string, workflowId: string, sessionId: string, input: CollaborationOperationInput): Promise<CollaborationOperation>;
  operations(actor: AuthenticatedSession, workspaceId: string, workflowId: string, sessionId: string, after: number, limit: number): Promise<{ items: CollaborationOperation[]; latestSequence: number }>;
  heartbeat(actor: AuthenticatedSession, workspaceId: string, workflowId: string, sessionId: string, deviceId: string, color: string, encryptedPresence: string): Promise<void>;
  presence(actor: AuthenticatedSession, workspaceId: string, workflowId: string, sessionId: string): Promise<CollaborationPresence[]>;
  leave(actor: AuthenticatedSession, workspaceId: string, workflowId: string, sessionId: string, deviceId: string): Promise<void>;
}

export class PostgresCollaborationService implements CollaborationService {
  constructor(private readonly pool: Pool) {}

  async join(actor: AuthenticatedSession, workspaceId: string, workflowId: string, input: CollaborationJoinInput): Promise<CollaborationSession> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const workflow = await client.query(`SELECT 1 FROM synced_workflows WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL`, [workflowId, workspaceId]);
      if (!workflow.rowCount) throw new DomainError("collaboration_workflow_not_found", "The shared workflow was not found in this workspace.", 404);
      const sessionId = input.sessionId ?? randomUUID();
      if (input.sessionId) {
        const session = await client.query(`SELECT 1 FROM workflow_collaboration_sessions WHERE id=$1 AND workspace_id=$2 AND workflow_id=$3 AND closed_at IS NULL AND expires_at>now() FOR UPDATE`, [sessionId, workspaceId, workflowId]);
        if (!session.rowCount) throw new DomainError("collaboration_session_unavailable", "This collaboration session is closed, expired, or belongs to another workflow.", 404);
      } else {
        await client.query(`INSERT INTO workflow_collaboration_sessions(id,workspace_id,workflow_id,created_by,expires_at) VALUES($1,$2,$3,$4,now()+interval '8 hours')`, [sessionId, workspaceId, workflowId, actor.accountId]);
      }
      await client.query(
        `INSERT INTO workflow_collaboration_members(session_id,account_id,device_id,color) VALUES($1,$2,$3,$4)
         ON CONFLICT(session_id,account_id,device_id) DO UPDATE SET color=excluded.color,last_seen_at=now()`,
        [sessionId, actor.accountId, input.deviceId, input.color],
      );
      const session = await client.query<{ latest_sequence: string; joined_at: Date; expires_at: Date }>(
        `SELECT session.latest_sequence,member.joined_at,session.expires_at
           FROM workflow_collaboration_sessions session
           JOIN workflow_collaboration_members member ON member.session_id=session.id AND member.account_id=$2 AND member.device_id=$3
          WHERE session.id=$1`,
        [sessionId, actor.accountId, input.deviceId],
      );
      await client.query("COMMIT");
      const row = session.rows[0];
      return { sessionId, workspaceId, workflowId, latestSequence: Number(row.latest_sequence), joinedAt: row.joined_at.toISOString(), expiresAt: row.expires_at.toISOString() };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async append(actor: AuthenticatedSession, workspaceId: string, workflowId: string, sessionId: string, input: CollaborationOperationInput): Promise<CollaborationOperation> {
    const encrypted = Buffer.from(input.encryptedPayload, "base64");
    const calculated = `sha256:${createHash("sha256").update(encrypted).digest("hex")}`;
    if (calculated !== input.payloadHash) throw new DomainError("collaboration_payload_hash_mismatch", "The encrypted collaboration payload failed integrity validation.", 400);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await requireActiveSession(client, actor, workspaceId, workflowId, sessionId);
      const duplicate = await client.query<OperationRow>(operationSelect("session_id=$1 AND operation_id=$2"), [sessionId, input.operationId]);
      if (duplicate.rowCount) { await client.query("COMMIT"); return operationFromRow(duplicate.rows[0]); }
      const session = await client.query<{ latest_sequence: string }>(`SELECT latest_sequence FROM workflow_collaboration_sessions WHERE id=$1 FOR UPDATE`, [sessionId]);
      const latest = Number(session.rows[0].latest_sequence);
      if (input.baseSequence > latest) throw new DomainError("collaboration_base_ahead", "The operation base is newer than the collaboration session.", 409);
      const sequence = latest + 1;
      await client.query(`UPDATE workflow_collaboration_sessions SET latest_sequence=$2,expires_at=greatest(expires_at,now()+interval '30 minutes') WHERE id=$1`, [sessionId, sequence]);
      const inserted = await client.query<OperationRow>(
        `INSERT INTO workflow_collaboration_operations(session_id,sequence,operation_id,workflow_id,actor_account_id,base_sequence,client_sequence,encrypted_payload,payload_hash,client_created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING session_id,sequence,operation_id,workflow_id,actor_account_id,base_sequence,client_sequence,encode(encrypted_payload,'base64') AS encrypted_payload,payload_hash,client_created_at,accepted_at`,
        [sessionId, sequence, input.operationId, workflowId, actor.accountId, input.baseSequence, input.clientSequence, encrypted, input.payloadHash, input.createdAt],
      );
      await client.query("COMMIT");
      return operationFromRow(inserted.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async operations(actor: AuthenticatedSession, workspaceId: string, workflowId: string, sessionId: string, after: number, limit: number) {
    const client = await this.pool.connect();
    try {
      await requireActiveSession(client, actor, workspaceId, workflowId, sessionId, false);
      const result = await client.query<OperationRow>(operationSelect("session_id=$1 AND sequence>$2") + " ORDER BY sequence ASC LIMIT $3", [sessionId, after, limit]);
      const session = await client.query<{ latest_sequence: string }>(`SELECT latest_sequence FROM workflow_collaboration_sessions WHERE id=$1`, [sessionId]);
      return { items: result.rows.map(operationFromRow), latestSequence: Number(session.rows[0].latest_sequence) };
    } finally {
      client.release();
    }
  }

  async heartbeat(actor: AuthenticatedSession, workspaceId: string, workflowId: string, sessionId: string, deviceId: string, color: string, encryptedPresence: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await requireActiveSession(client, actor, workspaceId, workflowId, sessionId);
      const result = await client.query(
        `UPDATE workflow_collaboration_members SET color=$3,encrypted_presence=$4,last_seen_at=now()
          WHERE session_id=$1 AND account_id=$2 AND device_id=$5`,
        [sessionId, actor.accountId, color, Buffer.from(encryptedPresence, "base64"), deviceId],
      );
      if (!result.rowCount) throw new DomainError("collaboration_member_not_found", "Join the collaboration session before sending presence.", 409);
    } finally {
      client.release();
    }
  }

  async presence(actor: AuthenticatedSession, workspaceId: string, workflowId: string, sessionId: string): Promise<CollaborationPresence[]> {
    const client = await this.pool.connect();
    try {
      await requireActiveSession(client, actor, workspaceId, workflowId, sessionId, false);
      const result = await client.query<{ account_id: string; device_id: string; display_name: string; color: string; encrypted_presence: string; last_seen_at: Date }>(
        `SELECT member.account_id,member.device_id,account.display_name,member.color,encode(member.encrypted_presence,'base64') AS encrypted_presence,member.last_seen_at
           FROM workflow_collaboration_members member JOIN accounts account ON account.id=member.account_id
          WHERE member.session_id=$1 AND member.last_seen_at>now()-interval '45 seconds' AND member.encrypted_presence IS NOT NULL
          ORDER BY member.joined_at,member.device_id`,
        [sessionId],
      );
      return result.rows.map((row) => ({ accountId: row.account_id, deviceId: row.device_id, displayName: row.display_name, color: row.color, encryptedPresence: row.encrypted_presence.replace(/\s/g, ""), lastSeenAt: row.last_seen_at.toISOString() }));
    } finally {
      client.release();
    }
  }

  async leave(actor: AuthenticatedSession, workspaceId: string, workflowId: string, sessionId: string, deviceId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await requireActiveSession(client, actor, workspaceId, workflowId, sessionId, false);
      await client.query(`DELETE FROM workflow_collaboration_members WHERE session_id=$1 AND account_id=$2 AND device_id=$3`, [sessionId, actor.accountId, deviceId]);
    } finally {
      client.release();
    }
  }
}

interface OperationRow {
  session_id: string; sequence: string; operation_id: string; workflow_id: string; actor_account_id: string;
  base_sequence: string; client_sequence: string; encrypted_payload: string; payload_hash: string; client_created_at: Date; accepted_at: Date;
}

function operationFromRow(row: OperationRow): CollaborationOperation {
  return {
    sessionId: row.session_id, sequence: Number(row.sequence), operationId: row.operation_id,
    workflowId: row.workflow_id, actorAccountId: row.actor_account_id, baseSequence: Number(row.base_sequence),
    clientSequence: Number(row.client_sequence), encryptedPayload: row.encrypted_payload.replace(/\s/g, ""),
    payloadHash: row.payload_hash, createdAt: row.client_created_at.toISOString(), acceptedAt: row.accepted_at.toISOString(),
  };
}

function operationSelect(where: string) {
  return `SELECT session_id,sequence,operation_id,workflow_id,actor_account_id,base_sequence,client_sequence,encode(encrypted_payload,'base64') AS encrypted_payload,payload_hash,client_created_at,accepted_at FROM workflow_collaboration_operations WHERE ${where}`;
}

async function requireActiveSession(client: PoolClient, actor: AuthenticatedSession, workspaceId: string, workflowId: string, sessionId: string, requireMembership = true): Promise<void> {
  const session = await client.query(
    `SELECT 1 FROM workflow_collaboration_sessions session
      WHERE session.id=$1 AND session.workspace_id=$2 AND session.workflow_id=$3
        AND session.closed_at IS NULL AND session.expires_at>now()
        ${requireMembership ? "AND EXISTS(SELECT 1 FROM workflow_collaboration_members member WHERE member.session_id=session.id AND member.account_id=$4)" : ""}`,
    requireMembership ? [sessionId, workspaceId, workflowId, actor.accountId] : [sessionId, workspaceId, workflowId],
  );
  if (!session.rowCount) throw new DomainError("collaboration_session_unavailable", "This collaboration session is unavailable or you have not joined it.", 404);
}
