import { Check, ChevronRight, X } from "lucide-react";
import { useState } from "react";

const DISMISSAL_KEY = "sandbox.getting-started.desktop.v1";

export interface GettingStartedStep {
  id: string;
  label: string;
  complete: boolean;
  actionLabel: string;
  onAction: () => void;
  optional?: boolean;
}

export function DesktopGettingStarted({ steps }: { steps: GettingStartedStep[] }) {
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(DISMISSAL_KEY) === "dismissed",
  );
  if (dismissed) return null;
  const completed = steps.filter((step) => step.complete).length;
  return (
    <section className="getting-started-card" aria-labelledby="desktop-getting-started-title">
      <header>
        <div>
          <span className="eyebrow">Getting started</span>
          <h2 id="desktop-getting-started-title">Your first reliable workflow</h2>
          <p>{completed} of {steps.length} steps complete. Progress is derived from workflows on this device.</p>
        </div>
        <button
          className="icon-button"
          aria-label="Dismiss getting started"
          onClick={() => {
            localStorage.setItem(DISMISSAL_KEY, "dismissed");
            setDismissed(true);
          }}
        >
          <X size={15} />
        </button>
      </header>
      <div className="getting-started-steps">
        {steps.map((step) => (
          <button key={step.id} className={step.complete ? "complete" : ""} onClick={step.onAction}>
            <span className="step-check" aria-hidden="true">{step.complete ? <Check size={13} /> : null}</span>
            <span><b>{step.label}</b>{step.optional && <small>Optional</small>}</span>
            <em>{step.complete ? "Done" : step.actionLabel}</em>
            <ChevronRight size={14} />
          </button>
        ))}
      </div>
    </section>
  );
}
