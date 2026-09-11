import { AlertTriangle, Send } from "lucide-react";
import { useState } from "react";
import { api } from "../api";
import type { BugReportDraft } from "../types";
import { Dialog } from "./ui/Dialog";
import { useToast } from "./ui/Toast";

const initialDraft: BugReportDraft = {
  summary: "",
  description: "",
};

interface BugReportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentView: string;
}

export function BugReportDialog({
  open,
  onOpenChange,
  currentView,
}: BugReportDialogProps) {
  const toast = useToast();
  const [draft, setDraft] = useState(initialDraft);
  const [includeDiagnostics, setIncludeDiagnostics] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async () => {
    if (draft.summary.trim().length < 4 || draft.description.trim().length < 10)
      return;
    setSending(true);
    setError(undefined);
    try {
      const report: BugReportDraft = includeDiagnostics
        ? {
            ...draft,
            diagnostics: {
              "App version": "0.7.10-beta.2",
              View: currentView,
              Platform: navigator.platform || "Unknown",
              Locale: navigator.language,
              "Time zone": Intl.DateTimeFormat().resolvedOptions().timeZone,
              Runtime: navigator.userAgent,
            },
          }
        : draft;
      const receipt = await api.submitBugReport(report);
      toast.push(`Bug report ${receipt.reportId} sent.`, "success");
      setDraft(initialDraft);
      setIncludeDiagnostics(false);
      onOpenChange(false);
    } catch (value) {
      setError(String(value));
    } finally {
      setSending(false);
    }
  };

  const canSubmit =
    draft.summary.trim().length >= 4 &&
    draft.description.trim().length >= 10 &&
    !sending;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Report a bug"
      description="Send an issue directly to the sndbox team."
      footer={
        <>
          <button
            className="button"
            disabled={sending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </button>
          <button
            className="button primary"
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            <Send size={14} />
            {sending ? "Sending…" : "Send report"}
          </button>
        </>
      }
    >
      <div className="bug-report-simple">
        <label className="field">
          <span>What is your issue?</span>
          <input
            autoFocus
            aria-label="What is your issue?"
            placeholder="Briefly describe the issue"
            maxLength={120}
            value={draft.summary}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                summary: event.target.value,
              }))
            }
          />
        </label>

        <label className="field">
          <span>What happened?</span>
          <textarea
            aria-label="What happened?"
            placeholder="Tell us what happened"
            rows={7}
            maxLength={2000}
            value={draft.description}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                description: event.target.value,
              }))
            }
          />
        </label>

        <label className="bug-report-diagnostics-toggle">
          <input
            type="checkbox"
            checked={includeDiagnostics}
            onChange={(event) => setIncludeDiagnostics(event.target.checked)}
          />
          <span>
            <b>Add diagnostic data</b>
            <small>App version, current screen, platform, locale, and runtime.</small>
          </span>
        </label>

        {error && (
          <div className="bug-report-error" role="alert">
            <AlertTriangle size={14} />
            <span>{error}</span>
          </div>
        )}
      </div>
    </Dialog>
  );
}
