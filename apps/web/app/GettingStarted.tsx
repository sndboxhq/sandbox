"use client";

import { Check, X } from "lucide-react";
import { useEffect, useState } from "react";

export interface GettingStartedStep { id: string; label: string; description: string; complete: boolean; href: string }

export function GettingStarted({ storageKey, title, steps }: { storageKey: string; title: string; steps: GettingStartedStep[] }) {
  const [dismissed, setDismissed] = useState(true);
  useEffect(() => setDismissed(localStorage.getItem(storageKey) === "dismissed"), [storageKey]);
  if (dismissed || steps.every((step) => step.complete)) return null;
  return <section className="getting-started" aria-labelledby={`${storageKey}-title`}><header><div><span>GETTING STARTED</span><h2 id={`${storageKey}-title`}>{title}</h2></div><button type="button" aria-label="Dismiss getting started" onClick={() => { localStorage.setItem(storageKey, "dismissed"); setDismissed(true); }}><X /></button></header><ol>{steps.map((step) => <li className={step.complete ? "complete" : ""} key={step.id}><span>{step.complete ? <Check /> : steps.findIndex((item) => item.id === step.id) + 1}</span><div><strong>{step.label}</strong><small>{step.description}</small></div>{!step.complete && <a href={step.href}>Start</a>}</li>)}</ol></section>;
}
