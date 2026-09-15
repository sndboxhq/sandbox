import {
  ArrowLeft,
  Beaker,
  CheckCircle2,
  Code2,
  GitCompare,
  Plus,
  Search,
  Sparkles,
  Trash2,
  XCircle,
} from "lucide-react";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { parse } from "acorn";
import { api } from "../api";
import type {
  CustomNodeTestReport,
  CustomNodeVerification,
  NodeCustomization,
  NodePortDefinition,
  ValueType,
  Workflow,
  WorkflowNode,
} from "../types";
import "../customNodeEditor.css";

const valueTypes: ValueType[] = [
  "any", "string", "number", "boolean", "object", "array", "path", "connection",
];
type PortKind = "inputs" | "outputs" | "branches";
const defaultCodeFontSize = 12;
const minimumCodeFontSize = 9;
const maximumCodeFontSize = 48;

export function CustomNodeEditor({ workflow, node, source, onChange, onSave, onBack, onAi }: {
  workflow: Workflow;
  node: WorkflowNode;
  source?: WorkflowNode;
  onChange: (node: WorkflowNode) => void;
  onSave: () => void;
  onBack: () => void;
  onAi: () => void;
}) {
  const custom = node.customization!;
  const [tab, setTab] = useState<"code" | "contract" | "tests" | "compare">("code");
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [report, setReport] = useState<CustomNodeTestReport>();
  const [receipt, setReceipt] = useState<CustomNodeVerification>();
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string>();
  const [codeFontSize, setCodeFontSize] = useState(defaultCodeFontSize);
  const codeGridRef = useRef<HTMLDivElement>(null);
  const problems = useMemo(() => diagnostics(custom.language, custom.sourceCode), [custom.language, custom.sourceCode]);
  const verified = Boolean(report?.passed || receipt);

  useEffect(() => {
    void api.getCustomNodeVerification(workflow.id, node.id).then(setReceipt).catch(() => setReceipt(undefined));
  }, [workflow.id, node.id]);

  useEffect(() => {
    const codeGrid = codeGridRef.current;
    if (tab !== "code" || !codeGrid) return;
    const zoomCode = (event: WheelEvent) => {
      if ((!event.ctrlKey && !event.metaKey) || event.deltaY === 0) return;
      event.preventDefault();
      setCodeFontSize((current) => Math.min(
        maximumCodeFontSize,
        Math.max(minimumCodeFontSize, current + (event.deltaY < 0 ? 1 : -1)),
      ));
    };
    codeGrid.addEventListener("wheel", zoomCode, { passive: false });
    return () => codeGrid.removeEventListener("wheel", zoomCode);
  }, [tab]);

  const patch = (value: Partial<NodeCustomization>) => {
    setReport(undefined);
    setReceipt(undefined);
    onChange({ ...node, customization: { ...custom, ...value } });
  };
  const ports = (kind: PortKind) => custom[kind];
  const updatePort = (kind: PortKind, index: number, value: NodePortDefinition) =>
    patch({ [kind]: ports(kind).map((port, item) => item === index ? value : port) });
  const addPort = (kind: PortKind) => {
    const count = ports(kind).length;
    if (count >= (kind === "branches" ? 8 : 16)) return;
    const key = `${kind === "branches" ? "branch" : kind === "inputs" ? "input" : "output"}_${count + 1}`;
    patch({ [kind]: [...ports(kind), { key, label: key.replaceAll("_", " "), type: "any", required: kind !== "branches" }] });
  };
  const updateTest = (index: number, value: Record<string, unknown>) =>
    patch({ tests: custom.tests.map((fixture, item) => item === index ? { ...fixture, ...value } : fixture) });
  const runTests = async () => {
    setTesting(true);
    setTestError(undefined);
    try {
      const nextWorkflow = {
        ...workflow,
        nodes: workflow.nodes.some((item) => item.id === node.id)
          ? workflow.nodes.map((item) => item.id === node.id ? node : item)
          : [...workflow.nodes, node],
      };
      const next = await api.testCustomNode(nextWorkflow, node.id);
      setReport(next);
      setReceipt(next.verification);
    } catch (error) {
      setTestError(String(error));
    } finally {
      setTesting(false);
    }
  };

  return <main className="fx-editor" aria-label="Custom function editor">
    <header>
      <button className="icon-button" aria-label="Back to canvas" onClick={onBack}><ArrowLeft size={16} /></button>
      <span className="fx-mark">ƒx</span>
      <div>
        <input aria-label="Custom node name" value={node.name} onChange={(event) => onChange({ ...node, name: event.target.value })} />
        <small>Based on {custom.sourceName} v{custom.sourceVersion} · local desktop only</small>
      </div>
      <span className={`fx-verification ${verified ? "passed" : ""}`}>
        {verified ? <CheckCircle2 size={13} /> : <XCircle size={13} />} {verified ? "Verified" : "Unverified"}
      </span>
      <button className="button" onClick={onAi}><Sparkles size={13} /> Ask AI</button>
      <button className="button primary" onClick={onSave}>Save draft</button>
    </header>
    <nav aria-label="Custom function sections">
      {(["code", "contract", "tests", "compare"] as const).map((value) => <button key={value} className={tab === value ? "active" : ""} onClick={() => setTab(value)}>
        {value === "code" ? <Code2 size={13} /> : value === "tests" ? <Beaker size={13} /> : <GitCompare size={13} />} {value}
      </button>)}
    </nav>

    {tab === "code" && <section className="fx-code-view">
      <div className="fx-code-toolbar">
        <select value={custom.language} onChange={(event) => patch({ language: event.target.value as "javascript" | "python", runtimeRequirement: event.target.value === "python" ? ">=3.11" : ">=20" })}>
          <option value="javascript">JavaScript</option><option value="python">Python</option>
        </select>
        <label><Search size={12} /><input value={find} onChange={(event) => setFind(event.target.value)} placeholder="Find" /></label>
        <input value={replace} onChange={(event) => setReplace(event.target.value)} placeholder="Replace" />
        <button disabled={!find} onClick={() => patch({ sourceCode: custom.sourceCode.replaceAll(find, replace) })}>Replace all</button>
        <span className="fx-code-runtime">{custom.runtimeRequirement}</span>
        <span
          className="fx-code-zoom"
          role="status"
          aria-label={`Code zoom ${Math.round((codeFontSize / defaultCodeFontSize) * 100)}%`}
          title="Ctrl + scroll to zoom code"
        >
          {Math.round((codeFontSize / defaultCodeFontSize) * 100)}%
        </span>
      </div>
      <div
        className="fx-code-grid"
        ref={codeGridRef}
        style={{ "--fx-code-font-size": `${codeFontSize}px` } as CSSProperties}
      >
        <pre aria-hidden="true">{custom.sourceCode.split("\n").map((_, index) => index + 1).join("\n")}</pre>
        <textarea spellCheck={false} aria-label="Custom function source" value={custom.sourceCode} onChange={(event) => patch({ sourceCode: event.target.value })} />
      </div>
      <aside>
        <b>Problems</b>
        {problems.length ? problems.map((problem) => <p key={problem}><XCircle size={12} />{problem}</p>) : <p className="ok"><CheckCircle2 size={12} />No static problems found.</p>}
        <b>Runtime contract</b>
        <code>ctx.inputs · ctx.items · ctx.configuration · ctx.upstream · ctx.trigger · ctx.helpers · ctx.log</code>
        <small>No filesystem, network, process, environment, package, credential, browser, or plugin access.</small>
      </aside>
    </section>}

    {tab === "contract" && <section className="fx-contract">
      <label>Description<textarea value={custom.description} onChange={(event) => patch({ description: event.target.value })} /></label>
      {(["inputs", "outputs", "branches"] as const).map((kind) => <div className="fx-port-section" key={kind}>
        <header><div><b>{kind}</b><small>{ports(kind).length}/{kind === "branches" ? 8 : 16} · unique identifiers · sndbox value types</small></div><button onClick={() => addPort(kind)}><Plus size={12} /> Add</button></header>
        {ports(kind).map((port, index) => <div className="fx-port" key={`${kind}-${index}`}>
          <input aria-label={`${kind} key`} value={port.key} onChange={(event) => updatePort(kind, index, { ...port, key: event.target.value })} />
          <input aria-label={`${kind} label`} value={port.label} onChange={(event) => updatePort(kind, index, { ...port, label: event.target.value })} />
          <select aria-label={`${kind} type`} value={port.type} onChange={(event) => updatePort(kind, index, { ...port, type: event.target.value as ValueType })}>{valueTypes.map((type) => <option key={type}>{type}</option>)}</select>
          {kind !== "branches" && <label><input type="checkbox" checked={port.required ?? false} onChange={(event) => updatePort(kind, index, { ...port, required: event.target.checked })} /> Required</label>}
          <button aria-label={`Remove ${port.key}`} onClick={() => patch({ [kind]: ports(kind).filter((_, item) => item !== index) })}><Trash2 size={13} /></button>
        </div>)}
      </div>)}
    </section>}

    {tab === "tests" && <section className="fx-tests">
      <header>
        <div><h2>Saved fixtures</h2><p>Every required output and declared branch must be covered. Any code, contract, runtime, or test change invalidates verification.</p></div>
        <button className="button" onClick={() => patch({ tests: [...custom.tests, { id: crypto.randomUUID(), name: `Fixture ${custom.tests.length + 1}`, inputs: {}, items: [], expectedOutputs: {}, expectedBranches: {} }] })}><Plus size={13} /> Add fixture</button>
        <button className="button primary" disabled={testing || !custom.tests.length || problems.length > 0} onClick={() => void runTests()}>{testing ? "Testing…" : "Run all & verify"}</button>
      </header>
      {testError && <div className="error-banner">{testError}</div>}
      {report && <div className={report.passed ? "info-note" : "error-banner"}>Outputs covered: {report.outputCoverage.join(", ") || "none"} · branches covered: {report.branchCoverage.join(", ") || "none"}</div>}
      {custom.tests.map((fixture, index) => {
        const result = report?.fixtures.find((item) => item.id === fixture.id);
        return <article key={fixture.id}>
          <header><input value={fixture.name} onChange={(event) => updateTest(index, { name: event.target.value })} /><span>{result?.durationMs ?? 0} ms</span><button aria-label={`Remove ${fixture.name}`} onClick={() => patch({ tests: custom.tests.filter((item) => item.id !== fixture.id) })}><Trash2 size={13} /></button></header>
          <div>
            {(["inputs", "items", "expectedOutputs", "expectedBranches"] as const).map((field) => <label key={field}>{field}<JsonField value={fixture[field]} onChange={(value) => updateTest(index, { [field]: value })} /></label>)}
            <label>expectedError<input value={fixture.expectedError ?? ""} placeholder="Optional error substring" onChange={(event) => updateTest(index, { expectedError: event.target.value || undefined })} /></label>
          </div>
          {result && <pre className={result.passed ? "passed" : "failed"}>{result.logs.join("\n") || result.error || "Passed"}</pre>}
        </article>;
      })}
    </section>}

    {tab === "compare" && <section className="fx-compare">
      <div><h2>Source contract</h2><pre>{JSON.stringify(source ? { type: source.type, version: source.version, name: source.name, configuration: source.configuration } : { type: custom.sourceType, version: custom.sourceVersion }, null, 2)}</pre></div>
      <div><h2>Custom contract</h2><p>{custom.inputs.length} inputs · {custom.outputs.length} outputs · {custom.branches.length} branches</p><pre>{JSON.stringify({ name: node.name, description: custom.description, inputs: custom.inputs, outputs: custom.outputs, branches: custom.branches }, null, 2)}</pre></div>
    </section>}
  </main>;
}

function JsonField({ value, onChange }: { value: unknown; onChange: (value: unknown) => void }) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState(false);
  return <textarea className={error ? "invalid" : ""} value={text} onChange={(event) => {
    setText(event.target.value);
    try { onChange(JSON.parse(event.target.value)); setError(false); } catch { setError(true); }
  }} />;
}

function diagnostics(language: string, source: string) {
  if (!source.trim()) return ["Source is required."];
  if (language === "python") return /\b(import\s+(os|sys|subprocess|socket)|open\s*\(|eval\s*\(|exec\s*\()/m.test(source) ? ["Ambient host APIs are denied by the Python sandbox."] : [];
  try {
    parse(`async function __custom(ctx){${source}\n}`, { ecmaVersion: "latest" });
    return [];
  } catch (error) {
    return [String(error)];
  }
}
