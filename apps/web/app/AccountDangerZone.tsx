"use client";

import { AlertTriangle, KeyRound, LogOut, Trash2 } from "lucide-react";
import { ProductDialog } from "@sandbox/product-ui";
import { useActionState, useEffect, useState } from "react";
import {
  deleteAccountAction,
  revokeAllPersonalTokensAction,
  revokeOtherSessionsAction,
  type AccountDeletionState,
  type AccountMaintenanceState,
} from "./actions";

const initialState: AccountDeletionState = { error: null };
const initialMaintenanceState: AccountMaintenanceState = { error: null, message: null };

export function AccountDangerZone() {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<"sessions" | "tokens">();
  const [state, action, pending] = useActionState(deleteAccountAction, initialState);
  const [sessionState, revokeSessions, sessionsPending] = useActionState(
    revokeOtherSessionsAction,
    initialMaintenanceState,
  );
  const [tokenState, revokeTokens, tokensPending] = useActionState(
    revokeAllPersonalTokensAction,
    initialMaintenanceState,
  );
  useEffect(() => { if (sessionState.message) setConfirming(undefined); }, [sessionState.message]);
  useEffect(() => { if (tokenState.message) setConfirming(undefined); }, [tokenState.message]);

  return (
    <section className="danger-zone">
      <header>
        <span className="settings-card-icon"><AlertTriangle aria-hidden="true" /></span>
        <div><h2>Danger Zone</h2><p>These actions remove access immediately. Use them only when you intend to disconnect people or credentials.</p></div>
      </header>
      <div className="danger-action-list">
        <article>
          <span className="danger-action-icon"><LogOut aria-hidden="true" /></span>
          <div>
            <strong>Sign out other devices</strong>
            <p>Revoke every account session except the browser you are using now.</p>
            <DangerFeedback state={sessionState} />
          </div>
          <button type="button" className="danger-secondary-button" disabled={sessionsPending} onClick={() => setConfirming("sessions")}>Sign out others</button>
        </article>
        <article>
          <span className="danger-action-icon"><KeyRound aria-hidden="true" /></span>
          <div>
            <strong>Revoke all API keys</strong>
            <p>Immediately stop every active personal API key from accessing your account.</p>
            <DangerFeedback state={tokenState} />
          </div>
          <button type="button" className="danger-secondary-button" disabled={tokensPending} onClick={() => setConfirming("tokens")}>Revoke all keys</button>
        </article>
        <article className="danger-critical-action">
          <span className="danger-action-icon"><Trash2 aria-hidden="true" /></span>
          <div>
            <strong>Delete account</strong>
            <p>Permanently remove your personal account and revoke its sessions. Workspace audit records may follow their published retention period.</p>
          </div>
          {!open ? (
            <button className="danger-button" type="button" onClick={() => setOpen(true)}>Delete account…</button>
          ) : (
            <form action={action} className="danger-confirm-form">
              <label><span>Type <strong>DELETE</strong> to confirm</span><input name="confirmation" autoFocus autoComplete="off" /></label>
              {state.error && <p className="form-error" role="alert">{state.error}</p>}
              <div><button type="button" onClick={() => setOpen(false)}>Cancel</button><button className="danger-button" disabled={pending}>{pending ? "Deleting…" : "Permanently delete"}</button></div>
            </form>
          )}
        </article>
      </div>
      <ProductDialog open={confirming === "sessions"} title="Sign out every other device?" description="Every account session except this browser will be revoked immediately." onClose={() => { if (!sessionsPending) setConfirming(undefined); }} dangerous>
        <form action={revokeSessions} className="danger-confirm-form"><DangerFeedback state={sessionState} /><div><button type="button" onClick={() => setConfirming(undefined)} disabled={sessionsPending}>Cancel</button><button className="danger-button" disabled={sessionsPending}>{sessionsPending ? "Signing out…" : "Sign out other devices"}</button></div></form>
      </ProductDialog>
      <ProductDialog open={confirming === "tokens"} title="Revoke every API key?" description="All clients using personal API keys will lose access immediately." onClose={() => { if (!tokensPending) setConfirming(undefined); }} dangerous>
        <form action={revokeTokens} className="danger-confirm-form"><DangerFeedback state={tokenState} /><div><button type="button" onClick={() => setConfirming(undefined)} disabled={tokensPending}>Cancel</button><button className="danger-button" disabled={tokensPending}>{tokensPending ? "Revoking…" : "Revoke all API keys"}</button></div></form>
      </ProductDialog>
    </section>
  );
}

function DangerFeedback({ state }: { state: AccountMaintenanceState }) {
  if (!state.error && !state.message) return null;
  return <span className={state.error ? "danger-feedback error" : "danger-feedback"} role={state.error ? "alert" : "status"}>{state.error ?? state.message}</span>;
}
