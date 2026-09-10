"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import "./primitives.css";

const focusable = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function ProductDialog({ open, title, description, children, onClose, dangerous = false }: {
  open: boolean;
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  dangerous?: boolean;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const panel = useRef<HTMLElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    window.setTimeout(() => (panel.current?.querySelector<HTMLElement>(focusable) ?? panel.current)?.focus(), 0);
    return () => {
      window.setTimeout(() => restoreFocus.current?.focus(), 0);
    };
  }, [open]);
  if (!open) return null;
  return <div className="product-dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section
      ref={panel}
      className={`product-dialog ${dangerous ? "product-dialog-danger" : ""}`.trim()}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
        if (event.key !== "Tab") return;
        const items = Array.from(panel.current?.querySelectorAll<HTMLElement>(focusable) ?? []);
        if (!items.length) { event.preventDefault(); panel.current?.focus(); return; }
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}
    >
      <h2 id={titleId}>{title}</h2>
      {description && <p id={descriptionId}>{description}</p>}
      {children}
    </section>
  </div>;
}
