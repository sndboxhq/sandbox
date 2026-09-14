import type { Pool,QueryResult } from "pg";
import { describe,expect,it,vi } from "vitest";
import { PostgresCredentialExpiryNotifier } from "./credential_notifications.js";

const result=(rows:unknown[]=[],rowCount=rows.length)=>({rows,rowCount,command:"",oid:0,fields:[]}) as QueryResult;
const delivery={id:"11111111-1111-4111-8111-111111111111",recipient:"owner@example.com",token_name:"Deploy key",token_prefix:"sbx_sa_abcdefghijkl",expires_at:new Date("2026-08-29T12:00:00.000Z"),reminder_days:1};
const pool=(query:(sql:string,values?:unknown[])=>Promise<QueryResult>)=>({connect:async()=>({query:async(sql:string,values?:unknown[])=>sql==="BEGIN"||sql==="COMMIT"||sql==="ROLLBACK"||sql.includes("set_config")?result():query(sql,values),release:()=>undefined})}) as unknown as Pool;

describe("credential expiry notification sweep",()=>{
  it("enqueues and delivers each eligible reminder",async()=>{
    let claims=0;
    const query=vi.fn(async(sql:string)=>{
      if(sql.includes("SET status='cancelled'"))return result();
      if(sql.includes("WITH recipients AS"))return result([{token_id:"22222222-2222-4222-8222-222222222222",recipient_account_id:"33333333-3333-4333-8333-333333333333",reminder_days:1}]);
      if(sql.includes("INSERT INTO credential_expiry_notifications"))return result([],1);
      if(sql.includes("WITH candidate AS"))return result(claims++===0?[delivery]:[]);
      if(sql.includes("SET status='sent'"))return result([],1);
      throw new Error(`Unexpected query: ${sql}`);
    });
    const sendCredentialExpiry=vi.fn(async()=>undefined);
    const notifier=new PostgresCredentialExpiryNotifier(pool(query),{sendInvitation:async()=>undefined,sendCredentialExpiry});
    await expect(notifier.runOnce(new Date("2026-08-29T00:00:00.000Z"))).resolves.toEqual({enqueued:1,sent:1,failed:0});
    expect(sendCredentialExpiry).toHaveBeenCalledWith(expect.objectContaining({recipient:delivery.recipient,tokenPrefix:delivery.token_prefix,reminderDays:1}));
  });

  it("records provider failures for a delayed retry without failing the sweep",async()=>{
    let claims=0;
    const query=vi.fn(async(sql:string)=>{
      if(sql.includes("SET status='cancelled'")||sql.includes("WITH recipients AS"))return result();
      if(sql.includes("WITH candidate AS"))return result(claims++===0?[delivery]:[]);
      if(sql.includes("SET status='failed'"))return result([],1);
      throw new Error(`Unexpected query: ${sql}`);
    });
    const notifier=new PostgresCredentialExpiryNotifier(pool(query),{sendInvitation:async()=>undefined,sendCredentialExpiry:async()=>{throw new Error("provider unavailable");}});
    await expect(notifier.runOnce(new Date("2026-08-29T00:00:00.000Z"))).resolves.toEqual({enqueued:0,sent:0,failed:1});
    expect(query).toHaveBeenCalledWith(expect.stringContaining("SET status='failed'"),expect.arrayContaining([delivery.id,"provider unavailable"]));
    expect(query).toHaveBeenCalledWith(expect.stringContaining("$3::timestamptz+"),expect.any(Array));
  });
});
