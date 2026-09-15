import { useEffect, useRef } from "react";
import { useToast } from "./ui/Toast";

const messageFor = (value: unknown): string => {
  if (value instanceof DOMException && value.name === "AbortError") return "";
  const message = value instanceof Error ? value.message : typeof value === "string" ? value : "An unexpected background task failed.";
  return message.trim().slice(0, 240);
};

export function RuntimeErrorGuard() {
  const toast = useToast();
  const recentlyReported = useRef(new Map<string, number>());
  useEffect(() => {
    const report = (value: unknown) => {
      const message = messageFor(value);
      if (!message || /cancelled|canceled/i.test(message)) return;
      const now = Date.now();
      const previous = recentlyReported.current.get(message) ?? 0;
      if (now - previous < 5_000) return;
      recentlyReported.current.set(message, now);
      for (const [key, time] of recentlyReported.current)
        if (now - time > 30_000) recentlyReported.current.delete(key);
      toast.push(`A background task failed: ${message}`, "error");
    };
    const rejection = (event: PromiseRejectionEvent) => report(event.reason);
    const runtime = (event: ErrorEvent) => report(event.error ?? event.message);
    window.addEventListener("unhandledrejection", rejection);
    window.addEventListener("error", runtime);
    return () => {
      window.removeEventListener("unhandledrejection", rejection);
      window.removeEventListener("error", runtime);
    };
  }, [toast]);
  return null;
}
