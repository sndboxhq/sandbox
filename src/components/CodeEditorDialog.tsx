import { AlertCircle, Bot, Braces, Check, CheckCircle2, Code2, FileCode2, Palette, Send, Sparkles, TriangleAlert, X } from "lucide-react";
import { displayIssueCode, issueDocumentationUrl } from "../issues";
import Prism from "prismjs";
import "prismjs/components/prism-css";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-markup";
import "prismjs/components/prism-python";
import { useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import Editor from "react-simple-code-editor";
import { api } from "../api";
import { diagnoseCode } from "../codeDiagnostics";
import type { ConnectionMetadata } from "../types";
import { AiActivityStatus } from "./AiActivityStatus";
import { Dialog } from "./ui/Dialog";
import { CustomSelect } from "./ui/CustomSelect";

export type CodeLanguage = "python" | "html" | "javascript" | "css";

const AI_PROVIDERS = new Set(["openai", "anthropic", "openai_compatible"]);
const INITIAL_CODE_CHAT = {
  id: "hello",
  role: "assistant" as const,
  text: "Describe what you want to build or change. I’ll use the current file as context and update the unsaved draft.",
};

interface CodeChatMessage {
  id: string;
  role: "assistant" | "user";
  text: string;
}

const languages: Array<{
  id: CodeLanguage;
  label: string;
  extension: string;
  icon: typeof Code2;
}> = [
  { id: "python", label: "Python", extension: ".py", icon: Code2 },
  { id: "html", label: "HTML", extension: ".html", icon: FileCode2 },
  { id: "javascript", label: "JavaScript", extension: ".js", icon: Braces },
  { id: "css", label: "CSS", extension: ".css", icon: Palette },
];

export function CodeEditorDialog({
  open,
  language,
  value,
  onOpenChange,
  onSave,
  lockedLanguage = false,
}: {
  open: boolean;
  language: CodeLanguage;
  value: string;
  onOpenChange: (open: boolean) => void;
  onSave: (language: CodeLanguage, value: string) => void;
  lockedLanguage?: boolean;
}) {
  const [draftLanguage, setDraftLanguage] = useState(language);
  const [draft, setDraft] = useState(value);
  const [connections, setConnections] = useState<ConnectionMetadata[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiActivities, setAiActivities] = useState<string[]>([]);
  const [aiMessages, setAiMessages] = useState<CodeChatMessage[]>([INITIAL_CODE_CHAT]);
  const aiEndRef = useRef<HTMLDivElement>(null);
  const aiComposerRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    setDraftLanguage(language);
    setDraft(value);
    setAiOpen(false);
    setAiPrompt("");
    setAiBusy(false);
    setAiActivities([]);
    setAiMessages([INITIAL_CODE_CHAT]);
  }, [language, open, value]);
  useEffect(() => {
    if (!open) return;
    void api.listConnections().then((items) => {
      const ai = items.filter((item) => AI_PROVIDERS.has(item.provider) && item.status === "connected");
      setConnections(ai);
      setConnectionId((current) => ai.some((item) => item.id === current) ? current : (ai[0]?.id ?? ""));
    }).catch(() => {
      setConnections([]);
      setConnectionId("");
    });
  }, [open]);
  useEffect(() => {
    aiEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [aiBusy, aiMessages]);
  useEffect(() => {
    if (!aiOpen) return;
    const frame = window.requestAnimationFrame(() => aiComposerRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [aiOpen]);

  const selected = languages.find((item) => item.id === draftLanguage)!;
  const deferredDraft = useDeferredValue(draft);
  const diagnostics = useMemo(
    () => diagnoseCode(draftLanguage, deferredDraft),
    [deferredDraft, draftLanguage],
  );
  const errorCount = diagnostics.filter((item) => item.severity === "error").length;
  const warningCount = diagnostics.filter((item) => item.severity === "warning").length;
  const grammar = useMemo(
    () => Prism.languages[draftLanguage === "html" ? "markup" : draftLanguage],
    [draftLanguage],
  );
  const save = () => {
    onSave(draftLanguage, draft);
    onOpenChange(false);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      save();
    }
  };
  const writeWithAi = async () => {
    const instruction = aiPrompt.trim();
    if (!connectionId || !instruction || aiBusy) return;
    setAiPrompt("");
    setAiMessages((current) => [...current, { id: crypto.randomUUID(), role: "user", text: instruction }]);
    setAiBusy(true);
    const connection = connections.find((item) => item.id === connectionId);
    setAiActivities([
      `Waiting for ${String(connection?.metadata.model ?? connection?.displayName ?? "the selected model")} to return updated code`,
    ]);
    try {
      const result = await api.generateCodeWithAi(connectionId, draftLanguage, instruction, draft);
      setAiActivities((current) => [...current, "Checking the returned code for syntax and type problems"]);
      const returnedDiagnostics = diagnoseCode(draftLanguage, result.code);
      const returnedErrors = returnedDiagnostics.filter((item) => item.severity === "error");
      if (returnedErrors.length) {
        throw new Error(`The generated code failed checking: ${returnedErrors[0].message}`);
      }
      setDraft(result.code);
      setAiMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          text: `Updated main${selected.extension}. Review the changes in the editor, then save when you’re ready.`,
        },
      ]);
    } catch (error) {
      setAiMessages((current) => [
        ...current,
        { id: crypto.randomUUID(), role: "assistant", text: `I couldn’t update the code. ${String(error)}` },
      ]);
    } finally {
      setAiBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Edit code"
      description={`Editing main${selected.extension} · changes are applied only when you save.`}
      width={aiOpen ? "xlarge" : "large"}
      footer={
        <>
          <button className="button" type="button" onClick={() => onOpenChange(false)}>Cancel</button>
          <button className="button primary" type="button" onClick={save}>
            <Check size={14} /> Save code
          </button>
        </>
      }
    >
      <div className={`code-editor-dialog${aiOpen ? " code-editor-ai-open" : ""}`}>
        <div className="code-language-tabs" role="tablist" aria-label="Code language">
          {languages.filter(item=>!lockedLanguage||item.id===draftLanguage).map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={draftLanguage === item.id}
                onClick={() => setDraftLanguage(item.id)}
              >
                <Icon size={14} /> {item.label}
              </button>
            );
          })}
          <button
            className="code-ai-button"
            type="button"
            onClick={() => setAiOpen((current) => !current)}
            aria-expanded={aiOpen}
            aria-controls="code-ai-chat"
          >
            <Sparkles size={13} /> Code with AI
          </button>
          <span className={diagnostics.length ? "code-check-has-problems" : "code-check-clean"}>
            {diagnostics.length ? <TriangleAlert size={12} /> : <CheckCircle2 size={12} />}
            {diagnostics.length ? `${diagnostics.length} problem${diagnostics.length === 1 ? "" : "s"}` : "Types look good"}
          </span>
        </div>
        {(draftLanguage === "javascript" || draftLanguage === "python") && (
          <div className="info-note" role="note">Runtime API: <code>input</code>, <code>items</code>, <code>nodes</code>, <code>trigger</code>, <code>workflow</code>, <code>execution</code>, <code>helpers</code>{draftLanguage === "javascript" ? <>, and <code>ctx.log()</code></> : <>. Set <code>result</code> or define <code>main(ctx)</code></>}.</div>
        )}
        <div className="code-editor-workspace">
          <div className="code-editor-main">
            <div className="code-editor-scroll">
              <div className="code-line-numbers" aria-hidden="true">
                {draft.split("\n").map((_, index) => <span key={index}>{index + 1}</span>)}
              </div>
              <Editor
                value={draft}
                onValueChange={setDraft}
                highlight={(code) => Prism.highlight(code, grammar, draftLanguage)}
                padding={14}
                tabSize={2}
                insertSpaces
                textareaClassName="code-editor-textarea"
                preClassName="code-editor-highlight"
                onKeyDown={handleKeyDown}
                aria-label={`${selected.label} code editor`}
                style={{
                  minHeight: "min(60vh, 620px)",
                  fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
                  fontSize: 12,
                  lineHeight: 1.65,
                  flex: 1,
                }}
              />
            </div>
            <section className="code-problems" aria-label="Code problems" aria-live="polite">
              <header>
                <span><AlertCircle size={13} /> Problems <b>{diagnostics.length}</b></span>
                <small>{errorCount} error{errorCount === 1 ? "" : "s"} · {warningCount} warning{warningCount === 1 ? "" : "s"} · code is never executed</small>
              </header>
              <div className="code-problem-list">
                {diagnostics.length ? diagnostics.map((diagnostic, index) => (
                  <div className={`code-problem code-problem-${diagnostic.severity}`} key={`${diagnostic.line}:${diagnostic.column}:${diagnostic.message}:${index}`}>
                    <span>{diagnostic.severity === "error" ? <AlertCircle size={13} /> : <TriangleAlert size={13} />}</span>
                    <p>{diagnostic.message}</p>
                    <code>
                      <a href={issueDocumentationUrl(diagnostic.severity)} target="_blank" rel="noreferrer">
                        {displayIssueCode(diagnostic.code, diagnostic.severity)}
                      </a>
                      {" · "}Ln {diagnostic.line}, Col {diagnostic.column}
                    </code>
                  </div>
                )) : (
                  <div className="code-problems-empty"><CheckCircle2 size={14} /><span><b>No problems found</b><small>{draft.trim() ? "The live checker found no syntax or basic type errors." : "Start typing to check this file."}</small></span></div>
                )}
              </div>
              {errorCount > 0 && <p className="code-error-summary">Fix {errorCount} error{errorCount === 1 ? "" : "s"} before running this code node.</p>}
            </section>
          </div>
          {aiOpen && (
            <aside id="code-ai-chat" className="code-ai-chat" aria-label="AI coding assistant">
              <header>
                <span><Sparkles size={14} /></span>
                <div><b>AI coding assistant</b><small>Current file is included as context</small></div>
                <button className="icon-button" type="button" aria-label="Close AI coding assistant" onClick={() => setAiOpen(false)}><X size={14} /></button>
              </header>
              {connections.length > 0 && (
                <label className="code-ai-provider">
                  <Bot size={12} />
                  <CustomSelect aria-label="AI connection for code" value={connectionId} onChange={(event) => setConnectionId(event.target.value)}>
                    {connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.displayName} · {String(connection.metadata.model ?? "model")}</option>)}
                  </CustomSelect>
                </label>
              )}
              <div className="code-ai-messages" aria-live="polite">
                {aiMessages.map((message) => (
                  <div className={`code-ai-message code-ai-message-${message.role}`} key={message.id}>
                    {message.role === "assistant" && <span><Sparkles size={10} /></span>}
                    <p>{message.text}</p>
                  </div>
                ))}
                {connections.length === 0 && (
                  <p className="code-ai-empty">Connect ChatGPT, Claude, or a local AI in Settings → Connections to use the coding assistant.</p>
                )}
                {aiBusy && <AiActivityStatus active activities={aiActivities} />}
                <div ref={aiEndRef} />
              </div>
              <form className="code-ai-composer" onSubmit={(event) => { event.preventDefault(); void writeWithAi(); }}>
                <textarea
                  ref={aiComposerRef}
                  aria-label="Message AI coding assistant"
                  value={aiPrompt}
                  placeholder={`Ask AI to write or change this ${selected.label} file…`}
                  disabled={connections.length === 0 || aiBusy}
                  onChange={(event) => setAiPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void writeWithAi();
                    }
                  }}
                />
                <div>
                  <small>Edits remain unsaved until you choose Save code.</small>
                  <button className="ai-send" disabled={!aiPrompt.trim() || !connectionId || aiBusy} aria-label="Send coding request">
                    <Send size={14} />
                  </button>
                </div>
              </form>
            </aside>
          )}
        </div>
      </div>
    </Dialog>
  );
}
