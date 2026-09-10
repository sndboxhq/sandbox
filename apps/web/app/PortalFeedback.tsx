"use client";

import { ActionFeedback, ToastRegion } from "@sandbox/product-ui";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

interface FeedbackMessage { id: number; tone: "success" | "error" | "info"; message: string }
const FeedbackContext = createContext<(tone: FeedbackMessage["tone"], message: string) => void>(() => undefined);

export function PortalFeedbackProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<FeedbackMessage[]>([]);
  const push = useCallback((tone: FeedbackMessage["tone"], message: string) => {
    const id = Date.now() + Math.random();
    setMessages((current) => [...current.slice(-2), { id, tone, message }]);
    window.setTimeout(() => setMessages((current) => current.filter((item) => item.id !== id)), 5000);
  }, []);
  const value = useMemo(() => push, [push]);
  return <FeedbackContext.Provider value={value}>{children}<ToastRegion className="portal-feedback-region">{messages.map((item) => <ActionFeedback key={item.id} tone={item.tone}>{item.message}</ActionFeedback>)}</ToastRegion></FeedbackContext.Provider>;
}

export function usePortalFeedback() { return useContext(FeedbackContext); }
