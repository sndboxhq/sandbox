import { createHash } from "node:crypto";
import type { Pool, QueryResult } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresCollaborationService } from "./collaboration.js";
import type { AuthenticatedSession } from "./types.js";

const actor:AuthenticatedSession={
  accountId:"11111111-1111-4111-8111-111111111111",sessionId:"22222222-2222-4222-8222-222222222222",subject:"identity|one",email:"one@example.com",
  issuedAt:new Date(),expiresAt:new Date(Date.now()+60_000),authenticationMethods:["passkey"],platformPermissions:[],
};
const workspaceId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",workflowId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",sessionId="cccccccc-cccc-4ccc-8ccc-cccccccccccc",operationId="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const result=(rows:unknown[]=[],rowCount=rows.length)=>({rows,rowCount,command:"",oid:0,fields:[]}) as QueryResult;

describe("PostgresCollaborationService",()=>{
  it("rejects ciphertext hash mismatches before opening a transaction",async()=>{
    const connect=vi.fn();
    const service=new PostgresCollaborationService({connect} as unknown as Pool);
    await expect(service.append(actor,workspaceId,workflowId,sessionId,{operationId,baseSequence:0,clientSequence:1,encryptedPayload:Buffer.alloc(32,3).toString("base64"),payloadHash:`sha256:${"0".repeat(64)}`,createdAt:new Date().toISOString()})).rejects.toMatchObject({code:"collaboration_payload_hash_mismatch"});
    expect(connect).not.toHaveBeenCalled();
  });

  it("locks the session sequence before its idempotent duplicate check",async()=>{
    const encrypted=Buffer.alloc(32,7),encryptedPayload=encrypted.toString("base64"),payloadHash=`sha256:${createHash("sha256").update(encrypted).digest("hex")}`,now=new Date();
    const sqlCalls:string[]=[];
    const query=vi.fn(async(sql:string)=>{
      sqlCalls.push(sql);
      if(sql==="BEGIN"||sql==="COMMIT"||sql==="ROLLBACK")return result();
      if(sql.includes("SELECT 1 FROM workflow_collaboration_sessions session"))return result([{"?column?":1}]);
      if(sql.includes("SELECT latest_sequence")&&sql.includes("FOR UPDATE"))return result([{latest_sequence:"4"}]);
      if(sql.includes("FROM workflow_collaboration_operations"))return result([{session_id:sessionId,sequence:"4",operation_id:operationId,workflow_id:workflowId,actor_account_id:actor.accountId,base_sequence:"3",client_sequence:"1",encrypted_payload:encryptedPayload,payload_hash:payloadHash,client_created_at:now,accepted_at:now}]);
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const client={query,release:vi.fn()},service=new PostgresCollaborationService({connect:vi.fn(async()=>client)} as unknown as Pool);
    const operation=await service.append(actor,workspaceId,workflowId,sessionId,{operationId,baseSequence:3,clientSequence:1,encryptedPayload,payloadHash,createdAt:now.toISOString()});
    expect(operation).toMatchObject({operationId,sequence:4});
    const lock=sqlCalls.findIndex(sql=>sql.includes("SELECT latest_sequence"));
    const duplicate=sqlCalls.findIndex(sql=>sql.includes("FROM workflow_collaboration_operations"));
    expect(lock).toBeGreaterThan(-1);expect(duplicate).toBeGreaterThan(lock);
    expect(sqlCalls.some(sql=>sql.includes("INSERT INTO workflow_collaboration_operations"))).toBe(false);
    expect(client.release).toHaveBeenCalled();
  });
});
