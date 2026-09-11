"use client";

import { Check, Copy } from "lucide-react";
import { useActionState, useEffect, useRef, useState, type ReactNode } from "react";
import { usePortalFeedback } from "./PortalFeedback";
import { initialPortalActionResult, type PortalActionResult } from "./action-result";

export function PortalActionForm({
  action,
  hidden,
  children,
  submitLabel,
  pendingLabel = "Working…",
  confirmTitle,
  confirmDescription,
  dangerous = false,
  className = "",
  submitClassName = "",
  submitIcon,
  resetOnSuccess = false,
}: {
  action: (state: PortalActionResult, formData: FormData) => Promise<PortalActionResult>;
  hidden?: Record<string, string>;
  children?: ReactNode;
  submitLabel: string;
  pendingLabel?: string;
  confirmTitle?: string;
  confirmDescription?: string;
  dangerous?: boolean;
  className?: string;
  submitClassName?: string;
  submitIcon?: ReactNode;
  resetOnSuccess?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, initialPortalActionResult);
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  const push = usePortalFeedback();
  const previous = useRef(state);
  const form = useRef<HTMLFormElement>(null);
  const confirmTrigger = useRef<HTMLButtonElement>(null);
  const confirmDialog = useRef<HTMLElement>(null);
  useEffect(() => {
    if (state !== previous.current && state.status !== "idle") {
      if (state.message) push(state.status === "error" ? "error" : "success", state.message);
      setConfirming(false);
      setCopied(false);
      if (state.status === "success" && resetOnSuccess) form.current?.reset();
      if (state.status === "success") window.setTimeout(() => confirmTrigger.current?.focus(), 0);
    }
    previous.current = state;
  }, [push, state]);
  useEffect(() => {
    if (confirming) confirmDialog.current?.focus();
  }, [confirming]);
  useEffect(() => {
    const controls = Array.from(form.current?.elements ?? []).filter((item): item is HTMLElement => item instanceof HTMLElement);
    controls.forEach((control) => {
      if (control.dataset.portalFieldError !== "true") return;
      control.removeAttribute("aria-invalid");
      control.removeAttribute("aria-describedby");
      delete control.dataset.portalFieldError;
    });
    let firstInvalid: HTMLElement | undefined;
    Object.keys(state.fieldErrors ?? {}).forEach((field) => {
      const control = controls.find((candidate) => candidate.getAttribute("name") === field);
      if (!control) return;
      control.setAttribute("aria-invalid", "true");
      control.setAttribute("aria-describedby", `portal-field-error-${field.replace(/[^a-z0-9_-]/gi, "-")}`);
      control.dataset.portalFieldError = "true";
      firstInvalid ??= control;
    });
    firstInvalid?.focus();
  }, [state.fieldErrors]);
  const copyResult = async () => {
    if (!state.copyValue) return;
    try {
      await navigator.clipboard.writeText(state.copyValue);
      setCopied(true);
      push("success", "Invitation link copied.");
    } catch {
      push("error", "The invitation link could not be copied. Select and copy it manually.");
    }
  };
  const submitClasses = `${dangerous ? "danger-action" : ""} ${submitClassName}`.trim() || undefined;
  return (
    <form ref={form} action={formAction} className={className} aria-busy={pending || undefined}>
      {Object.entries(hidden ?? {}).map(([name, value]) => <input type="hidden" name={name} value={value} key={name} />)}
      {children}
      <button ref={confirmTrigger} type={confirmTitle ? "button" : "submit"} className={submitClasses} disabled={pending} onClick={confirmTitle ? () => setConfirming(true) : undefined}>{!pending && submitIcon}{pending ? pendingLabel : submitLabel}</button>
      {state.status === "error" && state.fieldErrors && Object.entries(state.fieldErrors).map(([field, message]) => <small id={`portal-field-error-${field.replace(/[^a-z0-9_-]/gi, "-")}`} className="portal-field-error" key={field}>{message}</small>)}
      {state.copyValue && <div className="portal-action-copy" role="status"><span><strong>Secure invitation link</strong><small>This link expires in 72 hours and should only be shared with the invited person.</small></span><input aria-label="Invitation link" readOnly value={state.copyValue} onFocus={(event) => event.currentTarget.select()} /><button type="button" onClick={() => void copyResult()}>{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}{copied ? "Copied" : state.copyLabel ?? "Copy"}</button></div>}
      {confirming && <div className="portal-confirm-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setConfirming(false)}><section ref={confirmDialog} tabIndex={-1} onKeyDown={(event) => event.key === "Escape" && setConfirming(false)} role="alertdialog" aria-modal="true" aria-labelledby="portal-confirm-title" aria-describedby="portal-confirm-description" className="portal-confirm-dialog"><h2 id="portal-confirm-title">{confirmTitle}</h2><p id="portal-confirm-description">{confirmDescription}</p><div><button type="button" onClick={() => { setConfirming(false); window.setTimeout(() => confirmTrigger.current?.focus(), 0); }}>Cancel</button><button type="submit" className={submitClasses} disabled={pending}>{!pending && submitIcon}{pending ? pendingLabel : submitLabel}</button></div></section></div>}
    </form>
  );
}
