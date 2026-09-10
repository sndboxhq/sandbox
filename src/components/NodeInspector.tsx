import { open } from "@tauri-apps/plugin-dialog";
import { Bot, Braces, Code2, ExternalLink, FolderOpen, LocateFixed, Pencil, RefreshCcw, Trash2 } from "lucide-react";
import {
  Children,
  cloneElement,
  isValidElement,
  lazy,
  Suspense,
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { api } from "../api";
import { definitionFor, type NodeDefinition } from "../catalogue";
import { expressionContext, previewExpression } from "../expressions";
import type { CodeLanguage } from "./CodeEditorDialog";
import { CustomSelect } from "./ui/CustomSelect";
import { IssueNotice } from "./ui/IssueNotice";
import type {
  BrowserProfile,
  ConnectionMetadata,
  ExecutionRecord,
  InputBinding,
  StructuredLocator,
  ValidationIssue,
  Workflow,
  WorkflowNode,
} from "../types";

const locatorKinds = [
  "role",
  "label",
  "placeholder",
  "test_id",
  "text",
  "attribute",
  "css",
  "xpath",
] as const;

const CodeEditorDialog = lazy(() =>
  import("./CodeEditorDialog").then((module) => ({ default: module.CodeEditorDialog })),
);
const RawJsonEditorDialog = lazy(() =>
  import("./RawJsonEditorDialog").then((module) => ({ default: module.RawJsonEditorDialog })),
);
const CollectionNodeInspector = lazy(() =>
  import("./CollectionNodeInspector").then((module) => ({ default: module.CollectionNodeInspector })),
);
const isCodeNode = (type: string) => type === "code" || type === "javascript_code" || type === "python_code";
const ruleOperators = [
  "equals", "not_equals", "exists", "not_exists", "is_null", "is_not_null",
  "is_empty", "is_not_empty", "contains", "not_contains", "starts_with", "ends_with",
  "greater_than", "greater_than_or_equal", "less_than", "less_than_or_equal",
  "matches_regex", "is_one_of", "is_not_one_of", "array_contains",
  "date_before", "date_after", "date_between",
] as const;

export function NodeInspector({
  workflow,
  node,
  issues = [],
  onChange,
  onDelete,
  sampleRun,
  testDataExecutions = [],
  testDataExecutionId = "",
  onTestDataExecutionChange,
}: {
  workflow: Workflow;
  node: WorkflowNode;
  issues?: ValidationIssue[];
  onChange: (node: WorkflowNode, workflowPatch?: Partial<Workflow>) => void;
  onDelete: () => void;
  sampleRun?: ExecutionRecord;
  testDataExecutions?: ExecutionRecord[];
  testDataExecutionId?: string;
  onTestDataExecutionChange?: (id:string)=>void;
}) {
  const definition = definitionFor(node.type);
  const Icon = definition.icon;
  const config = node.configuration;
  const [profiles, setProfiles] = useState<BrowserProfile[]>([]);
  const [connections, setConnections] = useState<ConnectionMetadata[]>([]);
  const [locatorTest, setLocatorTest] = useState<string>();
  const [codeEditorOpen, setCodeEditorOpen] = useState(false);
  const [rawJsonEditorOpen, setRawJsonEditorOpen] = useState(false);
  const set = (key: string, value: unknown) =>
    onChange({ ...node, configuration: { ...config, [key]: value } });
  useEffect(() => {
    if (definition.group === "Browser")
      void api.listBrowserProfiles().then(setProfiles);
  }, [definition.group]);
  useEffect(() => {
    if (
      definition.group === "Communication" ||
      node.type === "gmail_new_email_trigger" ||
      node.type === "ai_prompt" ||
      Boolean(node.plugin)
    )
      void api.listConnections().then(setConnections);
  }, [definition.group, node.type, node.plugin]);
  useEffect(() => {
    const controls = document.querySelectorAll<HTMLElement>(
      ".inspector [data-validation-managed]",
    );
    controls.forEach((control) => {
      control.removeAttribute("aria-invalid");
      control.removeAttribute("aria-describedby");
      control.removeAttribute("data-validation-managed");
    });
    issues.forEach((issue, index) => {
      const field = issue.fieldPath?.split(".").at(-1);
      if (!field) return;
      const control = findIssueControl(field);
      if (!control) return;
      control.setAttribute(
        "aria-invalid",
        issue.severity === "error" ? "true" : "false",
      );
      control.setAttribute(
        "aria-describedby",
        `validation-${node.id}-${index}`,
      );
      control.setAttribute("data-validation-managed", "true");
    });
  }, [issues, node.id]);

  const approvePath = (value: string) => {
    const folder = value.replace(/[\\/][^\\/]+$/, "");
    const approved = [
      ...new Set([
        ...workflow.settings.permissions.approvedFolders,
        folder || value,
      ]),
    ];
    return {
      settings: {
        ...workflow.settings,
        permissions: {
          ...workflow.settings.permissions,
          approvedFolders: approved,
        },
      },
    };
  };
  const chooseFolder = async (key: string) => {
    if (!api.isDesktop) return;
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Approve a folder for this workflow",
    });
    if (typeof selected === "string")
      onChange(
        { ...node, configuration: { ...config, [key]: selected } },
        approvePath(selected),
      );
  };
  const chooseFile = async (key: string) => {
    if (!api.isDesktop) return;
    const selected = await open({
      directory: false,
      multiple: false,
      title: "Choose and approve a file",
    });
    if (typeof selected === "string")
      onChange(
        { ...node, configuration: { ...config, [key]: selected } },
        approvePath(selected),
      );
  };
  const chooseFileGrant = async (key: string, maximumBytes?: number) => {
    if (!api.isDesktop) return;
    const selected = await open({
      directory: false,
      multiple: false,
      title: "Grant this file to one workflow execution",
    });
    if (typeof selected !== "string") return;
    const grant = await api.createFileGrant(selected, maximumBytes);
    onChange({ ...node, configuration: { ...config, [key]: grant.grantId } });
  };
  const testLocator = async (locator: StructuredLocator) => {
    if (!api.isDesktop)
      return "Locator testing requires the desktop application.";
    const profileId = String(
      workflow.nodes.find((candidate) => candidate.type === "open_browser")
        ?.configuration.profileId ?? "",
    );
    if (!profileId)
      return "Choose a managed profile in the upstream Open Browser node first.";
    const url =
      locator.recordingUrl ||
      String(
        workflow.nodes.find((candidate) => candidate.type === "navigate")
          ?.configuration.url ?? "",
      );
    if (!url || url.includes("{{"))
      return "Record this target or configure a static Navigate URL before testing it.";
    setLocatorTest("Opening a headed browser…");
    let sessionId: string | undefined;
    try {
      const opened = await api.startBrowserRecording(profileId, url);
      sessionId = opened.browserSession.sessionId;
      const result = await api.testBrowserLocator(sessionId, locator);
      const count = Number(result.matchCount ?? 0);
      const message =
        count === 1
          ? `Locator matched exactly one element at ${String(result.currentUrl ?? url)}.`
          : `Locator matched ${count} elements and is not unique.`;
      setLocatorTest(message);
      return message;
    } catch (error) {
      const message = String(error);
      setLocatorTest(message);
      return message;
    } finally {
      if (sessionId)
        await api.stopBrowserRecording(sessionId).catch(() => undefined);
    }
  };
  const mapping = (
    key: string,
    label: string,
    options?: { multiline?: boolean; sensitive?: boolean },
  ) => (
    <MappedInput
      fieldName={key}
      label={label}
      value={String(config[key] ?? "")}
      workflow={workflow}
      currentNodeId={node.id}
      sampleRun={sampleRun}
      multiline={options?.multiline}
      sensitive={options?.sensitive}
      onChange={(value) => set(key, value)}
    />
  );

  return (
    <aside className="inspector">
      <div className="inspector-title">
        <span className="node-icon">
          <Icon size={15} />
        </span>
        <div className="inspector-node-heading">
          <b>{node.name}</b>
          <small>{definition.group}</small>
        </div>
        <button className="inspector-json-button" type="button" onClick={() => setRawJsonEditorOpen(true)} aria-label="Edit node configuration as raw JSON">
          <Braces size={14} /><span>Raw JSON</span>
        </button>
      </div>
      <div className="inspector-scroll">
        <div className="inspector-section-bar">
          <span>Configuration</span>
          <small>{node.disabled ? "Disabled" : "Edits save automatically"}</small>
        </div>
        {issues.length > 0 && (
          <section
            className="inspector-issues"
            aria-label="Node validation issues"
          >
            {issues.map((issue, index) => (
              <div
                key={`${issue.code}:${issue.fieldPath}`}
                id={`validation-${node.id}-${index}`}
              >
                <IssueNotice
                  issue={issue}
                  compact
                  context={{ workflowId: workflow.id, nodeId: node.id, fieldPath: issue.fieldPath }}
                  onFix={issue.fieldPath ? () => {
                    const field = issue.fieldPath?.split(".").at(-1);
                    if (field) findIssueControl(field)?.focus();
                  } : undefined}
                  fixLabel="Fix field"
                />
              </div>
            ))}
          </section>
        )}
        <Field label="Name">
          <input
            value={node.name}
            onChange={(event) =>
              onChange({ ...node, name: event.target.value })
            }
          />
        </Field>

        {definition.inputs.length > 0 && (
          <DataBindings
            definition={definition}
            workflow={workflow}
            node={node}
            onChange={onChange}
            sampleRun={sampleRun}
          />
        )}

        {node.type === "schedule_trigger" && (
          <>
            <Field label="Schedule">
              <CustomSelect
                value={String(config.scheduleType ?? "minutes")}
                onChange={(event) => set("scheduleType", event.target.value)}
              >
                <option value="minutes">Every X minutes</option>
                <option value="hourly">Hourly</option>
                <option value="daily">Daily</option>
                <option value="cron">Advanced cron</option>
              </CustomSelect>
            </Field>
            {config.scheduleType === "minutes" && (
              <Field label="Every">
                <div className="input-unit">
                  <input
                    aria-label="Schedule interval in minutes"
                    type="number"
                    min="1"
                    value={Number(config.every ?? 15)}
                    onChange={(event) =>
                      set("every", Number(event.target.value))
                    }
                  />
                  <span>minutes</span>
                </div>
              </Field>
            )}
            {config.scheduleType === "daily" && (
              <Field label="Time">
                <input
                  type="time"
                  value={String(config.time ?? "09:00")}
                  onChange={(event) => set("time", event.target.value)}
                />
              </Field>
            )}
            {config.scheduleType === "cron" && (
              <Field label="Cron expression" hint="Five or six fields">
                <input
                  value={String(config.cron ?? "")}
                  onChange={(event) => set("cron", event.target.value)}
                />
              </Field>
            )}
            <Info>
              Next runs are calculated by the local runner. Quitting sndbox
              stops schedules.
            </Info>
          </>
        )}

        {node.type === "file_watch_trigger" && (
          <>
            <Field label="Folder">
              <FolderInput
                fieldName="folder"
                value={String(config.folder ?? "")}
                onChoose={() => chooseFolder("folder")}
              />
            </Field>
            <Field label="Filename pattern" hint="Optional glob, e.g. *.pdf">
              <input
                value={String(config.pattern ?? "")}
                onChange={(event) => set("pattern", event.target.value)}
              />
            </Field>
            <Field label="Events">
              <div className="checks">
                {["created", "modified", "deleted"].map((kind) => (
                  <label key={kind}>
                    <input
                      type="checkbox"
                      checked={((config.events as string[]) ?? []).includes(
                        kind,
                      )}
                      onChange={(event) =>
                        set(
                          "events",
                          event.target.checked
                            ? [
                                ...new Set([
                                  ...((config.events as string[]) ?? []),
                                  kind,
                                ]),
                              ]
                            : ((config.events as string[]) ?? []).filter(
                                (value) => value !== kind,
                              ),
                        )
                      }
                    />
                    {kind}
                  </label>
                ))}
              </div>
            </Field>
          </>
        )}
        {node.type === "gmail_new_email_trigger" && (
          <>
            <ConnectionSelect
              provider="gmail"
              value={String(config.credentialId ?? "")}
              connections={connections}
              onChange={(value) => set("credentialId", value)}
            />
            <Field label="Poll interval">
              <div className="input-unit">
                <input
                  aria-label="Poll interval in minutes"
                  type="number"
                  min="1"
                  max="60"
                  value={Number(config.pollIntervalMinutes ?? 5)}
                  onChange={(event) =>
                    set("pollIntervalMinutes", Number(event.target.value))
                  }
                />
                <span>minutes</span>
              </div>
            </Field>
            <Field label="Sender filter" hint="Optional">
              <input
                value={String(config.sender ?? "")}
                onChange={(event) => set("sender", event.target.value)}
              />
            </Field>
            <Field label="Recipient filter" hint="Optional">
              <input
                value={String(config.recipient ?? "")}
                onChange={(event) => set("recipient", event.target.value)}
              />
            </Field>
            <Field label="Subject contains" hint="Optional">
              <input
                value={String(config.subjectContains ?? "")}
                onChange={(event) => set("subjectContains", event.target.value)}
              />
            </Field>
            <Field label="Gmail label" hint="Optional">
              <input
                value={String(config.label ?? "")}
                onChange={(event) => set("label", event.target.value)}
              />
            </Field>
            <label className="toggle-row">
              <span>
                <b>Has attachment</b>
              </span>
              <input
                type="checkbox"
                checked={Boolean(config.hasAttachment)}
                onChange={(event) => set("hasAttachment", event.target.checked)}
              />
            </label>
            <label className="toggle-row">
              <span>
                <b>Include HTML body</b>
                <small>Plain text is included by default.</small>
              </span>
              <input
                type="checkbox"
                checked={Boolean(config.includeHtmlBody)}
                onChange={(event) =>
                  set("includeHtmlBody", event.target.checked)
                }
              />
            </label>
            <Info>
              Message IDs are persisted per workflow so the same email cannot
              trigger it repeatedly.
            </Info>
          </>
        )}

        {node.type === "condition" && (
          <>
            {mapping("left", "Value")}
            <Field label="Operator">
              <CustomSelect
                value={String(config.operator ?? "equals")}
                onChange={(event) => set("operator", event.target.value)}
              >
                {ruleOperators.map((value) => (
                  <option key={value} value={value}>
                    {value.replaceAll("_", " ")}
                  </option>
                ))}
              </CustomSelect>
            </Field>
            {![
              "exists",
              "not_exists",
              "is_null",
              "is_not_null",
              "is_empty",
              "is_not_empty",
            ].includes(String(config.operator)) && (
              <Field label="Compare with">
                <input
                  value={scalar(config.right)}
                  onChange={(event) =>
                    set("right", parseScalar(event.target.value))
                  }
                />
              </Field>
            )}
          </>
        )}
        {["filter","switch","split_out","loop_over_items","aggregate","remove_duplicates","merge"].includes(node.type) && (
          <>
          <Suspense fallback={<div className="info-note">Loading collection controls…</div>}>
            <CollectionNodeInspector workflow={workflow} node={node} onChange={onChange}/>
          </Suspense>
          <Field label="Manual test data source" hint="Pinned data is used when no execution is selected">
            <CustomSelect value={testDataExecutionId} onChange={event=>onTestDataExecutionChange?.(event.target.value)}>
              <option value="">Pinned input / empty collection</option>
              {testDataExecutions.map(execution=><option key={execution.id} value={execution.id}>{new Date(execution.startedAt).toLocaleString()} Â· {execution.status} Â· {execution.id.slice(0,8)}</option>)}
            </CustomSelect>
          </Field>
          <JsonField label={node.type==="merge"?"Pinned named inputs":"Pinned sample collection"} value={config.pinnedData??(node.type==="merge"?{}:[])} onChange={value=>set("pinnedData",value)}/>
          <Info>{node.type==="merge"?"Use an object keyed by stable Merge input IDs. Each value is that input's independent sample collection.":node.type==="loop_over_items"?"A manual loop test can execute its body and its real-world side effects. Keep the pinned collection bounded.":"Pinned collections are development evidence only and never replace published, scheduled, or deployed inputs."}</Info>
          </>
        )}
        {node.type === "set_data" && (
          <JsonField
            label="Object"
            value={config.values ?? {}}
            onChange={(value) => set("values", value)}
          />
        )}
        {node.type === "delay" && (
          <>
            <Field label="Duration">
              <input
                type="number"
                min="0"
                step="0.1"
                value={Number(config.amount ?? 1)}
                onChange={(event) => set("amount", Number(event.target.value))}
              />
            </Field>
            <Field label="Unit">
              <CustomSelect
                value={String(config.unit ?? "seconds")}
                onChange={(event) => set("unit", event.target.value)}
              >
                <option value="seconds">Seconds</option>
                <option value="minutes">Minutes</option>
              </CustomSelect>
            </Field>
          </>
        )}

        {node.type === "http_request" && (
          <>
            <Field label="Method">
              <CustomSelect
                value={String(config.method ?? "GET")}
                onChange={(event) => set("method", event.target.value)}
              >
                {["GET", "POST", "PUT", "PATCH", "DELETE"].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </CustomSelect>
            </Field>
            {mapping("url", "URL")}
            <JsonField
              label="Headers"
              value={config.headers ?? {}}
              onChange={(value) => set("headers", value)}
            />
            <JsonField
              label="Query parameters"
              value={config.query ?? {}}
              onChange={(value) => set("query", value)}
            />
            {!["GET", "DELETE"].includes(String(config.method)) && (
              <JsonField
                label="JSON body"
                value={config.body ?? {}}
                onChange={(value) => set("body", value)}
              />
            )}
            <TimeoutAndRetry config={config} set={set} />
            <Info>
              Authorization and cookie values are redacted from execution data.
            </Info>
          </>
        )}

        {node.type === "open_browser" && (
          <>
            <Field label="Browser profile">
              <CustomSelect
                value={String(config.profileId ?? "")}
                onChange={(event) => set("profileId", event.target.value)}
              >
                <option value="">Select managed profile…</option>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </CustomSelect>
            </Field>
            {profiles.length === 0 && (
              <Info>
                Create an isolated profile in Settings before running this node.
              </Info>
            )}
            {mapping("initialUrl", "Initial URL")}
            <div className="field-grid">
              <Field label="Viewport width">
                <input
                  aria-label="Approval expiry in minutes"
                  type="number"
                  min="320"
                  max="3840"
                  value={Number(
                    (config.viewport as { width?: number })?.width ?? 1280,
                  )}
                  onChange={(event) =>
                    set("viewport", {
                      ...(config.viewport as object),
                      width: Number(event.target.value),
                    })
                  }
                />
              </Field>
              <Field label="Viewport height">
                <input
                  type="number"
                  min="240"
                  max="2160"
                  value={Number(
                    (config.viewport as { height?: number })?.height ?? 800,
                  )}
                  onChange={(event) =>
                    set("viewport", {
                      ...(config.viewport as object),
                      height: Number(event.target.value),
                    })
                  }
                />
              </Field>
            </div>
            <Field label="Default timeout (ms)">
              <input
                type="number"
                min="100"
                max="120000"
                value={Number(config.defaultTimeoutMs ?? 30000)}
                onChange={(event) =>
                  set("defaultTimeoutMs", Number(event.target.value))
                }
              />
            </Field>
            <label className="toggle-row">
              <span>
                <b>Headed during manual runs</b>
                <small>Scheduled runs default to headless.</small>
              </span>
              <input
                type="checkbox"
                checked={config.headed !== false}
                onChange={(event) => set("headed", event.target.checked)}
              />
            </label>
            <label className="toggle-row">
              <span>
                <b>Close automatically</b>
                <small>Sessions are cleaned up after success or failure.</small>
              </span>
              <input
                type="checkbox"
                checked={config.closeAutomatically !== false}
                onChange={(event) =>
                  set("closeAutomatically", event.target.checked)
                }
              />
            </label>
          </>
        )}

        {node.type === "navigate" && (
          <>
            {mapping("url", "URL")}
            <Field label="Wait condition">
              <CustomSelect
                value={String(config.waitCondition ?? "dom_ready")}
                onChange={(event) => set("waitCondition", event.target.value)}
              >
                <option value="dom_ready">DOM ready</option>
                <option value="page_loaded">Page loaded</option>
                <option value="network_idle">Network idle</option>
                <option value="element_visible">
                  Specific element visible
                </option>
              </CustomSelect>
            </Field>
            {config.waitCondition === "element_visible" && (
              <LocatorEditor
                value={config.locator}
                onChange={(value) => set("locator", value)}
                onTest={testLocator}
              />
            )}
            <TimeoutField config={config} set={set} />
          </>
        )}

        {node.type === "click_element" && (
          <>
            <LocatorEditor
              value={config.locator}
              onChange={(value) => set("locator", value)}
              onTest={testLocator}
            />
            <div className="field-grid">
              <Field label="Click type">
                <CustomSelect
                  value={String(config.clickType ?? "normal")}
                  onChange={(event) => set("clickType", event.target.value)}
                >
                  <option value="normal">Normal</option>
                  <option value="double">Double</option>
                  <option value="right">Right</option>
                </CustomSelect>
              </Field>
              <Field label="Mouse button">
                <CustomSelect
                  value={String(config.mouseButton ?? "left")}
                  onChange={(event) => set("mouseButton", event.target.value)}
                >
                  <option>left</option>
                  <option>middle</option>
                  <option>right</option>
                </CustomSelect>
              </Field>
            </div>
            <Field label="Wait after click (ms)">
              <input
                type="number"
                min="0"
                max="120000"
                value={Number(config.waitAfterMs ?? 0)}
                onChange={(event) =>
                  set("waitAfterMs", Number(event.target.value))
                }
              />
            </Field>
            <TimeoutField config={config} set={set} />
          </>
        )}

        {node.type === "fill_field" && (
          <>
            <LocatorEditor
              value={config.locator}
              onChange={(value) => set("locator", value)}
              onTest={testLocator}
            />
            {mapping(
              "value",
              config.sensitive ? "Protected value reference" : "Value",
              { sensitive: Boolean(config.sensitive) },
            )}
            <Field label="Input delay (ms)">
              <input
                type="number"
                min="0"
                max="2000"
                value={Number(config.inputDelayMs ?? 0)}
                onChange={(event) =>
                  set("inputDelayMs", Number(event.target.value))
                }
              />
            </Field>
            <label className="toggle-row">
              <span>
                <b>Clear existing value</b>
              </span>
              <input
                type="checkbox"
                checked={config.clearExisting !== false}
                onChange={(event) => set("clearExisting", event.target.checked)}
              />
            </label>
            <label className="toggle-row">
              <span>
                <b>Sensitive value</b>
                <small>Redacts logs and masks failure screenshots.</small>
              </span>
              <input
                type="checkbox"
                checked={Boolean(config.sensitive)}
                onChange={(event) => set("sensitive", event.target.checked)}
              />
            </label>
            <TimeoutField config={config} set={set} />
          </>
        )}

        {node.type === "select_option" && (
          <>
            <LocatorEditor
              value={config.locator}
              onChange={(value) => set("locator", value)}
              onTest={testLocator}
            />
            <Field label="Select by">
              <CustomSelect
                value={String(config.selectBy ?? "value")}
                onChange={(event) => set("selectBy", event.target.value)}
              >
                <option value="value">Value</option>
                <option value="label">Visible label</option>
                <option value="index">Index</option>
              </CustomSelect>
            </Field>
            {mapping("option", "Option")}
            <TimeoutField config={config} set={set} />
          </>
        )}
        {node.type === "press_key" && (
          <>
            <Field
              label="Key combination"
              hint="Examples: Enter, Control+K, Shift+Tab"
            >
              <input
                value={String(config.key ?? "Enter")}
                onChange={(event) => set("key", event.target.value)}
              />
            </Field>
            <TimeoutField config={config} set={set} />
          </>
        )}

        {node.type === "wait_for" && (
          <>
            <Field label="Wait for">
              <CustomSelect
                value={String(config.waitFor ?? "element_visible")}
                onChange={(event) => set("waitFor", event.target.value)}
              >
                <option value="time">Time delay</option>
                <option value="element_visible">Element visible</option>
                <option value="element_hidden">Element hidden</option>
                <option value="text_present">Text present</option>
                <option value="url_matches">URL matches</option>
                <option value="download_begins">Download begins</option>
                <option value="network_response">Network response</option>
                <option value="page_load_state">Page load state</option>
              </CustomSelect>
            </Field>
            {config.waitFor === "time" && (
              <Field label="Delay (ms)">
                <input
                  type="number"
                  min="0"
                  value={Number(config.delayMs ?? 1000)}
                  onChange={(event) =>
                    set("delayMs", Number(event.target.value))
                  }
                />
              </Field>
            )}
            {["element_visible", "element_hidden"].includes(
              String(config.waitFor),
            ) && (
              <LocatorEditor
                value={config.locator}
                onChange={(value) => set("locator", value)}
                onTest={testLocator}
              />
            )}
            {config.waitFor === "text_present" && mapping("text", "Text")}
            {["url_matches", "network_response"].includes(
              String(config.waitFor),
            ) && mapping("urlPattern", "URL pattern")}
            {config.waitFor === "page_load_state" && (
              <Field label="Load state">
                <CustomSelect
                  value={String(config.loadState ?? "dom_ready")}
                  onChange={(event) => set("loadState", event.target.value)}
                >
                  <option value="dom_ready">DOM ready</option>
                  <option value="page_loaded">Page loaded</option>
                  <option value="network_idle">Network idle</option>
                </CustomSelect>
              </Field>
            )}
            <TimeoutField config={config} set={set} />
          </>
        )}

        {node.type === "extract_data" && (
          <>
            <LocatorEditor
              value={config.locator}
              onChange={(value) => set("locator", value)}
              onTest={testLocator}
            />
            <Field label="Extract">
              <CustomSelect
                value={String(config.extract ?? "text")}
                onChange={(event) => set("extract", event.target.value)}
              >
                <option value="text">Text</option>
                <option value="attribute">Attribute</option>
                <option value="link">Link</option>
                <option value="image_source">Image source</option>
                <option value="table">Table</option>
              </CustomSelect>
            </Field>
            {config.extract === "attribute" && (
              <Field label="Attribute name">
                <input
                  value={String(config.attribute ?? "")}
                  onChange={(event) => set("attribute", event.target.value)}
                />
              </Field>
            )}
            <Field label="Output field name">
              <input
                value={String(config.fieldName ?? "value")}
                onChange={(event) => set("fieldName", event.target.value)}
              />
            </Field>
            <label className="toggle-row">
              <span>
                <b>Extract repeated list</b>
                <small>Returns all unique matches as structured JSON.</small>
              </span>
              <input
                type="checkbox"
                checked={Boolean(config.repeated)}
                onChange={(event) => set("repeated", event.target.checked)}
              />
            </label>
            {config.extract === "table" && (
              <JsonField
                label="Column names"
                value={config.fields ?? {}}
                onChange={(value) => set("fields", value)}
              />
            )}
            <TimeoutField config={config} set={set} />
          </>
        )}

        {node.type === "screenshot" && (
          <>
            <Field label="Capture">
              <CustomSelect
                value={String(config.mode ?? "viewport")}
                onChange={(event) => set("mode", event.target.value)}
              >
                <option value="viewport">Current viewport</option>
                <option value="full_page">Full page</option>
                <option value="element">Selected element</option>
              </CustomSelect>
            </Field>
            {config.mode === "element" && (
              <LocatorEditor
                value={config.locator}
                onChange={(value) => set("locator", value)}
                onTest={testLocator}
              />
            )}
            <label className="toggle-row">
              <span>
                <b>Include in execution history</b>
                <small>Stored according to screenshot retention.</small>
              </span>
              <input
                type="checkbox"
                checked={config.includeInHistory !== false}
                onChange={(event) =>
                  set("includeInHistory", event.target.checked)
                }
              />
            </label>
            <TimeoutField config={config} set={set} />
          </>
        )}
        {node.type === "download_file" && (
          <>
            <LocatorEditor
              value={config.locator}
              onChange={(value) => set("locator", value)}
              onTest={testLocator}
            />
            <Field label="Destination folder">
              <FolderInput
                fieldName="destinationFolder"
                value={String(config.destinationFolder ?? "")}
                onChoose={() => chooseFolder("destinationFolder")}
              />
            </Field>
            {mapping("filename", "Filename")}
            <Field label="Collision behaviour">
              <CustomSelect
                value={String(config.collisionBehaviour ?? "rename")}
                onChange={(event) =>
                  set("collisionBehaviour", event.target.value)
                }
              >
                <option value="rename">Create unique name</option>
                <option value="overwrite">Overwrite</option>
                <option value="fail">Fail</option>
              </CustomSelect>
            </Field>
            <Field label="Maximum size (MB)">
              <input
                type="number"
                min="1"
                max="2048"
                value={Math.round(
                  Number(config.maximumBytes ?? 104857600) / 1048576,
                )}
                onChange={(event) =>
                  set("maximumBytes", Number(event.target.value) * 1048576)
                }
              />
            </Field>
            <TimeoutField config={config} set={set} />
          </>
        )}
        {node.type === "upload_file" && (
          <>
            <LocatorEditor
              value={config.locator}
              onChange={(value) => set("locator", value)}
              onTest={testLocator}
            />
            <Field label="Approved file">
              <div className="folder-input">
                <input
                  value={String(config.file ?? "")}
                  readOnly
                  placeholder="Choose a local file"
                />
                <button
                  type="button"
                  onClick={() => chooseFile("file")}
                  disabled={!api.isDesktop}
                >
                  <FolderOpen size={15} />
                </button>
              </div>
            </Field>
            <Info>
              A file path from a previous trusted node may also be mapped here
              after the file is approved.
            </Info>
            <TimeoutField config={config} set={set} />
          </>
        )}
        {node.type === "close_browser" && (
          <Info>
            Closes the inherited browser session deliberately. Remaining
            sessions are always cleaned up when the workflow ends.
          </Info>
        )}

        {node.type === "gmail_get_email" && (
          <>
            <ConnectionSelect
              provider="gmail"
              value={String(config.credentialId ?? "")}
              connections={connections}
              onChange={(value) => set("credentialId", value)}
            />
            {mapping("messageId", "Message or thread ID")}
          </>
        )}
        {(node.type === "gmail_create_draft" ||
          node.type === "gmail_send_email") && (
          <>
            {node.type === "gmail_send_email" && (
              <IssueNotice
                issue={{ code: "external_communication_review", severity: "warning", message: "External communication", suggestion: "Automatic sending requires approval for this connection and recipient logic. Any change revokes approval." }}
                context={{ workflowId: workflow.id, nodeId: node.id }}
              />
            )}
            <ConnectionSelect
              provider="gmail"
              value={String(config.credentialId ?? "")}
              connections={connections}
              onChange={(value) => set("credentialId", value)}
            />
            {mapping("to", "To")}
            {mapping("cc", "CC")}
            {mapping("bcc", "BCC")}
            {mapping("subject", "Subject")}
            {mapping("body", "Plain text body", { multiline: true })}
            <details>
              <summary>Advanced</summary>
              {mapping("htmlBody", "HTML body", { multiline: true })}
              {mapping("replyToMessage", "Reply-to message ID")}
            </details>
            {node.type === "gmail_create_draft" && (
              <Info>
                Drafts are the recommended default. Nothing is sent until a user
                reviews it in Gmail.
              </Info>
            )}
          </>
        )}
        {node.type === "gmail_add_label" && (
          <>
            <ConnectionSelect
              provider="gmail"
              value={String(config.credentialId ?? "")}
              connections={connections}
              onChange={(value) => set("credentialId", value)}
            />
            {mapping("messageId", "Message ID")}
            <Field label="Add label IDs" hint="One per line">
              <textarea
                rows={3}
                value={((config.addLabelIds as string[]) ?? []).join("\n")}
                onChange={(event) =>
                  set(
                    "addLabelIds",
                    event.target.value.split("\n").filter(Boolean),
                  )
                }
              />
            </Field>
            <Field label="Remove label IDs" hint="One per line">
              <textarea
                rows={3}
                value={((config.removeLabelIds as string[]) ?? []).join("\n")}
                onChange={(event) =>
                  set(
                    "removeLabelIds",
                    event.target.value.split("\n").filter(Boolean),
                  )
                }
              />
            </Field>
          </>
        )}
        {(node.type === "discord_webhook" || node.type === "slack_webhook") && (
          <>
            <ConnectionSelect
              provider={node.type === "discord_webhook" ? "discord" : "slack"}
              value={String(config.credentialId ?? "")}
              connections={connections}
              onChange={(value) => set("credentialId", value)}
            />
            {mapping("content", "Message", { multiline: true })}
            {node.type === "discord_webhook" && (
              <details>
                <summary>Advanced</summary>
                {mapping("username", "Username override")}
                {mapping("avatarUrl", "Avatar URL")}
              </details>
            )}
            <Info>
              The webhook URL is resolved inside Rust and never enters workflow
              data or logs.
            </Info>
          </>
        )}
        {node.type === "discord_embed" && (
          <>
            <ConnectionSelect
              provider="discord"
              value={String(config.credentialId ?? "")}
              connections={connections}
              onChange={(value) => set("credentialId", value)}
            />
            {mapping("content", "Message")}
            {mapping("title", "Embed title")}
            {mapping("description", "Description", { multiline: true })}
            <JsonField
              label="Fields"
              value={config.fields ?? []}
              onChange={(value) => set("fields", value)}
            />
            {mapping("link", "Link")}
            {mapping("image", "Image URL")}
          </>
        )}
        {node.type === "approval" && (
          <>
            <div className="info-note">
              Execution pauses locally and appears in Pending Approvals and the
              system tray.
            </div>
            {mapping("proposedAction", "Proposed action")}
            {mapping("recipient", "Recipient")}
            {mapping("subject", "Subject")}
            {mapping("messagePreview", "Message preview", { multiline: true })}
            <Field label="Expires after">
              <div className="input-unit">
                <input
                  type="number"
                  min="1"
                  max="10080"
                  value={Number(config.expiresInMinutes ?? 60)}
                  onChange={(event) =>
                    set("expiresInMinutes", Number(event.target.value))
                  }
                />
                <span>minutes</span>
              </div>
            </Field>
          </>
        )}

        {node.type === "desktop_notification" && (
          <>
            {mapping("title", "Title")}
            {mapping("message", "Message", { multiline: true })}
          </>
        )}
        {node.type === "move_file" && (
          <>
            {mapping("source", "Source path")}
            <Field label="Destination folder">
              <FolderInput
                fieldName="destinationFolder"
                value={String(config.destinationFolder ?? "")}
                onChoose={() => chooseFolder("destinationFolder")}
              />
            </Field>
            {mapping("renameTo", "Rename to")}
            <label className="toggle-row">
              <span>
                <b>Overwrite existing file</b>
              </span>
              <input
                type="checkbox"
                checked={Boolean(config.overwrite)}
                onChange={(event) => set("overwrite", event.target.checked)}
              />
            </label>
          </>
        )}
        {node.type === "read_file" && (
          <>
            <FilePathInput
              label="File"
              fieldName="path"
              value={String(config.path ?? "")}
              onChange={(value) => set("path", value)}
              onChoose={() => chooseFile("path")}
            />
            <Field label="Maximum size">
              <div className="input-unit">
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={Math.round(Number(config.maximumBytes ?? 10485760) / 1048576)}
                  onChange={(event) =>
                    set("maximumBytes", Number(event.target.value) * 1048576)
                  }
                />
                <span>MB</span>
              </div>
            </Field>
          </>
        )}
        {node.type === "write_file" && (
          <>
            <FilePathInput
              label="Target file"
              fieldName="path"
              value={String(config.path ?? "")}
              onChange={(value) => set("path", value)}
              onChoose={() => chooseFile("path")}
            />
            {mapping("content", "Content", { multiline: true })}
            <label className="toggle-row">
              <span><b>Overwrite existing file</b></span>
              <input type="checkbox" checked={Boolean(config.overwrite)} onChange={(event)=>set("overwrite",event.target.checked)}/>
            </label>
            <label className="toggle-row">
              <span><b>Create parent folders</b></span>
              <input type="checkbox" checked={Boolean(config.createParents)} onChange={(event)=>set("createParents",event.target.checked)}/>
            </label>
          </>
        )}
        {node.type === "copy_path" && (
          <>
            <FilePathInput label="Source" fieldName="source" value={String(config.source ?? "")} onChange={(value)=>set("source",value)} onChoose={()=>chooseFile("source")}/>
            {mapping("destination", "Destination path")}
            <label className="toggle-row">
              <span><b>Overwrite destination</b></span>
              <input type="checkbox" checked={Boolean(config.overwrite)} onChange={(event)=>set("overwrite",event.target.checked)}/>
            </label>
          </>
        )}
        {node.type === "delete_path" && (
          <>
            <IssueNotice
              issue={{ code: "destructive_operation_review", severity: "warning", message: "Destructive operation", suggestion: "The path must be inside an approved folder. Test runs require an additional confirmation." }}
              context={{ workflowId: workflow.id, nodeId: node.id, fieldPath: "configuration.path" }}
            />
            <FilePathInput label="Path" fieldName="path" value={String(config.path ?? "")} onChange={(value)=>set("path",value)} onChoose={()=>chooseFile("path")}/>
            <label className="toggle-row">
              <span><b>Allow recursive folder deletion</b></span>
              <input type="checkbox" checked={Boolean(config.recursive)} onChange={(event)=>set("recursive",event.target.checked)}/>
            </label>
          </>
        )}
        {node.type === "list_folder" && (
          <>
            <Field label="Folder"><FolderInput fieldName="folder" value={String(config.folder ?? "")} onChoose={()=>chooseFolder("folder")}/></Field>
            <Field label="Pattern"><input value={String(config.pattern ?? "*")} onChange={(event)=>set("pattern",event.target.value)}/></Field>
            <label className="toggle-row">
              <span><b>Include subfolders</b></span>
              <input type="checkbox" checked={Boolean(config.recursive)} onChange={(event)=>set("recursive",event.target.checked)}/>
            </label>
          </>
        )}
        {(node.type === "parse_csv" || node.type === "parse_json" || node.type === "parse_text") && (
          <>
            <FilePathInput label="Optional file" fieldName="path" value={String(config.path ?? "")} onChange={(value)=>set("path",value)} onChoose={()=>chooseFile("path")}/>
            {mapping("content", "Mapped or pasted content", { multiline: true })}
            <Info>Mapped content takes precedence over the optional file path.</Info>
          </>
        )}
        {node.type === "parse_csv" && (
          <>
            <Field label="Delimiter"><input maxLength={1} value={String(config.delimiter ?? ",")} onChange={(event)=>set("delimiter",event.target.value)}/></Field>
            <label className="toggle-row"><span><b>First row contains headers</b></span><input type="checkbox" checked={Boolean(config.hasHeaders)} onChange={(event)=>set("hasHeaders",event.target.checked)}/></label>
            <label className="toggle-row"><span><b>Trim fields</b></span><input type="checkbox" checked={Boolean(config.trim)} onChange={(event)=>set("trim",event.target.checked)}/></label>
          </>
        )}
        {node.type === "parse_text" && (
          <>
            <label className="toggle-row"><span><b>Trim text</b></span><input type="checkbox" checked={Boolean(config.trim)} onChange={(event)=>set("trim",event.target.checked)}/></label>
            <label className="toggle-row"><span><b>Remove empty lines</b></span><input type="checkbox" checked={Boolean(config.removeEmptyLines)} onChange={(event)=>set("removeEmptyLines",event.target.checked)}/></label>
          </>
        )}
        {(node.type === "get_workflow_state" || node.type === "set_workflow_state" || node.type === "compare_previous") && (
          <>
            {mapping("key", "State key")}
            {node.type === "get_workflow_state" && <JsonField label="Default value" value={config.defaultValue ?? null} onChange={(value)=>set("defaultValue",value)}/>} 
            {(node.type === "set_workflow_state" || node.type === "compare_previous") && <JsonField label="Value" value={config.value ?? null} onChange={(value)=>set("value",value)}/>} 
            {node.type === "compare_previous" && <Field label="Normalization"><CustomSelect value={String(config.normalization ?? "trim")} onChange={(event)=>set("normalization",event.target.value)}><option value="trim">Trim</option><option value="lowercase">Trim and lowercase</option><option value="collapse_whitespace">Collapse whitespace</option><option value="none">Exact value</option></CustomSelect></Field>}
            <Info>State changes are committed only after the complete workflow succeeds. Individual node tests only preview them.</Info>
          </>
        )}
        {node.type === "ai_prompt" && (
          <>
            <div className="node-capability-callout ai-node-callout">
              <Bot size={16} />
              <div><b>Waits for a live model response</b><p>The workflow pauses here until the selected AI answers or the timeout is reached.</p></div>
            </div>
            <Field label="AI connection">
              <CustomSelect value={String(config.connectionId ?? "")} onChange={(event) => set("connectionId", event.target.value)}>
                <option value="">Select connected AI…</option>
                {connections
                  .filter((connection) => ["openai", "anthropic", "openai_compatible"].includes(connection.provider) && connection.status === "connected")
                  .map((connection) => <option key={connection.id} value={connection.id}>{connection.displayName} · {String(connection.metadata.model ?? "model")}</option>)}
              </CustomSelect>
              {!connections.some((connection) => ["openai", "anthropic", "openai_compatible"].includes(connection.provider) && connection.status === "connected") && (
                <small className="field-hint">Add an AI connection in Settings → Connections first.</small>
              )}
            </Field>
            {mapping("prompt", "Instruction", { multiline: true })}
            <Field label="System instruction" hint="Sets the model's role for this step">
              <textarea rows={4} value={String(config.systemPrompt ?? "")} onChange={(event) => set("systemPrompt", event.target.value)} />
            </Field>
            <div className="field-grid">
              <Field label="Max tokens"><input type="number" min="64" max="32000" value={Number(config.maxTokens ?? 1200)} onChange={(event) => set("maxTokens", Number(event.target.value))} /></Field>
              <Field label="Creativity"><input type="number" min="0" max="1" step="0.1" value={Number(config.temperature ?? 0.2)} onChange={(event) => set("temperature", Number(event.target.value))} /></Field>
            </div>
            <TimeoutField config={config} set={set} />
          </>
        )}
        {isCodeNode(node.type) && (
          <>
            <div className="code-node-summary">
              <span><Code2 size={17} /></span>
              <div><b>{String(config.language ?? "javascript")}</b><small>{String(config.sourceCode ?? "").split("\n").length} lines · {String(config.sourceCode ?? "").length} characters</small></div>
              <button className="button" type="button" onClick={() => setCodeEditorOpen(true)}><Pencil size={13} /> Edit code</button>
            </div>
            {(config.language === "python" || config.language === "javascript") && (
              <Field label="Workflow behaviour">
                <CustomSelect value={String(config.executionMode ?? "source")} onChange={(event) => set("executionMode", event.target.value)}>
                  <option value="source">Provide source to the next node</option>
                  <option value="run">Execute script and await result</option>
                </CustomSelect>
              </Field>
            )}
            {config.executionMode === "run" && (config.language === "python" || config.language === "javascript") && (
              <IssueNotice
                issue={{ code: "restricted_code_execution", severity: "info", message: "Restricted local code execution", suggestion: "Requires command execution permission. Input is delivered over a private runtime protocol; ambient environment, network, process, module and filesystem access are denied." }}
                context={{ workflowId: workflow.id, nodeId: node.id }}
              />
            )}
            {config.executionMode === "run" && (
              <>
                <Field label="Execution mode">
                  <CustomSelect value={String(config.itemMode ?? "all_items")} onChange={(event) => set("itemMode", event.target.value)}>
                    <option value="all_items">Run once for all items</option>
                    <option value="each_item">Run once for each item</option>
                  </CustomSelect>
                </Field>
                <div className="info-note">Runtime {String(config.runtimeVersion ?? (config.language === "python" ? ">=3.11" : ">=20"))} · helpers v{String(config.helperLanguageVersion ?? 1)} · built-ins only. Local desktop is the only compatible target in this release.</div>
                <Field label="Manual test data source" hint="Pinned data is used when no execution is selected">
                  <CustomSelect value={testDataExecutionId} onChange={event=>onTestDataExecutionChange?.(event.target.value)}>
                    <option value="">Pinned input / empty input</option>
                    {testDataExecutions.map(execution=><option key={execution.id} value={execution.id}>{new Date(execution.startedAt).toLocaleString()} · {execution.status} · {execution.id.slice(0,8)}</option>)}
                  </CustomSelect>
                </Field>
                <Field label="Expression environment allowlist" hint="Names only; values stay runner-side">
                  <textarea rows={3} value={(workflow.settings.permissions.approvedEnvironmentVariables??[]).join("\n")} placeholder="ALLOWED_VALUE" onChange={event=>onChange(node,{settings:{...workflow.settings,permissions:{...workflow.settings.permissions,approvedEnvironmentVariables:event.target.value.split("\n").map(value=>value.trim()).filter(Boolean)}}})} />
                </Field>
                <JsonField label="Pinned test input" value={config.pinnedData ?? []} onChange={(value) => set("pinnedData", value)} />
                <Info>Pinned data is used only by manual node tests and is never substituted into scheduled or deployed runs.</Info>
              </>
            )}
            {config.executionMode === "run" && <TimeoutField config={config} set={set} />}
            <Info>HTML, JavaScript, and CSS source blocks can connect directly to a Web Builder node.</Info>
          </>
        )}
        {node.type === "web_builder" && (
          <>
            <div className="node-capability-callout web-builder-callout">
              <ExternalLink size={16} />
              <div><b>Localhost site</b><p>Combines the three mapped code inputs, starts a loopback-only server, and returns its URL.</p></div>
            </div>
            <Field label="Port" hint="Use 0 to choose an available port automatically">
              <input type="number" min="0" max="65535" value={Number(config.port ?? 0)} onChange={(event) => set("port", Number(event.target.value))} />
            </Field>
            <label className="toggle-row">
              <span><b>Open site after building</b><small>Launch the localhost URL in your default browser.</small></span>
              <input type="checkbox" checked={Boolean(config.openBrowser)} onChange={(event) => set("openBrowser", event.target.checked)} />
            </label>
            <Info>Map HTML, JavaScript, and CSS from three upstream Code nodes in Data mapping above.</Info>
          </>
        )}
        {node.type === "run_command" && (
          <>
            <IssueNotice
              issue={{ code: "high_risk_capability", severity: "warning", message: "High-risk capability", suggestion: "Automatic runs require explicit permission review. Executable and arguments are passed separately." }}
              context={{ workflowId: workflow.id, nodeId: node.id }}
            />
            <Field label="Executable">
              <input
                placeholder="C:\\Tools\\processor.exe"
                value={String(config.executable ?? "")}
                onChange={(event) => set("executable", event.target.value)}
              />
            </Field>
            <Field label="Arguments" hint="One argument per line">
              <textarea
                rows={4}
                value={((config.arguments as string[]) ?? []).join("\n")}
                onChange={(event) =>
                  set("arguments", event.target.value.split("\n"))
                }
              />
            </Field>
            <Field label="Working directory">
              <FolderInput
                fieldName="workingDirectory"
                value={String(config.workingDirectory ?? "")}
                onChoose={() => chooseFolder("workingDirectory")}
              />
            </Field>
          </>
        )}

        {node.plugin && (
          <>
            <div className="info-note">
              Pinned to {node.plugin.pluginId} v{node.plugin.pluginVersion} (
              {node.plugin.packageIntegrity.slice(7, 19)}). Updates never change
              this node automatically.
            </div>
            {definition.externalEffect === "external_write" && node.type !== "github.request_reviewers" && (
              <IssueNotice
                issue={{ code: "external_write_review", severity: "info", message: "External write", suggestion: "This node changes data in the connected service." }}
                context={{ workflowId: workflow.id, nodeId: node.id }}
              />
            )}
            {node.type === "github.request_reviewers" && (
              <IssueNotice
                issue={{ code: "externally_visible_action", severity: "info", message: "Externally visible action", suggestion: "Requesting reviewers sends GitHub notifications to the selected users and teams." }}
                context={{ workflowId: workflow.id, nodeId: node.id }}
              />
            )}
            {definition.externalEffect === "destructive_or_high_impact" && (
              <IssueNotice
                issue={{ code: "high_impact_external_write", severity: "warning", message: node.type === "github.merge_pull_request" ? "External write: merges code" : "High-impact external write", suggestion: "This operation can merge or otherwise make consequential changes. Review every mapped value." }}
                context={{ workflowId: workflow.id, nodeId: node.id }}
              />
            )}
            <PluginSchemaForm
              nodeType={node.type}
              schema={definition.configurationSchema ?? {}}
              value={config}
              connections={connections}
              connectionRequirements={definition.connectionRequirements ?? []}
              fileInputs={definition.fileInputs ?? []}
              onChooseFile={chooseFileGrant}
              onChange={(value, connectionId) =>
                onChange({
                  ...node,
                  configuration: value,
                  plugin: connectionId !== undefined
                    ? {
                        ...node.plugin!,
                        credentialReferences: {
                          ...(node.plugin!.credentialReferences ?? {}),
                          connection: connectionId,
                        },
                      }
                    : node.plugin,
                })
              }
            />
            <JsonField
              label="Input mapping"
              value={node.plugin.input ?? {}}
              onChange={(value) =>
                onChange({ ...node, plugin: { ...node.plugin!, input: value } })
              }
            />
          </>
        )}

        <label className="toggle-row">
          <span>
            <b>Disable node</b>
            <small>Keep it in the workflow without running it.</small>
          </span>
          <input
            aria-label="Disable node"
            type="checkbox"
            checked={node.disabled}
            onChange={(event) =>
              onChange({ ...node, disabled: event.target.checked })
            }
          />
        </label>
        {locatorTest && <div className="info-note">{locatorTest}</div>}
      </div>
      <div className="inspector-footer">
        <button className="button danger-text" onClick={onDelete}>
          <Trash2 size={14} />
          Delete node
        </button>
      </div>
      {isCodeNode(node.type) && (
        <Suspense fallback={null}>
          <CodeEditorDialog
            open={codeEditorOpen}
            onOpenChange={setCodeEditorOpen}
            language={String(config.language ?? (node.type === "python_code" ? "python" : "javascript")) as CodeLanguage}
            value={String(config.sourceCode ?? "")}
            lockedLanguage={node.type === "javascript_code" || node.type === "python_code"}
            onSave={(language, sourceCode) => onChange({
              ...node,
              configuration: {
                ...config,
                language: node.type === "python_code" ? "python" : node.type === "javascript_code" ? "javascript" : language,
                sourceCode,
                executionMode: language === "html" || language === "css" ? "source" : (config.executionMode ?? "source"),
              },
            })}
          />
        </Suspense>
      )}
      <Suspense fallback={null}>
        <RawJsonEditorDialog open={rawJsonEditorOpen} onOpenChange={setRawJsonEditorOpen} value={config} onSave={(configuration) => onChange({ ...node, configuration })} />
      </Suspense>
    </aside>
  );
}

function PluginSchemaForm({
  nodeType,
  schema,
  value,
  connections,
  connectionRequirements,
  fileInputs,
  onChooseFile,
  onChange,
}: {
  nodeType: string;
  schema: Record<string, unknown>;
  value: Record<string, unknown>;
  connections: ConnectionMetadata[];
  connectionRequirements: Array<{ reference: string; provider: string; permissions: string[]; required: boolean }>;
  fileInputs: Array<{ key: string; required: boolean; maximumBytes?: number; acceptedMimeTypes?: string[] }>;
  onChooseFile: (key: string, maximumBytes?: number) => Promise<void>;
  onChange: (value: Record<string, unknown>, connectionId?: string) => void;
}) {
  const [resourceOptions,setResourceOptions]=useState<Record<string,Array<{id:string;label:string}>>>({});
  const [loadingResource,setLoadingResource]=useState<string>();
  const properties = (schema.properties && typeof schema.properties === "object"
    ? schema.properties
    : {}) as Record<string, Record<string, unknown>>;
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const patch = (key: string, next: unknown, connectionId?: string) =>
    onChange({ ...value, [key]: next }, connectionId);
  const loadResource=async(key:string,kind:string)=>{
    const connectionId=String(value.connectionId??"");if(!connectionId)return;
    setLoadingResource(key);
    try{const items=await api.listIntegrationResources(connectionId,kind,kind==="github_workflow"||kind==="github_branch"?String(value.repository??""):undefined);setResourceOptions((current)=>({...current,[key]:items.map((item)=>({id:item.id,label:item.label}))}));}finally{setLoadingResource(undefined);}
  };
  return (
    <div className="plugin-schema-form">
      {Object.entries(properties).map(([key, property]) => {
        const label = String(property.title ?? key.replaceAll(/([A-Z])/g, " $1").replace(/^./, (letter) => letter.toUpperCase()));
        const description = typeof property.description === "string" ? property.description : undefined;
        const format = String(property.format ?? "");
        if (format === "connection") {
          const provider = String(property["x-sndbox-provider"] ?? connectionRequirements[0]?.provider ?? "");
          const available = connections.filter((connection) => connection.provider === provider && connection.status === "connected");
          return (
            <Field key={key} label={label} hint={description}>
              <CustomSelect value={String(value[key] ?? "")} onChange={(event) => patch(key, event.target.value, event.target.value)}>
                <option value="">Select connection…</option>
                {available.map((connection) => <option key={connection.id} value={connection.id}>{connection.displayName}</option>)}
              </CustomSelect>
              {!available.length && <small className="field-hint">Add an available {provider.replaceAll("_", " ")} connection in Settings.</small>}
            </Field>
          );
        }
        if (format === "file-grant") {
          const definition = fileInputs.find((input) => input.key === key);
          return (
            <Field key={key} label={label} hint="The opaque grant expires after 15 minutes and is consumed after upload.">
              <div className="path-input">
                <input readOnly value={value[key] ? `Secure grant ${String(value[key]).slice(0, 8)}…` : ""} placeholder="No file granted" />
                <button className="button" type="button" onClick={() => void onChooseFile(key, definition?.maximumBytes)}><FolderOpen size={14} /> Choose file</button>
              </div>
            </Field>
          );
        }
        const resourceKind=pluginResourceKind(nodeType,key);
        if(resourceKind){const options=resourceOptions[key]??[];const listId=`resource-${key}-${nodeType.replaceAll(".","-")}`;return <Field key={key} label={label} hint={description}><div className="path-input"><input list={listId} required={required.has(key)} value={String(value[key]??property.default??"")} onFocus={()=>{if(!options.length)void loadResource(key,resourceKind);}} onChange={(event)=>patch(key,event.target.value)} placeholder={resourceKind==="github_branch"?"Choose or enter an expression":"Choose or enter a value"}/><datalist id={listId}>{options.map((option)=><option key={option.id} value={option.id}>{option.label}</option>)}</datalist><button type="button" className="button" disabled={!value.connectionId||loadingResource===key} onClick={()=>void loadResource(key,resourceKind)}><RefreshCcw size={13}/>{loadingResource===key?"Loading…":"Browse"}</button></div></Field>;}
        if (Array.isArray(property.enum)) {
          return <Field key={key} label={label} hint={description}><CustomSelect value={String(value[key] ?? property.default ?? "")} onChange={(event) => patch(key, event.target.value)}>{property.enum.map((option) => <option key={String(option)} value={String(option)}>{String(option).replaceAll("_", " ")}</option>)}</CustomSelect></Field>;
        }
        if (property.type === "boolean") {
          return <label key={key} className="toggle-row"><span><b>{label}</b>{description && <small>{description}</small>}</span><input type="checkbox" checked={Boolean(value[key] ?? property.default)} onChange={(event) => patch(key, event.target.checked)} /></label>;
        }
        if (property.type === "integer" || property.type === "number") {
          return <Field key={key} label={label} hint={description}><input type="number" required={required.has(key)} min={Number(property.minimum ?? undefined)} max={Number(property.maximum ?? undefined)} value={String(value[key] ?? property.default ?? "")} onChange={(event) => patch(key, event.target.value === "" ? undefined : Number(event.target.value))} /></Field>;
        }
        if (property.type === "array" && (property.items as Record<string, unknown> | undefined)?.type === "string") {
          return <Field key={key} label={label} hint={description ?? "One value per line"}><textarea rows={3} value={Array.isArray(value[key]) ? (value[key] as unknown[]).join("\n") : ""} onChange={(event) => patch(key, event.target.value.split("\n").map((item) => item.trim()).filter(Boolean))} /></Field>;
        }
        if (property.type === "object" || property.type === "array") {
          return <JsonField key={key} label={label} value={value[key] ?? property.default ?? (property.type === "array" ? [] : {})} onChange={(next) => patch(key, next)} />;
        }
        const multiline = /body|description|comment|message/i.test(key);
        return <Field key={key} label={label} hint={description}>{multiline ? <textarea rows={3} required={required.has(key)} value={String(value[key] ?? property.default ?? "")} onChange={(event) => patch(key, event.target.value)} /> : <input required={required.has(key)} value={String(value[key] ?? property.default ?? "")} onChange={(event) => patch(key, event.target.value)} />}</Field>;
      })}
    </div>
  );
}

function pluginResourceKind(nodeType:string,key:string):string|undefined{
  if(key==="repository"&&nodeType.startsWith("github."))return "github_repository";
  if(key==="workflow"&&nodeType.startsWith("github."))return "github_workflow";
  if(["head","base","branch","ref"].includes(key)&&nodeType.startsWith("github."))return "github_branch";
  if(key==="channelId"&&nodeType.startsWith("slack."))return "slack_channel";
  if(key==="dataSourceId"&&nodeType.startsWith("notion."))return "notion_data_source";
  if(key==="calendarId"&&nodeType.startsWith("google.calendar."))return "google_calendar";
  if(key==="spreadsheetId"&&nodeType.startsWith("google.sheets."))return "google_spreadsheet";
  return undefined;
}

function LocatorEditor({
  value,
  onChange,
  onTest,
}: {
  value: unknown;
  onChange: (value: StructuredLocator) => void;
  onTest?: (value: StructuredLocator) => Promise<string>;
}) {
  const locator = normalizeLocator(value);
  const patchPrimary = (patch: Partial<StructuredLocator["primary"]>) =>
    onChange({ ...locator, primary: { ...locator.primary, ...patch } });
  return (
    <div className="locator-editor" data-field="locator">
      <div className="locator-heading">
        <span>
          <LocateFixed size={13} />
          Target element
        </span>
        <em>Ranked locator</em>
      </div>
      <div className="field-grid">
        <Field label="Strategy">
          <CustomSelect
            value={locator.primary.kind}
            onChange={(event) =>
              patchPrimary({
                kind: event.target
                  .value as StructuredLocator["primary"]["kind"],
              })
            }
          >
            {locatorKinds.map((kind) => (
              <option key={kind} value={kind}>
                {kind.replace("_", " ")}
              </option>
            ))}
          </CustomSelect>
        </Field>
        <Field label="Role / name">
          <input
            value={locator.primary.name ?? ""}
            onChange={(event) =>
              patchPrimary({ name: event.target.value || undefined })
            }
            placeholder="Accessible name"
          />
        </Field>
      </div>
      <Field label="Locator value">
        <input
          value={locator.primary.value}
          onChange={(event) => patchPrimary({ value: event.target.value })}
          placeholder="button, Email address, data-testid…"
        />
      </Field>
      <details>
        <summary>Alternative locators ({locator.alternatives.length})</summary>
        <JsonField
          label="Ranked alternatives"
          value={locator.alternatives}
          onChange={(alternatives) =>
            onChange({
              ...locator,
              alternatives: Array.isArray(alternatives)
                ? (alternatives as StructuredLocator["alternatives"])
                : [],
            })
          }
        />
      </details>
      <div className="locator-footer">
        <small className="locator-note">
          Execution rejects ambiguous matches and records every attempted
          locator.
        </small>
        {onTest && (
          <button
            type="button"
            className="button compact"
            onClick={() => void onTest(locator)}
          >
            Test locator
          </button>
        )}
      </div>
    </div>
  );
}

function ConnectionSelect({
  provider,
  value,
  connections,
  onChange,
}: {
  provider: string;
  value: string;
  connections: ConnectionMetadata[];
  onChange: (value: string) => void;
}) {
  const available = connections.filter(
    (connection) =>
      connection.provider === provider && connection.status === "connected",
  );
  return (
    <Field
      label={`${provider.charAt(0).toUpperCase() + provider.slice(1)} connection`}
    >
      <CustomSelect value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Select connection…</option>
        {available.map((connection) => (
          <option key={connection.id} value={connection.id}>
            {connection.displayName}
          </option>
        ))}
      </CustomSelect>
      {available.length === 0 && (
        <small className="locator-note">
          Add or reconnect this provider in Settings → Connections.
        </small>
      )}
    </Field>
  );
}

function normalizeLocator(value: unknown): StructuredLocator {
  if (value && typeof value === "object" && "primary" in value)
    return value as StructuredLocator;
  return {
    primary: { kind: "role", value: "button", name: "" },
    alternatives: [],
    tag: "*",
    stableAttributes: {},
    framePath: [],
    recordingUrl: "",
  };
}

function DataBindings({
  definition,
  workflow,
  node,
  onChange,
  sampleRun,
}: {
  definition: NodeDefinition;
  workflow: Workflow;
  node: WorkflowNode;
  onChange: (node: WorkflowNode) => void;
  sampleRun?: ExecutionRecord;
}) {
  const upstreamIds = new Set<string>();
  const pending = [node.id];
  while (pending.length) {
    const target = pending.pop()!;
    workflow.edges
      .filter((edge) => edge.targetNodeId === target)
      .forEach((edge) => {
        if (!upstreamIds.has(edge.sourceNodeId)) {
          upstreamIds.add(edge.sourceNodeId);
          pending.push(edge.sourceNodeId);
        }
      });
  }
  const sources = workflow.nodes.filter((candidate) =>
    upstreamIds.has(candidate.id),
  );
  const setBinding = (field: string, binding?: InputBinding) => {
    const next = { ...(node.inputBindings ?? {}) };
    if (binding) next[field] = binding;
    else delete next[field];
    onChange({ ...node, inputBindings: next });
  };
  return (
    <details className="data-bindings" open={Object.keys(node.inputBindings ?? {}).length > 0}>
      <summary>
        <span><b>Data mapping</b><small>Typed values from upstream nodes</small></span>
        <span className="binding-count">{Object.keys(node.inputBindings ?? {}).length}</span>
      </summary>
      <div className="data-binding-list">
        {definition.inputs.map((input) => {
          const binding = node.inputBindings?.[input.key];
          const selected = binding?.kind === "node_output"
            ? JSON.stringify([binding.nodeId, binding.path ?? []])
            : "";
          const options = sources.flatMap((source) =>
            samplePaths(source, sampleRun).length ? samplePaths(source, sampleRun).filter((item) => compatiblePort(input.type, item.type)).map((item) => ({source,output:item})) : definitionFor(source.type).outputs
              .filter((output) => compatiblePort(input.type, output.type))
              .map((output) => ({ source, output })),
          );
          return (
            <label key={input.key} className="data-binding-row">
              <span>
                <b>{input.label}{input.required ? " *" : ""}</b>
                <small>{input.type}</small>
              </span>
              <CustomSelect
                aria-label={`Map ${input.label}`}
                value={selected}
                onChange={(event) => {
                  if (!event.target.value) return setBinding(input.key);
                  const [nodeId, path] = JSON.parse(event.target.value) as [string, string[]];
                  setBinding(input.key, { kind: "node_output", nodeId, path });
                }}
              >
                <option value="">Use static configuration</option>
                {options.map(({ source, output }) => (
                  <option key={`${source.id}:${output.key}`} value={JSON.stringify([source.id,output.key.split(".")])}>
                    {source.name} · {output.label} ({output.type})
                  </option>
                ))}
              </CustomSelect>
            </label>
          );
        })}
        {!sources.length && <small>Connect an upstream node to make its typed outputs available here.</small>}
      </div>
    </details>
  );
}

function samplePaths(node: WorkflowNode, run?: ExecutionRecord) {
  const execution = run?.nodeExecutions.find((entry) => entry.nodeId === node.id);
  if (!execution) return [];
  const paths:Array<{key:string;label:string;type:import("../types").ValueType}> = [];
  const visit=(value:unknown,path:string[],depth:number)=>{
    if(depth>5||paths.length>=100)return;
    const type:import("../types").ValueType=Array.isArray(value)?"array":value===null?"any":typeof value==="object"?"object":typeof value==="number"?"number":typeof value==="boolean"?"boolean":"string";
    if(path.length)paths.push({key:path.join("."),label:`${path.join(".")} · ${previewSample(value)}`,type});
    if(value&&typeof value==="object"&&!Array.isArray(value))Object.entries(value as Record<string,unknown>).forEach(([key,child])=>visit(child,[...path,key],depth+1));
    else if(Array.isArray(value)&&value.length)visit(value[0],[...path,"0"],depth+1);
  };
  visit(execution.output,[],0);return paths;
}
function previewSample(value:unknown){if(value&&typeof value==="object"&&("reference" in (value as object)))return "binary reference";const text=typeof value==="string"?value:JSON.stringify(value);return (text??"null").slice(0,42)+(String(text??"").length>42?"…":"");}

function compatiblePort(expected: string, actual: string) {
  return expected === "any" || actual === "any" || expected === actual || (expected === "string" && actual === "path") || (expected === "path" && actual === "string");
}

function FilePathInput({
  label,
  fieldName,
  value,
  onChange,
  onChoose,
}: {
  label: string;
  fieldName: string;
  value: string;
  onChange: (value: string) => void;
  onChoose: () => void;
}) {
  return (
    <Field label={label}>
      <div className="folder-input" data-field={fieldName}>
        <input name={fieldName} value={value} onChange={(event)=>onChange(event.target.value)}/>
        <button type="button" onClick={onChoose} aria-label={`Choose ${label.toLowerCase()}`}><FolderOpen size={14}/></button>
      </div>
    </Field>
  );
}

function MappedInput({
  fieldName,
  label,
  value,
  workflow,
  currentNodeId,
  multiline,
  sensitive,
  sampleRun,
  onChange,
}: {
  fieldName: string;
  label: string;
  value: string;
  workflow: Workflow;
  currentNodeId: string;
  multiline?: boolean;
  sensitive?: boolean;
  sampleRun?: ExecutionRecord;
  onChange: (value: string) => void;
}) {
  const upstreamIds=new Set<string>();const pending=[currentNodeId];while(pending.length){const target=pending.pop()!;workflow.edges.filter(edge=>edge.targetNodeId===target).forEach(edge=>{if(!upstreamIds.has(edge.sourceNodeId)){upstreamIds.add(edge.sourceNodeId);pending.push(edge.sourceNodeId);}});}
  const nodes = workflow.nodes.filter((node) => upstreamIds.has(node.id));
  const mapped =
    value.includes("{{") ||
    value.startsWith("nodes.") ||
    value.startsWith("trigger.");
  const [pickerValue,setPickerValue]=useState("");
  const variableOptions=[
    ...(workflow.settings.permissions.approvedEnvironmentVariables??[]).map(name=>({value:`env.${name}`,label:`Environment: ${name} (runner-side)`})),
    {value:"trigger.body",label:"Trigger · body"},{value:"input",label:"Current input"},{value:"workflow.name",label:"Workflow · name"},{value:"execution.id",label:"Execution · ID"},
    ...nodes.flatMap(source=>{const sampled=samplePaths(source,sampleRun);const outputs=sampled.length?sampled:definitionFor(source.type).outputs;return outputs.map(output=>({value:`nodes.${source.id}.output.${output.key}`,label:`${source.name} · ${output.label} (${output.type})`}));}),
  ];
  const runnerOnlyEnvironment=/{{\s*env(?:\.|\[)/.test(value);
  const staleSample=Boolean(sampleRun&&sampleRun.workflowVersion!==workflow.schemaVersion);
  let preview:ReturnType<typeof previewExpression>|undefined;let previewError="";if(mapped&&!runnerOnlyEnvironment){try{preview=previewExpression(value,expressionContext(workflow,sampleRun,currentNodeId));}catch(error){previewError=String(error instanceof Error?error.message:error);}}
  return (
    <Field
      label={label}
      hint={mapped ? "Mapped safe reference" : "Static value or mapped output"}
    >
      <div className="mapped-field">
        <div className="expression-mode-tabs" role="group" aria-label={`${label} value mode`}>
          <button type="button" className={!mapped?"active":""} onClick={()=>{if(mapped)onChange("");}}>Fixed</button>
          <button type="button" className={mapped?"active":""} onClick={()=>{if(!mapped)onChange(`{{ ${value || "input"} }}`);}}>Expression</button>
        </div>
        {multiline ? (
          <textarea
            name={fieldName}
            aria-label={label}
            rows={4}
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
        ) : (
          <input
            name={fieldName}
            aria-label={label}
            type={sensitive && !mapped ? "password" : "text"}
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
        )}
        <div className="path-input">
          <input type="search" list={`variables-${currentNodeId}-${fieldName}`} aria-label={`Search variables for ${label}`} placeholder="Search or enter a variable…" value={pickerValue} onChange={event=>setPickerValue(event.target.value)} />
          <datalist id={`variables-${currentNodeId}-${fieldName}`}>{variableOptions.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</datalist>
          <button type="button" className="button" disabled={!pickerValue} onClick={()=>{onChange(value?`${value} {{ ${pickerValue} }}`:`{{ ${pickerValue} }}`);setPickerValue("");}}>Insert</button>
        </div>
        {mapped && <div className={previewError?"expression-preview error":"expression-preview"}>{runnerOnlyEnvironment?<><b>unavailable</b><span>Environment values stay on the runner and are never sent to the editor.</span></>:previewError||<><b>{preview?.type}</b><span>{previewSample(preview?.value)}</span>{preview?.fallbackUsed&&<em>fallback used</em>}{staleSample&&<em>sample is from another schema revision</em>}</>}</div>}
      </div>
    </Field>
  );
}

function fieldNameFromLabel(label: string) {
  const special: Record<string, string> = {
    "Browser profile": "profileId",
    "Gmail connection": "credentialId",
    "Discord connection": "credentialId",
    "Slack connection": "credentialId",
    "Role / name": "locatorName",
  };
  return (
    special[label] ??
    label
      .replace(/[^a-zA-Z0-9]+(.)/g, (_, next: string) => next.toUpperCase())
      .replace(/^[A-Z]/, (first) => first.toLowerCase())
  );
}

function findIssueControl(field: string) {
  const direct = document.querySelector<HTMLElement>(
    `.inspector [name="${field}"]`,
  );
  if (direct) return direct;
  const container = document.querySelector<HTMLElement>(
    `.inspector [data-field="${field}"]`,
  );
  if (container)
    return container.matches("input,select,textarea,button")
      ? container
      : container.querySelector<HTMLElement>("input,select,textarea,button");
  return undefined;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  const labelled = Children.map(children, (child) => {
    if (
      !isValidElement(child) ||
      typeof child.type !== "string" ||
      !["input", "select", "textarea"].includes(child.type)
    )
      return child;
    const element = child as ReactElement<{
      "aria-label"?: string;
      name?: string;
    }>;
    return cloneElement(element, {
      "aria-label": element.props["aria-label"] ?? label,
      name: element.props.name ?? fieldNameFromLabel(label),
    });
  });
  return (
    <label className="field">
      <span>
        {label}
        {hint && <small>{hint}</small>}
      </span>
      {labelled}
    </label>
  );
}
function FolderInput({
  fieldName,
  value,
  onChoose,
}: {
  fieldName: string;
  value: string;
  onChoose: () => void;
}) {
  return (
    <div className="folder-input">
      <input
        name={fieldName}
        aria-label="Approved folder"
        value={value}
        readOnly
        placeholder="Choose an approved folder"
      />
      <button
        aria-label="Choose approved folder"
        type="button"
        onClick={onChoose}
        disabled={!api.isDesktop}
      >
        <FolderOpen size={15} />
      </button>
    </div>
  );
}
function Info({ children }: { children: ReactNode }) {
  return <div className="info-note">{children}</div>;
}
function TimeoutField({
  config,
  set,
}: {
  config: Record<string, unknown>;
  set: (key: string, value: unknown) => void;
}) {
  return (
    <Field label="Timeout (ms)">
      <input
        type="number"
        min="100"
        max="120000"
        value={Number(config.timeoutMs ?? 30000)}
        onChange={(event) => set("timeoutMs", Number(event.target.value))}
      />
    </Field>
  );
}
function TimeoutAndRetry({
  config,
  set,
}: {
  config: Record<string, unknown>;
  set: (key: string, value: unknown) => void;
}) {
  return (
    <div className="field-grid">
      <TimeoutField config={config} set={set} />
      <Field label="Retries">
        <input
          type="number"
          min="0"
          max="5"
          value={Number(config.retryCount ?? 0)}
          onChange={(event) => set("retryCount", Number(event.target.value))}
        />
      </Field>
    </div>
  );
}
function scalar(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value ?? "");
}
function parseScalar(value: string) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (value.trim() !== "" && !Number.isNaN(Number(value))) return Number(value);
  return value;
}
function JsonField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = "{}";
  }
  return (
    <Field label={label} hint="JSON or safe {{reference}} values">
      <textarea
        className="code-input"
        rows={5}
        defaultValue={text}
        onBlur={(event) => {
          try {
            onChange(JSON.parse(event.target.value));
            event.target.setCustomValidity("");
          } catch {
            event.target.setCustomValidity("Enter valid JSON");
            event.target.reportValidity();
          }
        }}
      />
    </Field>
  );
}
