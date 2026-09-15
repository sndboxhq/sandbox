import { randomUUID } from "node:crypto";
import type { Pool,QueryResult,QueryResultRow } from "pg";
import type { TransactionalEmail } from "./email.js";

export interface CredentialExpiryNotificationResult { enqueued:number;sent:number;failed:number }

interface CandidateRow { token_id:string;recipient_account_id:string;reminder_days:number }
interface DeliveryRow { id:string;recipient:string;token_name:string;token_prefix:string;expires_at:Date;reminder_days:number }

export class PostgresCredentialExpiryNotifier {
  constructor(private readonly pool:Pool,private readonly email:TransactionalEmail) {}

  async runOnce(now=new Date(),limit=100):Promise<CredentialExpiryNotificationResult>{
    await this.databaseQuery(`
      UPDATE credential_expiry_notifications notification SET status='cancelled',claimed_at=NULL
      FROM access_tokens token
      WHERE token.id=notification.access_token_id AND notification.status NOT IN ('sent','cancelled')
        AND (token.revoked_at IS NOT NULL OR token.expires_at<=$1 OR NOT (
          (token.token_kind='personal' AND token.owner_account_id=notification.recipient_account_id)
          OR (token.token_kind='service_account' AND EXISTS(
            SELECT 1 FROM service_accounts service JOIN service_account_owners owner ON owner.service_account_id=service.id
            JOIN accounts account ON account.id=owner.account_id AND account.account_kind='human'
            WHERE service.id=token.service_account_id AND service.status='active' AND owner.account_id=notification.recipient_account_id
          ))
        ))`,[now]);
    const candidates=await this.databaseQuery<CandidateRow>(`
      WITH recipients AS (
        SELECT token.id token_id,token.expires_at,token.token_kind,token.revoked_at,token.owner_account_id recipient_account_id
        FROM access_tokens token WHERE token.token_kind='personal' AND token.expiry_notification_enabled
        UNION ALL
        SELECT token.id,token.expires_at,token.token_kind,token.revoked_at,owner.account_id
        FROM access_tokens token
        JOIN service_accounts service ON service.id=token.service_account_id AND service.status='active'
        JOIN service_account_owners owner ON owner.service_account_id=service.id
        WHERE token.token_kind='service_account' AND token.expiry_notification_enabled
      )
      SELECT recipient.token_id,recipient.recipient_account_id,threshold.reminder_days
      FROM recipients recipient
      CROSS JOIN (VALUES(7),(1)) threshold(reminder_days)
      WHERE recipient.revoked_at IS NULL AND recipient.expires_at>$1
        AND recipient.expires_at<=$1+(threshold.reminder_days||' days')::interval
        AND (threshold.reminder_days=1 OR recipient.expires_at>$1+interval '1 day')`,[now]);
    let enqueued=0;
    for(const candidate of candidates.rows){
      const inserted=await this.databaseQuery(`INSERT INTO credential_expiry_notifications(id,access_token_id,recipient_account_id,reminder_days,next_attempt_at,created_at) VALUES($1,$2,$3,$4,$5,$5) ON CONFLICT DO NOTHING`,[randomUUID(),candidate.token_id,candidate.recipient_account_id,candidate.reminder_days,now]);
      enqueued+=inserted.rowCount??0;
    }
    let sent=0,failed=0;
    for(let index=0;index<Math.min(Math.max(limit,1),1000);index++){
      const delivery=await this.claim(now);
      if(!delivery)break;
      try{
        await this.email.sendCredentialExpiry({recipient:delivery.recipient,tokenName:delivery.token_name,tokenPrefix:delivery.token_prefix,expiresAt:delivery.expires_at,reminderDays:delivery.reminder_days});
        await this.databaseQuery(`UPDATE credential_expiry_notifications SET status='sent',sent_at=$2,claimed_at=NULL,last_error=NULL WHERE id=$1 AND status='delivering'`,[delivery.id,now]);
        sent++;
      }catch(error){
        const message=(error instanceof Error?error.message:"Unknown email delivery failure").slice(0,500);
        await this.databaseQuery(`UPDATE credential_expiry_notifications SET status='failed',claimed_at=NULL,last_error=$2,next_attempt_at=$3::timestamptz+(LEAST(attempts,24)||' hours')::interval WHERE id=$1 AND status='delivering'`,[delivery.id,message,now]);
        failed++;
      }
    }
    return{enqueued,sent,failed};
  }

  private async claim(now:Date):Promise<DeliveryRow|null>{
    const result=await this.databaseQuery<DeliveryRow>(`
      WITH candidate AS (
        SELECT notification.id FROM credential_expiry_notifications notification
        JOIN access_tokens token ON token.id=notification.access_token_id
        WHERE token.revoked_at IS NULL AND token.expires_at>$1 AND (
          (notification.status IN ('pending','failed') AND notification.next_attempt_at<=$1)
          OR (notification.status='delivering' AND notification.claimed_at<=$1-interval '15 minutes')
        ) AND (
          (token.token_kind='personal' AND token.owner_account_id=notification.recipient_account_id)
          OR (token.token_kind='service_account' AND EXISTS(
            SELECT 1 FROM service_accounts service JOIN service_account_owners owner ON owner.service_account_id=service.id
            JOIN accounts account ON account.id=owner.account_id AND account.account_kind='human'
            WHERE service.id=token.service_account_id AND service.status='active' AND owner.account_id=notification.recipient_account_id
          ))
        )
        ORDER BY notification.next_attempt_at,notification.created_at FOR UPDATE OF notification SKIP LOCKED LIMIT 1
      ), claimed AS (
        UPDATE credential_expiry_notifications notification
        SET status='delivering',claimed_at=$1,attempts=attempts+1
        FROM candidate WHERE notification.id=candidate.id RETURNING notification.*
      )
      SELECT claimed.id,account.primary_email recipient,token.name token_name,token.token_prefix,token.expires_at,claimed.reminder_days
      FROM claimed JOIN access_tokens token ON token.id=claimed.access_token_id JOIN accounts account ON account.id=claimed.recipient_account_id`,[now]);
    return result.rows[0]??null;
  }

  private async databaseQuery<Row extends QueryResultRow=QueryResultRow>(sql:string,values:unknown[]=[]):Promise<QueryResult<Row>>{
    const client=await this.pool.connect();
    try{
      await client.query("BEGIN");
      await client.query(`SELECT set_config('app.system_role','credential_expiry_notifier',true)`);
      const result=await client.query<Row>(sql,values);
      await client.query("COMMIT");
      return result;
    }catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}finally{client.release();}
  }
}
