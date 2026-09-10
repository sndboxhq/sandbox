import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { AlertCircle, CheckCircle2, LoaderCircle } from "lucide-react";
import "./primitives.css";

export type StatusTone = "neutral" | "info" | "success" | "warning" | "danger";

export interface ProductButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: "default" | "primary" | "danger";
  busy?: boolean;
  busyLabel?: string;
}

export function ProductButton({
  tone = "default",
  busy = false,
  busyLabel = "Working…",
  className = "",
  disabled,
  children,
  ...props
}: ProductButtonProps) {
  return (
    <button
      {...props}
      className={`product-button product-button-${tone} ${className}`.trim()}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
    >
      {busy && <LoaderCircle className="product-spin" aria-hidden="true" size={14} />}
      {busy ? busyLabel : children}
    </button>
  );
}

export function StatusBadge({
  tone = "neutral",
  children,
  className = "",
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: StatusTone }) {
  return <span {...props} className={`product-status product-status-${tone} ${className}`.trim()}>{children}</span>;
}

export interface ActionFeedbackProps extends HTMLAttributes<HTMLDivElement> {
  tone: "success" | "error" | "info";
  children: ReactNode;
}

export function ActionFeedback({ tone, children, className = "", ...props }: ActionFeedbackProps) {
  const Icon = tone === "success" ? CheckCircle2 : AlertCircle;
  return (
    <div
      {...props}
      className={`product-feedback product-feedback-${tone} ${className}`.trim()}
      role={tone === "error" ? "alert" : "status"}
      aria-live={tone === "error" ? "assertive" : "polite"}
    >
      <Icon aria-hidden="true" size={15} />
      <span>{children}</span>
    </div>
  );
}

export function EmptyState({ icon, title, description, action, className = "" }: {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
  className?: string;
}) {
  return <section className={`product-empty ${className}`.trim()}>{icon}<h2>{title}</h2><p>{description}</p>{action}</section>;
}

export function ErrorState({ title = "Something went wrong", description, action, className = "" }: {
  title?: string;
  description: string;
  action?: ReactNode;
  className?: string;
}) {
  return <section className={`product-empty product-error ${className}`.trim()} role="alert"><AlertCircle aria-hidden="true" /><h2>{title}</h2><p>{description}</p>{action}</section>;
}

export function ToastRegion({ children, label = "Notifications", className = "" }: {
  children: ReactNode;
  label?: string;
  className?: string;
}) {
  return <div className={`product-toast-region ${className}`.trim()} role="region" aria-label={label}>{children}</div>;
}

export function LoadingState({ label = "Loading…", rows = 3 }: { label?: string; rows?: number }) {
  return <div className="product-loading" role="status" aria-label={label}>{Array.from({ length: rows }, (_, index) => <span key={index} />)}</div>;
}
