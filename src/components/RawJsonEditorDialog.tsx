import { Check, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { Dialog } from "./ui/Dialog";

export function RawJsonEditorDialog({ open, value, onOpenChange, onSave }: {
  open: boolean;
  value: Record<string, unknown>;
  onOpenChange: (open: boolean) => void;
  onSave: (value: Record<string, unknown>) => void;
}) {
  const formattedValue = JSON.stringify(value, null, 2);
  const [draft, setDraft] = useState(formattedValue);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    setDraft(formattedValue);
    setError("");
  }, [formattedValue, open]);
  const format = () => {
    try { setDraft(JSON.stringify(JSON.parse(draft), null, 2)); setError(""); }
    catch (parseError) { setError(parseError instanceof Error ? parseError.message : "Enter valid JSON."); }
  };
  const save = () => {
    try {
      const parsed: unknown = JSON.parse(draft);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
        setError("Node configuration must be a JSON object.");
        return;
      }
      onSave(parsed as Record<string, unknown>);
      onOpenChange(false);
    } catch (parseError) { setError(parseError instanceof Error ? parseError.message : "Enter valid JSON."); }
  };
  return <Dialog open={open} onOpenChange={onOpenChange} title="Edit node configuration" description="Advanced view. Changes are only applied when you save valid JSON." width="large" footer={<><button className="button" type="button" onClick={() => onOpenChange(false)}>Cancel</button><button className="button primary" type="button" onClick={save}><Check size={14} /> Save JSON</button></>}>
    <div className="raw-json-editor">
      <div className="raw-json-toolbar"><span>Configuration object</span><button className="button" type="button" onClick={format}><RotateCcw size={13} /> Format JSON</button></div>
      <textarea aria-label="Node configuration JSON" spellCheck={false} value={draft} onChange={(event) => { setDraft(event.target.value); setError(""); }} aria-invalid={Boolean(error)} aria-describedby={error ? "raw-json-error" : undefined} />
      {error ? <p className="raw-json-error" id="raw-json-error" role="alert">{error}</p> : <p className="raw-json-help">Tip: use Format JSON to re-indent the current draft before saving.</p>}
    </div>
  </Dialog>;
}
