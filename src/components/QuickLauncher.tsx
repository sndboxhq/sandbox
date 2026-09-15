import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Play, Search, Star, Workflow } from "lucide-react";
import { api } from "../api";
import type { WorkflowSummary } from "../types";
import "../quickLauncher.css";

function searchable(item: WorkflowSummary) {
  return [
    item.workflow.name,
    item.workflow.description,
    item.metadata.folder,
    ...item.metadata.tags,
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
}

function rank(item: WorkflowSummary) {
  const favourite = item.metadata.favorite ? 10_000_000_000_000 : 0;
  const recent = item.metadata.lastOpenedAt
    ? Date.parse(item.metadata.lastOpenedAt)
    : 0;
  return favourite + recent;
}

export function QuickLauncher() {
  const input = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<WorkflowSummary[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    void api
      .listWorkflows(false)
      .then((workflows) =>
        setItems(
          workflows
            .filter((item) => !item.metadata.archivedAt)
            .sort((left, right) => rank(right) - rank(left)),
        ),
      )
      .catch((value) => setError(String(value)));
    input.current?.focus();
  }, []);

  const results = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return (term ? items.filter((item) => searchable(item).includes(term)) : items).slice(
      0,
      10,
    );
  }, [items, query]);

  useEffect(() => setSelected(0), [query]);

  const choose = async (item: WorkflowSummary, run: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      if (run) {
        if (!item.workflow.enabled)
          throw new Error("Enable this workflow before running it from the launcher.");
        const issues = await api.validateWorkflow(item.workflow);
        const blocking = issues.find((issue) => issue.severity === "error");
        if (blocking)
          throw new Error(`${blocking.code}: ${blocking.message}`);
        const gates = await api.evaluateNodeGates(item.workflow, "local");
        const blocked = Object.values(gates).find((gate) => gate.state !== "available");
        if (blocked) throw new Error(`${blocked.code}: ${blocked.message}`);
        await api.runWorkflow(item.workflow.id);
      }
      await api.revealWorkflow(item.workflow.id);
    } catch (value) {
      setError(String(value));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="quick-launcher" aria-label="Quick launcher">
      <header>
        <span className="quick-launcher-mark"><Workflow size={15} /></span>
        <div>
          <b>Quick launcher</b>
          <small>Open or run a workflow</small>
        </div>
        <kbd>Esc</kbd>
      </header>
      <label className="quick-launcher-search">
        <Search size={15} />
        <input
          ref={input}
          aria-label="Search workflows"
          value={query}
          placeholder="Search names, descriptions, folders, or tags"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setSelected((value) => Math.min(results.length - 1, value + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setSelected((value) => Math.max(0, value - 1));
            } else if (event.key === "Enter" && results[selected]) {
              event.preventDefault();
              void choose(results[selected], event.ctrlKey || event.metaKey);
            } else if (event.key === "Escape") {
              void getCurrentWebviewWindow().hide();
            }
          }}
        />
      </label>
      <section className="quick-launcher-results" role="listbox" aria-label="Workflows">
        {results.map((item, index) => (
          <button
            key={item.workflow.id}
            type="button"
            role="option"
            aria-selected={index === selected}
            className={index === selected ? "selected" : ""}
            onMouseEnter={() => setSelected(index)}
            onClick={() => void choose(item, false)}
          >
            <span className="quick-launcher-icon"><Workflow size={15} /></span>
            <span>
              <b>{item.workflow.name}</b>
              <small>
                {[item.metadata.folder, ...item.metadata.tags].filter(Boolean).join(" · ") ||
                  item.workflow.description ||
                  `${item.workflow.nodes.length} nodes`}
              </small>
            </span>
            {item.metadata.favorite && <Star size={13} fill="currentColor" />}
            {item.workflow.enabled && <Play size={13} />}
          </button>
        ))}
        {!results.length && <p>No matching workflows.</p>}
      </section>
      {error && <div className="quick-launcher-error" role="alert">{error}</div>}
      <footer>
        <span><kbd>Enter</kbd> open</span>
        <span><kbd>Ctrl</kbd> + <kbd>Enter</kbd> run</span>
        {busy && <span>Working…</span>}
      </footer>
    </main>
  );
}
