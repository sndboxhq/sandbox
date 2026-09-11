import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { NODE_DEFINITIONS, type NodeDefinition } from "../src/catalogue";

type FieldOverride = {
  name: string;
  type?: string;
  description?: string;
  options?: string[];
  shownWhen?: string;
};

type NodeGuide = {
  useCases: string[];
  example: {
    title: string;
    description: string;
    configuration?: Record<string, unknown>;
    flow: string[];
  };
  behavior: string[];
  commonIssues: string[];
  related: Array<{ label: string; href: string }>;
};

const repositoryRoot = resolve(import.meta.dirname, "..");
const docsRoot = resolve(repositoryRoot, "apps/docs");
const nodesRoot = resolve(docsRoot, "nodes");
const apiRoot = resolve(docsRoot, "api-reference");

const categoryOrder = ["Triggers", "Logic", "Data", "Network", "Browser", "Communication", "System", "Notes"];
const categoryIcons: Record<string, string> = {
  Triggers: "zap",
  Logic: "git-branch",
  Data: "braces",
  Network: "globe",
  Browser: "mouse-pointer-click",
  Communication: "send",
  System: "terminal",
  Notes: "sticky-note",
};

const fieldDescriptions: Record<string, string> = {
  scheduleType: "Schedule mode used by the local runner.",
  every: "Interval in minutes when the schedule mode is `minutes`.",
  time: "Local time in `HH:mm` format for a daily schedule.",
  cron: "Five- or six-field cron expression for an advanced schedule.",
  folder: "Folder selected through the operating-system picker and added to the workflow permission boundary.",
  pattern: "Optional glob used to filter names inside the approved folder.",
  events: "File-system event types that can start the workflow.",
  credentialId: "Reference to a connection stored in the operating-system credential vault.",
  pollIntervalMinutes: "How often sndbox checks Gmail for matching messages.",
  sender: "Optional sender filter.",
  recipient: "Optional recipient filter.",
  subjectContains: "Optional text that must occur in the message subject.",
  hasAttachment: "Require at least one attachment.",
  label: "Optional Gmail label filter.",
  includeHtmlBody: "Include HTML in addition to the plain-text body.",
  markAsProcessed: "Persist message IDs per workflow so a message cannot trigger repeatedly.",
  left: "Value or mapped output on the left side of the comparison.",
  operator: "Comparison operation.",
  right: "Comparison value; hidden for `exists` and `not_exists`.",
  values: "Structured JSON object produced by the node.",
  amount: "Length of the non-blocking delay.",
  unit: "Unit applied to the delay amount.",
  method: "HTTP request method.",
  url: "Literal URL or mapped URL value.",
  query: "JSON object converted to query parameters.",
  headers: "JSON object of request headers. Authorization and cookie values are redacted from execution data.",
  body: "JSON request body for POST, PUT, and PATCH requests.",
  timeoutMs: "Maximum time for this operation in milliseconds.",
  retryCount: "Number of bounded retries after a retryable failure.",
  title: "Notification, message, or embed title.",
  message: "Notification text; accepts mapped data.",
  source: "Source file or folder inside an approved boundary.",
  destinationFolder: "Approved folder that receives the output.",
  destination: "Destination file or folder path.",
  renameTo: "Optional replacement filename.",
  overwrite: "Allow replacement when the destination already exists.",
  path: "Approved local file or folder path.",
  encoding: "Text encoding used to read the file.",
  maximumBytes: "Maximum accepted file, response, screenshot, or download size in bytes.",
  content: "Literal or mapped content. For parser nodes, mapped content takes precedence over the optional file.",
  createParents: "Create missing parent folders before writing.",
  recursive: "Include nested folders, or permit recursive deletion for Delete File or Folder.",
  delimiter: "Single character separating CSV fields.",
  hasHeaders: "Treat the first CSV row as field names.",
  trim: "Remove leading and trailing whitespace.",
  removeEmptyLines: "Exclude empty lines from parsed text output.",
  key: "Workflow-scoped state key.",
  defaultValue: "Value returned when the state key has not been stored.",
  value: "Literal value, protected reference, or mapped output.",
  normalization: "Text normalization applied before change comparison.",
  executable: "Explicit executable path. It is passed separately from arguments.",
  arguments: "Argument list. Each item is passed as one argument, without shell concatenation.",
  workingDirectory: "Approved working directory for the process.",
  connectionId: "Reference to an AI connection whose credential is stored in the operating-system credential vault.",
  prompt: "Instruction sent to the selected model. It can be mapped from an earlier node output.",
  systemPrompt: "System instruction that defines the model's role for this workflow step.",
  temperature: "Creativity value from 0 to 1.",
  maxTokens: "Maximum number of output tokens requested from the model, from 64 to 32000.",
  language: "Language used for highlighting, diagnostics, AI-assisted authoring, and optional execution.",
  sourceCode: "Complete source stored in the workflow. Open Edit code for the full editor and live Problems panel.",
  executionMode: "Return the source unchanged, or execute supported script languages and wait for their result.",
  input: "Optional mapped JSON-compatible value exposed to a running script through `SNDBOX_INPUT`.",
  html: "HTML source, normally mapped from the `code` output of an HTML Code node.",
  javascript: "Browser-side JavaScript source, normally mapped from the `code` output of a JavaScript Code node.",
  css: "CSS source, normally mapped from the `code` output of a CSS Code node.",
  port: "Loopback port from 0 to 65535. Use 0 to choose an available port automatically.",
  openBrowser: "Open the generated localhost URL in the default browser after the server starts.",
  profileId: "Managed browser profile selected in Settings.",
  headed: "Show the managed browser during a manual run. Scheduled runs default to headless.",
  initialUrl: "Optional first URL opened with the session.",
  viewport: "Browser viewport width and height. The editor accepts 320–3840 by 240–2160 pixels.",
  defaultTimeoutMs: "Default browser operation timeout, from 100 to 120000 milliseconds.",
  closeAutomatically: "Clean up the session when the workflow succeeds or fails.",
  keepOpenAfterManualTest: "Keep a manually tested session open for inspection.",
  maximumDurationMs: "Maximum managed browser session duration.",
  waitCondition: "Page condition Navigate waits for before succeeding.",
  locator: "Recorded locator bundle. sndbox prefers accessible role/name data and retains fallbacks.",
  clickType: "Normal, double, or right click.",
  mouseButton: "Mouse button sent to the page.",
  modifiers: "Keyboard modifiers held during the click.",
  waitAfterMs: "Optional delay after the click.",
  clearExisting: "Clear the field before entering the value.",
  inputDelayMs: "Delay between entered characters, from 0 to 2000 milliseconds.",
  sensitive: "Treat the mapped value as protected and redact it from execution data.",
  selectBy: "Match an option by value, visible label, or zero-based index.",
  option: "Option value, label, or index, depending on `selectBy`.",
  waitFor: "Browser event or state that must occur.",
  delayMs: "Time delay in milliseconds.",
  text: "Text that must be present on the page.",
  urlPattern: "URL pattern matched against navigation or network activity.",
  loadState: "DOM ready, page loaded, or network idle.",
  extract: "Kind of value read from the selected page element.",
  attribute: "HTML attribute name when extracting an attribute.",
  fieldName: "Name used for the extracted output value.",
  repeated: "Return all unique matches as a list instead of one value.",
  fields: "Column mapping used for table extraction, or Discord embed field objects.",
  mode: "Screenshot capture area.",
  includeInHistory: "Attach the screenshot artifact to execution history.",
  filename: "Optional destination filename.",
  collisionBehaviour: "Create a unique name, overwrite, or fail when the filename exists.",
  file: "Local file selected through the picker or mapped from a trusted path output.",
  messageId: "Gmail message or thread ID, usually mapped from a trigger or earlier Gmail node.",
  to: "Comma-separated or mapped recipient value.",
  cc: "Optional CC recipients.",
  bcc: "Optional BCC recipients.",
  subject: "Email subject or approval subject.",
  htmlBody: "Optional HTML email body.",
  replyToMessage: "Optional Gmail message ID to reply to.",
  attachments: "Approved attachment paths.",
  addLabelIds: "Gmail label IDs to add, one per line in the editor.",
  removeLabelIds: "Gmail label IDs to remove, one per line in the editor.",
  username: "Optional Discord webhook username override.",
  avatarUrl: "Optional Discord webhook avatar URL.",
  description: "Discord embed description.",
  color: "Discord embed color as a decimal integer.",
  link: "Optional link for the Discord embed.",
  image: "Optional image URL for the Discord embed.",
  proposedAction: "Plain-language action shown to the reviewer.",
  messagePreview: "Content preview shown before approval.",
  expiresInMinutes: "Time before the local approval expires, from 1 to 10080 minutes.",
};

const nodeFieldDescriptions: Record<string, string> = {
  "note.content": "Plain-text setup instructions or context stored with the workflow. Do not include secrets.",
  "read_file.encoding": "Text encoding used to read the file. The current runner accepts UTF-8 only.",
  "run_command.timeoutMs": "Reserved timeout setting stored in the node schema. The current runner stops the process on cancellation but does not yet enforce this value.",
  "filter.mode":"Keep matching items or remove matching items.","filter.combinator":"Require all rules or any rule.","filter.rules":"Ordered strict rule definitions with stable IDs.","filter.exposeRejected":"Expose removed items through the Rejected branch.",
  "switch.mode":"Route to the first match or every matching case.","switch.routingMode":"Use exact values or strict rule groups.","switch.valuePath":"Item path resolved for exact-value routing.","switch.cases":"Ordered cases with stable branch IDs.","switch.fallbackBranchId":"Stable fallback branch ID.","switch.fallbackName":"Displayed fallback label.",
  "split_out.fieldPath":"Explicit array path; empty selects a top-level array item.","split_out.destinationField":"Property receiving each split element.","split_out.keepParentFields":"Copy parent fields into child items.","split_out.keepOriginalArray":"Retain the source array after splitting.","split_out.includeIndex":"Include the source array index.","split_out.emptyArrayPolicy":"Behavior for an empty selected array.","split_out.invalidInputPolicy":"Behavior for missing or non-array values.",
  "loop_over_items.batchSize":"Number of items in one deterministic iteration batch.","loop_over_items.concurrency":"Maximum active body iterations.","loop_over_items.maxIterations":"Hard iteration bound.","loop_over_items.iterationRetryCount":"Retries an individual iteration with the same stable identity.","loop_over_items.failurePolicy":"Stop or continue after a handled item failure.","loop_over_items.perItemTimeoutMs":"Timeout applied to each body node in an iteration.",
  "aggregate.operation":"Reduction performed over the input collection.","aggregate.fieldPath":"Selected item field for field-based operations.","aggregate.includeMissing":"Represent missing selections deliberately.","aggregate.preserveLineage":"Retain bounded source item identifiers in result evidence.","aggregate.separator":"Separator for string concatenation.","aggregate.groupFields":"Ordered fields forming a deterministic group key.","aggregate.keyField":"Field used as an object property key.","aggregate.duplicateKeyPolicy":"Explicit duplicate object-key behavior.",
  "remove_duplicates.fields":"Comparison paths; empty means whole-item deep equality.","remove_duplicates.caseSensitive":"Use case-sensitive string equality.","remove_duplicates.normalizeWhitespace":"Trim and collapse string whitespace before comparison.","remove_duplicates.keep":"Retain the first or last occurrence.","remove_duplicates.scope":"Deduplicate this collection or successfully committed workflow state.","remove_duplicates.exposeDuplicates":"Expose removed duplicates on a named branch.",
  "merge.mode":"Wait, append, combine, join, multiply or choose named inputs.","merge.inputPorts":"Stable ordered named input ports.","merge.unmatchedPolicy":"Keep, drop or fail on unmatched positions.","merge.join":"Inner, left, right or full outer field join.","merge.leftKey":"Join key path on the first input.","merge.rightKey":"Join key path on the second input.","merge.conflictStrategy":"Nest, prefix, prefer one side or fail on property conflicts.","merge.failedInputPolicy":"Explicit failed-input behavior.","merge.skippedInputPolicy":"Explicit skipped-input behavior.","merge.chooseStrategy":"Choose the first non-empty or first successful input in priority order.","merge.maxResults":"Hard result bound, including Cartesian products.","merge.priority":"Configured branch priority, independent of arrival time.",
};

const extras: Record<string, FieldOverride[]> = {
  navigate: [{ name: "locator", shownWhen: "`waitCondition` is `element_visible`" }],
  wait_for: [
    { name: "text", shownWhen: "`waitFor` is `text_present`" },
    { name: "urlPattern", shownWhen: "`waitFor` is `url_matches` or `network_response`" },
    { name: "loadState", options: ["dom_ready", "page_loaded", "network_idle"], shownWhen: "`waitFor` is `page_load_state`" },
  ],
  extract_data: [{ name: "attribute", shownWhen: "`extract` is `attribute`" }],
  screenshot: [{ name: "locator", shownWhen: "`mode` is `element`" }, { name: "timeoutMs" }],
  gmail_create_draft: [],
  gmail_send_email: [],
};

const options: Record<string, string[]> = {
  "schedule_trigger.scheduleType": ["minutes", "hourly", "daily", "cron"],
  "file_watch_trigger.events": ["created", "modified", "deleted"],
  "gmail_new_email_trigger.markAsProcessed": ["deduplicate"],
  "condition.operator": ["equals", "not_equals", "contains", "not_contains", "greater_than", "greater_than_or_equal", "less_than", "less_than_or_equal", "exists", "not_exists", "is_null", "is_not_null", "is_empty", "is_not_empty", "starts_with", "ends_with", "matches_regex", "is_one_of", "is_not_one_of", "array_contains", "date_before", "date_after", "date_between"],
  "filter.mode":["keep_matches","remove_matches"],"filter.combinator":["all","any"],"switch.mode":["first_match","all_matches"],"switch.routingMode":["rules","value"],
  "split_out.emptyArrayPolicy":["emit_no_items","keep_parent","fail"],"split_out.invalidInputPolicy":["fail","emit_no_items","rejected"],
  "loop_over_items.failurePolicy":["stop","continue_handled"],"aggregate.operation":["collect_items","collect_field","count","sum","minimum","maximum","average","first","last","concatenate","group_by","object_by_key"],
  "aggregate.duplicateKeyPolicy":["fail","keep_first","keep_last"],"remove_duplicates.keep":["first","last"],"remove_duplicates.scope":["collection","workflow_state"],
  "merge.mode":["wait_all","append","combine_position","combine_fields","cartesian","choose_branch"],"merge.unmatchedPolicy":["keep","drop","fail"],"merge.join":["inner","left","right","full"],"merge.conflictStrategy":["nest","prefix","prefer_left","prefer_right","fail"],"merge.failedInputPolicy":["fail","empty"],"merge.skippedInputPolicy":["fail","empty"],"merge.chooseStrategy":["first_non_empty","first_successful"],
  "delay.unit": ["seconds", "minutes"],
  "http_request.method": ["GET", "POST", "PUT", "PATCH", "DELETE"],
  "read_file.encoding": ["utf8"],
  "compare_previous.normalization": ["trim", "lowercase", "collapse_whitespace", "none"],
  "code.language": ["python", "html", "javascript", "css"],
  "code.executionMode": ["source", "run"],
  "navigate.waitCondition": ["dom_ready", "page_loaded", "network_idle", "element_visible"],
  "click_element.clickType": ["normal", "double", "right"],
  "click_element.mouseButton": ["left", "middle", "right"],
  "select_option.selectBy": ["value", "label", "index"],
  "wait_for.waitFor": ["time", "element_visible", "element_hidden", "text_present", "url_matches", "download_begins", "network_response", "page_load_state"],
  "extract_data.extract": ["text", "attribute", "link", "image_source", "table"],
  "screenshot.mode": ["viewport", "full_page", "element"],
  "download_file.collisionBehaviour": ["rename", "overwrite", "fail"],
};

const nodeNotes: Record<string, string[]> = {
  schedule_trigger: ["Schedules are calculated by the local runner. Quitting the desktop app stops local schedules."],
  gmail_new_email_trigger: ["Message IDs are persisted per workflow to prevent the same email from starting repeated runs."],
  http_request: ["Authorization and cookie values are redacted from execution data.", "Retries are capped at 5, timeout is clamped to 100–120000 milliseconds, redirects are limited to 10, and response output is limited to 1 MB."],
  open_browser: ["Create an isolated browser profile in Settings before running this node.", "Sessions are cleaned up after success or failure when `closeAutomatically` is enabled."],
  fill_field: ["Enable `sensitive` for protected mappings so entered values are redacted from logs and execution data."],
  screenshot: ["History artifacts follow the configured screenshot retention policy."],
  upload_file: ["A trusted path output from an earlier node may be mapped after the file has been approved."],
  close_browser: ["Any remaining managed sessions are cleaned up when the workflow ends."],
  gmail_create_draft: ["Drafts are the safer default because nothing is sent until a person reviews the message in Gmail."],
  gmail_send_email: ["Automatic sending requires approval for the selected connection and recipient logic. A material change revokes that approval."],
  discord_webhook: ["The webhook URL is resolved inside the Rust host and never enters workflow data or logs."],
  discord_embed: ["The webhook URL is resolved inside the Rust host and never enters workflow data or logs."],
  slack_webhook: ["The webhook URL is resolved inside the Rust host and never enters workflow data or logs."],
  approval: ["The execution pauses locally and appears in Pending approvals and the system tray until it is approved, rejected, or expires."],
  delete_path: ["The selected path must be inside an approved folder. Test runs require an additional destructive-action confirmation."],
  run_command: ["Automatic runs require explicit permission review. The executable and arguments are passed separately."],
  ai_prompt: [
    "The workflow pauses at this node until the selected provider responds, the request is cancelled, or the configured timeout is reached.",
    "The credential remains in the host vault. The prompt, system instruction, and mapped context are sent to the selected provider.",
    "AI nodes run on the desktop local runner and return the response text, provider-reported usage, and model ID.",
    "Instructions are limited to 100000 characters and timeout is clamped to 1000–300000 milliseconds.",
  ],
  code: [
    "Edit code opens a dedicated editor for Python, HTML, JavaScript, and CSS with syntax highlighting, live syntax and basic type diagnostics, line and column locations, and AI-assisted code writing.",
    "Source mode returns the complete file through `code` without executing it. HTML and CSS always use source mode.",
    "Run mode is available for Python and JavaScript, requires command-execution approval, invokes the installed `python` or `node` executable, and waits for completion. Mapped input is available as JSON in `SNDBOX_INPUT`.",
    "Source is limited to 2 MB, timeout is clamped to 100–120000 milliseconds, and captured standard output and error are each limited to 64 KiB.",
  ],
  web_builder: [
    "The node card exposes separate HTML, JS, and CSS connectors. Connecting a matching Code node creates both the dependency edge and its `code` output binding.",
    "The server binds only to `127.0.0.1`. Port 0 selects an available port, `/health` reports server status, and rerunning this node replaces its previous server for the same workflow.",
    "The combined source is limited to 4 MB. The local site remains available while the desktop app is running.",
  ],
  get_workflow_state: ["State writes are committed only after the complete workflow succeeds. Node tests only preview state changes."],
  set_workflow_state: ["State writes are committed only after the complete workflow succeeds. Node tests only preview state changes."],
  compare_previous: ["The new comparison value is committed only after the complete workflow succeeds."],
  list_folder: ["A listing fails after 10000 matching entries to keep execution output bounded."],
  read_file: ["Only UTF-8 text is accepted. The byte limit is clamped to 1–104857600 bytes."],
  parse_csv: ["Approved file input must be UTF-8 and defaults to a 10 MB limit. Mapped content is used directly."],
  parse_json: ["Approved file input must be UTF-8 and defaults to a 10 MB limit. Mapped content is used directly."],
  parse_text: ["Approved file input must be UTF-8 and defaults to a 10 MB limit. Mapped content is used directly."],
};

const nodeGuides: Record<string, NodeGuide> = {
  note: {
    useCases: ["Keep setup instructions, assumptions, and handoff context beside the workflow they explain.", "Document why a branch, connection, or permission exists without adding an executable step."],
    example: {
      title: "Document an environment prerequisite",
      description: "Place a note near the nodes that depend on a configured connection or local folder.",
      configuration: { content: "Before running: connect the Support account and confirm the staging environment." },
      flow: ["Add a Note from the Notes category.", "Write the prerequisite or decision in concise plain language.", "Position it beside the related nodes so future editors see it before running the workflow."],
    },
    behavior: ["Notes are canvas annotations and never execute.", "They have no input or output ports and do not change workflow data, permissions, scheduling, or run results."],
    commonIssues: ["A note does not enforce the instruction it describes; use validation, permissions, or approval nodes for enforceable safeguards.", "Keep secrets out of note text because annotations are stored with the workflow."],
    related: [{ label: "Build your first workflow", href: "/getting-started/first-workflow" }, { label: "Workflow permissions", href: "/workflows/permissions" }],
  },
  manual_trigger: {
    useCases: ["Build and debug a workflow before choosing an automatic trigger.", "Run an operator-led task where a person should decide exactly when work starts."],
    example: {
      title: "Test a website health check",
      description: "Use a Manual Trigger while building a flow that requests a health endpoint and branches on the returned status.",
      flow: ["Add Manual Trigger as the first node.", "Connect it to HTTP Request, then map the response status into Condition.", "Run from the toolbar and inspect every node before replacing the trigger with a schedule."],
    },
    behavior: ["The trigger emits the run event and execution context; it does not accept input data.", "Starting another run still follows the workflow's concurrency and queue settings."],
    commonIssues: ["If Run is unavailable, complete validation errors elsewhere in the workflow.", "A manual start does not bypass permissions for downstream network, file, command, browser, or communication nodes."],
    related: [{ label: "Build your first workflow", href: "/getting-started/first-workflow" }, { label: "Run locally", href: "/getting-started/run-locally" }],
  },
  schedule_trigger: {
    useCases: ["Run polling, reporting, cleanup, or monitoring flows at a predictable local time.", "Use a cron expression when the minutes, hourly, and daily presets are not precise enough."],
    example: {
      title: "Create a weekday morning report",
      description: "The advanced schedule below starts at 09:00 Monday through Friday according to the runner's local clock.",
      configuration: { scheduleType: "cron", every: 15, time: "09:00", cron: "0 9 * * 1-5" },
      flow: ["Choose Advanced and enter the cron expression.", "Connect the trigger to the report-producing nodes.", "Keep the runner online and verify the next due time on the workflow dashboard."],
    },
    behavior: ["Schedules are evaluated by the local runner and use its local clock and time zone.", "A due event enters the queue; concurrency policy determines whether it starts immediately, waits, or is skipped."],
    commonIssues: ["Closing sndbox stops local schedules because no background runner remains.", "After daylight-saving or time-zone changes, verify the displayed next run rather than assuming UTC behavior."],
    related: [{ label: "Schedules and triggers", href: "/workflows/schedules-and-triggers" }, { label: "Schedules and queue", href: "/execution/schedules-and-queue" }],
  },
  file_watch_trigger: {
    useCases: ["Start an import or filing workflow when a file is created or changed.", "Watch a narrow approved folder and filter noise with a glob such as *.csv."],
    example: {
      title: "Process new CSV exports",
      description: "Watch an approved Inbox folder for newly created CSV files, then map the event path into Parse CSV.",
      configuration: { folder: "C:\\Reports\\Inbox", events: ["created"], pattern: "*.csv" },
      flow: ["Select the folder with the picker so it enters the permission boundary.", "Map the trigger event path to the parser's path input.", "Move successfully processed files to a separate archive folder."],
    },
    behavior: ["The event object identifies the changed path and event kind.", "The folder is both configuration and a filesystem permission boundary; typing an unapproved path is not equivalent to selecting it."],
    commonIssues: ["Applications can emit several filesystem events for one save; make downstream work idempotent.", "A broad pattern on a busy folder can create more queued executions than the runner can process."],
    related: [{ label: "Schedules and triggers", href: "/workflows/schedules-and-triggers" }, { label: "Files and folders", href: "/files-and-data/files-and-folders" }],
  },
  gmail_new_email_trigger: {
    useCases: ["Start triage, drafting, or notification flows from matching Gmail messages.", "Filter at the trigger when only a sender, recipient, subject fragment, label, or attachment state is relevant."],
    example: {
      title: "Draft replies to support mail",
      description: "Poll a connected support inbox every five minutes for messages whose subject contains Support.",
      configuration: { credentialId: "gmail-support", pollIntervalMinutes: 5, sender: "", recipient: "support@example.com", subjectContains: "Support", hasAttachment: false, label: "", includeHtmlBody: false, markAsProcessed: "deduplicate" },
      flow: ["Select the Gmail connection and add the narrowest useful filters.", "Map fields from the email output into analysis or draft nodes.", "Prefer Create Gmail Draft until the recipient logic has been reviewed."],
    },
    behavior: ["sndbox persists observed message IDs per workflow so the same message does not repeatedly trigger it.", "Plain text is included by default; enabling HTML increases the amount and sensitivity of data stored in execution evidence."],
    commonIssues: ["A poll interval is not an exact delivery SLA; the next poll must run and the event must enter the queue.", "If no messages match, test each filter independently and confirm the connection can still access the mailbox."],
    related: [{ label: "Gmail connection", href: "/connections/gmail" }, { label: "Schedules and queue", href: "/execution/schedules-and-queue" }],
  },
  condition: {
    useCases: ["Route success and failure paths from a status, count, boolean, or text match.", "Guard a side-effecting node so it runs only when reviewed criteria are true."],
    example: {
      title: "Branch on an HTTP status",
      description: "Map HTTP Request's status output to the left input and compare it with the number 200.",
      configuration: { left: "{{nodes.request.output.status}}", operator: "equals", right: 200 },
      flow: ["Connect the request to Condition.", "Map status to left and set right to 200.", "Connect the true and false handles to different downstream nodes."],
    },
    behavior: ["The node emits a boolean result and records which branch was followed.", "exists and not_exists ignore the right value; ordering comparisons should receive compatible numbers or strings."],
    commonIssues: ["The string \"200\" and number 200 may not compare as intended; inspect the upstream output type.", "A control edge chooses what runs, while an input binding supplies the value being compared."],
    related: [{ label: "Branches and conditions", href: "/workflows/branches-and-conditions" }, { label: "Data types", href: "/reference/data-types" }],
  },
  filter: {
    useCases:["Keep or remove records from an explicit workflow collection.","Inspect rejected items without turning a collection decision into workflow-level branching."],
    example:{title:"Keep active API records",description:"Split an API result array, then retain only records whose active field is the boolean true.",configuration:{mode:"keep_matches",combinator:"all",rules:[{id:"rule_active",field:"active",operator:"equals",value:true}],exposeRejected:true},flow:["HTTP Request → Split Out → Filter.","Use the Rejected output only when removed records need downstream handling.","Inspect retained and rejected counts in execution history."]},
    behavior:["Rules use strict types: number 200 does not equal string 200.","Missing, null, empty strings, empty arrays, empty objects, and filtered items remain distinct."],
    commonIssues:["Use Condition for one workflow-level true/false decision.","Invalid regular expressions fail validation and runtime evaluation."],related:[{label:"Collections and items",href:"/workflows/collections-and-items"},{label:"Condition",href:"/nodes/condition"}]},
  switch: {
    useCases:["Route records through more than two named outcomes.","Copy one item to every matching case when all-match behavior is deliberate."],
    example:{title:"Route CSV rows by status",description:"Send parsed and split rows through stable named status cases and a fallback.",configuration:{mode:"first_match",routingMode:"value",valuePath:"status",cases:[{id:"approved",name:"Approved",value:"approved"},{id:"review",name:"Review",value:"review"}],fallbackBranchId:"fallback",fallbackName:"Fallback"},flow:["Parse CSV → Split Out → Switch.","Connect cases by their stable IDs.","Converge branches through Merge rather than ordinary multi-input nodes."]},
    behavior:["First match selects the first case in configured order; all matches preserves a shared origin ID across copies.","Unmatched items enter the fallback collection and empty branches remain visible in evidence."],commonIssues:["Renaming and reordering preserve case IDs; deleting a connected case requires confirmation.","Do not use arrival timing to choose a branch."],related:[{label:"Branches and collections",href:"/workflows/collections-and-items"},{label:"Merge",href:"/nodes/merge"}]},
  loop_over_items:{useCases:["Run a visible body once per item or deterministic batch.","Bound parallel item processing while retaining item identity and attempts."],example:{title:"Process approved files sequentially",description:"Filter a folder listing, then process one approved path at a time.",configuration:{batchSize:1,concurrency:1,maxIterations:10000,iterationRetryCount:0,failurePolicy:"stop",perItemTimeoutMs:30000},flow:["List Folder → Filter → Loop Over Items.","Connect Loop to the body and Done to aggregation.","Review side-effect warnings before increasing concurrency."]},behavior:["Batch membership and iteration IDs are deterministic; concurrency greater than one may complete out of order.","Iteration retry reuses identity, cancellation reaches active bodies, and exactly-once side effects are not promised."],commonIssues:["Both Loop and Done outputs must be connected.","Keep a finite maximum iteration count and use idempotent downstream mutations."],related:[{label:"Loops and recovery",href:"/workflows/collections-and-items"},{label:"Retries and recovery",href:"/execution/retries-and-recovery"}]},
  split_out:{useCases:["Turn an explicit array field into workflow items.","Retain selected parent context and original array positions."],example:{title:"Split API results",description:"Expand response.body.results under item while keeping safe parent fields.",configuration:{fieldPath:"response.body.results",destinationField:"item",keepParentFields:true,keepOriginalArray:false,includeIndex:true,emptyArrayPolicy:"emit_no_items",invalidInputPolicy:"fail"},flow:["Map or connect the response collection.","Choose the exact array path.","Test empty, missing and non-array fixtures separately."]},behavior:["Objects and strings are never treated as arrays.","Each child retains its parent and origin identity plus array position."],commonIssues:["An empty path means the input item itself must be an array.","Choose explicit failure, no-output or Rejected behavior for invalid inputs."],related:[{label:"Collections and items",href:"/workflows/collections-and-items"},{label:"Filter",href:"/nodes/filter"}]},
  aggregate:{useCases:["Reduce several items to a count, numeric value, string, group, object or collected array.","Create a single report value after a loop."],example:{title:"Count processed rows",description:"Count all completed items after collection processing.",configuration:{operation:"count",fieldPath:"",includeMissing:false},flow:["Connect a collection-producing node.","Choose an operation and only its relevant fields.","Inspect the aggregate preview and source count."]},behavior:["Numeric operations reject strings rather than coercing them.","Results are deterministic in input order and bounded by aggregate byte policy."],commonIssues:["Empty numeric selections return null; count returns zero.","Object-by-key requires an explicit duplicate-key policy."],related:[{label:"Collections and items",href:"/workflows/collections-and-items"},{label:"Limits",href:"/reference/limits"}]},
  remove_duplicates:{useCases:["Deduplicate one collection by full value or selected keys.","Reject records already committed by successful earlier workflow runs."],example:{title:"Keep one customer per email",description:"Compare normalized email keys and retain the first item.",configuration:{fields:["email"],caseSensitive:false,normalizeWhitespace:true,keep:"first",scope:"collection",exposeDuplicates:true},flow:["Parse CSV → Split Out → Remove Duplicates.","Connect Duplicates only when rejected rows need handling.","Use workflow-state scope only with a visible retention policy."]},behavior:["Deep object equality canonicalizes property order and distinguishes missing from null.","Cross-run keys are staged and commit only when the complete workflow succeeds."],commonIssues:["Visible evidence contains a safe key hash, not raw secret key material.","Cross-run key retention is bounded by runner policy."],related:[{label:"Workflow state",href:"/files-and-data/workflow-state"},{label:"Collections and items",href:"/workflows/collections-and-items"}]},
  merge:{useCases:["Converge named branches without depending on arrival timing.","Append, join, combine or deliberately choose among independent collections."],example:{title:"Join rows by customer ID",description:"Full-outer join two named inputs by explicit keys and nest conflicts by input.",configuration:{mode:"combine_fields",inputPorts:[{id:"input_a",name:"Customers",required:true},{id:"input_b",name:"Orders",required:true}],join:"full",leftKey:"id",rightKey:"customerId",conflictStrategy:"nest",maxResults:25000},flow:["Connect each branch to its named input port.","Set both join keys and duplicate behavior.","Inspect empty inputs and expected result size before running."]},behavior:["Configured port order, never completion timing, determines append and priority order.","Cartesian results and every other result collection are hard bounded."],commonIssues:["Ordinary nodes cannot ambiguously converge; insert Merge.","Flat conflict strategies require object items; nesting is the safest general strategy."],related:[{label:"Merge modes",href:"/workflows/collections-and-items"},{label:"Limits",href:"/reference/limits"}]},
  set_data: {
    useCases: ["Give several upstream values a stable object shape before passing them on.", "Create a small request body or notification payload without writing code."],
    example: {
      title: "Build a normalized incident object",
      description: "Combine mapped values into one object that later nodes can consume consistently.",
      configuration: { values: { service: "checkout", status: "{{nodes.request.output.status}}", urgent: true } },
      flow: ["Add the desired keys in values.", "Map changing fields from earlier outputs.", "Map the value output into an HTTP, AI, or Code node."],
    },
    behavior: ["The output is the resolved object; nested JSON-compatible values are preserved.", "Set Data transforms execution data only and does not persist workflow state between runs."],
    commonIssues: ["Use Set Workflow State if the value must survive the current execution.", "Do not put secrets in a literal object; use protected values or connections at the consuming node."],
    related: [{ label: "Variables and data mapping", href: "/workflows/variables-and-data" }, { label: "JSON data", href: "/files-and-data/json" }],
  },
  delay: {
    useCases: ["Pause briefly between actions when an external system needs processing time.", "Rate-space a sequence without occupying a blocking thread."],
    example: {
      title: "Wait before checking an export",
      description: "Pause for 30 seconds after requesting an export, then continue to the status check.",
      configuration: { amount: 30, unit: "seconds" },
      flow: ["Place Delay after the request that starts the remote work.", "Choose seconds or minutes and a non-negative amount.", "Follow it with an explicit status check rather than assuming the work completed."],
    },
    behavior: ["The wait is cancellable and returns delayedMs when it completes.", "Delay waits once; it is not a retry loop or a page-readiness assertion."],
    commonIssues: ["Prefer Wait For for browser state because fixed delays are sensitive to page speed.", "Long delays keep an execution active and count toward the relevant execution and session limits."],
    related: [{ label: "Retries and recovery", href: "/execution/retries-and-recovery" }, { label: "Wait For", href: "/nodes/wait-for" }],
  },
  http_request: {
    useCases: ["Read JSON from an API without opening a browser.", "Send a bounded JSON request to an approved domain and route on its response."],
    example: {
      title: "Check a JSON health endpoint",
      description: "Request an endpoint once, retry one transient failure, then use status and body in later nodes.",
      configuration: { method: "GET", url: "https://api.example.com/health", query: {}, headers: { Accept: "application/json" }, body: null, timeoutMs: 10000, retryCount: 1 },
      flow: ["Approve api.example.com during permission review.", "Test the node and inspect the actual body shape.", "Map status into Condition and selected body fields into later nodes."],
    },
    behavior: ["Query object values are encoded into the URL; body is intended for POST, PUT, and PATCH.", "The output includes the numeric status, decoded body, and final URL after redirects."],
    commonIssues: ["A non-success HTTP status can still be a valid HTTP response; branch on status when the workflow requires 2xx.", "Keep retries low for mutating methods unless the endpoint supports idempotency."],
    related: [{ label: "HTTP requests guide", href: "/files-and-data/http-requests" }, { label: "Permissions", href: "/workflows/permissions" }],
  },
  desktop_notification: {
    useCases: ["Surface a local success, warning, or review reminder to the operator.", "Finish a monitoring flow with a concise result that does not need an external connection."],
    example: {
      title: "Notify after a report is parsed",
      description: "Include a mapped row count in a local completion message.",
      configuration: { title: "Report ready", message: "Parsed {{nodes.parse.output.rowCount}} rows." },
      flow: ["Give the notification a short, recognizable title.", "Map only the result the operator needs into the message.", "Keep detailed evidence in execution history rather than in the toast."],
    },
    behavior: ["The host asks the operating system to deliver the notification and returns delivered plus the title.", "Delivery is a local side effect and may be subject to operating-system notification settings."],
    commonIssues: ["Focus Assist or disabled notifications can hide a successfully delivered notification.", "Do not include secrets or full sensitive payloads in text visible on the desktop."],
    related: [{ label: "Logs and evidence", href: "/execution/logs-and-evidence" }, { label: "Run locally", href: "/getting-started/run-locally" }],
  },
  move_file: {
    useCases: ["Archive a successfully processed file.", "Route incoming files into folders based on a condition."],
    example: {
      title: "Archive an imported CSV",
      description: "Map the watched file path as the source and move it into an approved Processed folder without overwriting.",
      configuration: { source: "{{trigger.path}}", destinationFolder: "C:\\Reports\\Processed", renameTo: "", overwrite: false },
      flow: ["Approve both the source boundary and destination folder.", "Map the trigger or download path to source.", "Place Move File only after parsing and validation succeed."],
    },
    behavior: ["renameTo changes the final filename while destinationFolder selects its parent.", "The operation fails on an existing destination unless overwrite is enabled."],
    commonIssues: ["The source may still be locked by the program that created it; wait for the producer to finish.", "Keep overwrite off unless replacing an existing file is an explicit part of the workflow."],
    related: [{ label: "Files and folders", href: "/files-and-data/files-and-folders" }, { label: "Permissions", href: "/workflows/permissions" }],
  },
  read_file: {
    useCases: ["Load a text, JSON, CSV, or prompt file from an approved path.", "Pass file content to a parser, AI, or Code node."],
    example: {
      title: "Read a JSON settings file",
      description: "Read at most 1 MiB of UTF-8 text, then map content to Parse JSON.",
      configuration: { path: "C:\\Automation\\settings.json", encoding: "utf8", maximumBytes: 1048576 },
      flow: ["Select or map a trusted file path.", "Keep maximumBytes close to the expected file size.", "Map content into Parse JSON and inspect its value output."],
    },
    behavior: ["The node returns content, the trusted path, and bytes read.", "The maximum size is enforced before unbounded file content enters execution data."],
    commonIssues: ["Binary files are not appropriate input; use a node designed for that artifact.", "A plain string path from an untrusted source may not carry the approval provenance required by the runner."],
    related: [{ label: "Files and folders", href: "/files-and-data/files-and-folders" }, { label: "Parse JSON", href: "/nodes/parse-json" }],
  },
  write_file: {
    useCases: ["Save generated text, JSON, CSV, or code to an approved location.", "Materialize mapped output for another local tool."],
    example: {
      title: "Write a generated summary",
      description: "Write mapped text to a new file and create missing parent folders.",
      configuration: { path: "C:\\Automation\\output\\summary.txt", content: "{{nodes.ai.output.response}}", overwrite: false, createParents: true },
      flow: ["Choose an approved destination path.", "Map text content from the producing node.", "Test with overwrite disabled and inspect the returned path and byte count."],
    },
    behavior: ["The output contains the written trusted path and byte count.", "createParents affects only missing parent directories; overwrite separately controls replacement of the target file."],
    commonIssues: ["The node fails if the file exists and overwrite is false.", "Validate generated content before writing it to a path consumed by another process."],
    related: [{ label: "Files and folders", href: "/files-and-data/files-and-folders" }, { label: "Permissions", href: "/workflows/permissions" }],
  },
  copy_path: {
    useCases: ["Create a backup before a destructive or mutating step.", "Copy a file or folder between approved local boundaries."],
    example: {
      title: "Back up a configuration folder",
      description: "Copy a reviewed source folder into a dated backup destination.",
      configuration: { source: "C:\\Automation\\config", destination: "C:\\Automation\\backups\\config-latest", overwrite: false },
      flow: ["Approve the source and destination boundaries.", "Leave overwrite disabled for the first run.", "Inspect the destination and copied entry count before relying on the backup."],
    },
    behavior: ["Files and folders are supported, and the output identifies source, destination, and copied entry count.", "Replacement is rejected unless overwrite is explicitly enabled."],
    commonIssues: ["Copying a folder into itself or a descendant is invalid.", "Large directory trees can take time and produce many filesystem operations."],
    related: [{ label: "Files and folders", href: "/files-and-data/files-and-folders" }, { label: "Delete File or Folder", href: "/nodes/delete-path" }],
  },
  delete_path: {
    useCases: ["Remove a temporary artifact after the workflow has verified its durable destination.", "Clean an approved staging folder with explicit review."],
    example: {
      title: "Remove a processed temporary file",
      description: "Delete one mapped file after a successful upload, without allowing recursive folder deletion.",
      configuration: { path: "{{nodes.download.output.path}}", recursive: false },
      flow: ["Map a trusted path from the node that created the file.", "Keep recursive disabled for a single-file cleanup.", "Place deletion after every step that still needs the artifact."],
    },
    behavior: ["The path must remain inside an approved filesystem boundary.", "recursive authorizes non-empty directory removal and materially expands the operation."],
    commonIssues: ["Test runs ask for destructive-action confirmation.", "Deletion is not an archive; move the artifact instead if recovery might be needed."],
    related: [{ label: "Files and folders", href: "/files-and-data/files-and-folders" }, { label: "Permissions", href: "/workflows/permissions" }],
  },
  list_folder: {
    useCases: ["Discover files for a batch workflow.", "Count or filter entries before deciding whether to continue."],
    example: {
      title: "List pending CSV files",
      description: "List matching CSV files in one approved folder without descending into subfolders.",
      configuration: { folder: "C:\\Reports\\Inbox", recursive: false, pattern: "*.csv" },
      flow: ["Select the folder through the picker.", "Use the narrowest pattern that represents eligible files.", "Map count to Condition or entries to Code for iteration and selection."],
    },
    behavior: ["The output contains an entries array and total count.", "recursive changes the search boundary to include nested folders but does not grant access outside the approved root."],
    commonIssues: ["Pattern matching applies to names; verify behavior with representative nested paths.", "A very broad recursive listing can create a large execution payload."],
    related: [{ label: "Files and folders", href: "/files-and-data/files-and-folders" }, { label: "Data types", href: "/reference/data-types" }],
  },
  parse_csv: {
    useCases: ["Turn CSV text into rows that can be counted, filtered, or mapped.", "Parse a downloaded or watched file while preserving its header names."],
    example: {
      title: "Parse a downloaded report",
      description: "Map Download File's trusted path, use the first row as headers, and trim surrounding whitespace.",
      configuration: { path: "{{nodes.download.output.path}}", content: "", delimiter: ",", hasHeaders: true, trim: true },
      flow: ["Map either path or content; mapped content wins when both are present.", "Confirm the delimiter and header setting against a real sample.", "Inspect headers, rows, and rowCount before mapping nested values."],
    },
    behavior: ["With headers enabled, each row is keyed by its header; otherwise rows follow positional columns.", "The output reports headers, parsed rows, and rowCount."],
    commonIssues: ["A semicolon- or tab-delimited export will not split correctly with the comma default.", "Quoted fields and embedded newlines should be tested with a representative file before publishing."],
    related: [{ label: "CSV data", href: "/files-and-data/csv" }, { label: "Variables and data mapping", href: "/workflows/variables-and-data" }],
  },
  parse_json: {
    useCases: ["Convert API, file, or text output into a typed object or array.", "Validate that a text payload is well-formed JSON before downstream mapping."],
    example: {
      title: "Parse an API payload saved as text",
      description: "Map the text into content and leave path empty.",
      configuration: { path: "", content: "{\"service\":\"checkout\",\"healthy\":true}" },
      flow: ["Choose content for in-memory text or path for an approved file.", "Test with the actual payload.", "Select nested values from the value output in later mapping controls."],
    },
    behavior: ["Objects, arrays, strings, numbers, booleans, and null are all valid JSON roots.", "When both inputs are supplied, content takes precedence over path."],
    commonIssues: ["JavaScript object syntax is not JSON: property names and strings require double quotes.", "A successful HTTP Request may already return structured body data and need no Parse JSON step."],
    related: [{ label: "JSON data", href: "/files-and-data/json" }, { label: "Data types", href: "/reference/data-types" }],
  },
  parse_text: {
    useCases: ["Normalize a text file into a line array.", "Count lines or remove blank records before further processing."],
    example: {
      title: "Prepare a line-oriented queue",
      description: "Parse pasted or mapped text, trim it, and omit empty lines.",
      configuration: { path: "", content: "first\n\nsecond", trim: true, removeEmptyLines: true },
      flow: ["Map content from Read File or another text-producing node.", "Choose whether surrounding whitespace and empty lines are meaningful.", "Use lines and lineCount in Condition or Code."],
    },
    behavior: ["The output preserves normalized text and also provides lines, lineCount, and characterCount.", "Mapped content takes precedence over an optional file path."],
    commonIssues: ["Removing empty lines changes positional meaning in formats where blank lines are significant.", "Parsing creates structure; it does not interpret CSV quoting or JSON syntax."],
    related: [{ label: "Files and data overview", href: "/files-and-data/overview" }, { label: "Code node", href: "/nodes/code" }],
  },
  get_workflow_state: {
    useCases: ["Read a checkpoint, cursor, last-seen value, or preference saved by this workflow.", "Provide a default for the first run without confusing a missing key with stored null."],
    example: {
      title: "Read the last processed cursor",
      description: "Return zero on the first run and the stored cursor on later runs.",
      configuration: { key: "last-cursor", defaultValue: 0 },
      flow: ["Choose a stable, workflow-specific key.", "Branch on found if stored null and missing must differ.", "Map value into the request or comparison that needs the checkpoint."],
    },
    behavior: ["The output includes value and a separate found boolean.", "Node tests can read committed state but do not commit state changes produced elsewhere in the test."],
    commonIssues: ["State belongs to one workflow; copying a node to another workflow does not copy its stored value.", "Use an explicit default whose type matches what downstream nodes expect."],
    related: [{ label: "Workflow state", href: "/files-and-data/workflow-state" }, { label: "Data types", href: "/reference/data-types" }],
  },
  set_workflow_state: {
    useCases: ["Persist a cursor, last successful timestamp, or small JSON-compatible checkpoint.", "Make the next execution aware of work completed by the current one."],
    example: {
      title: "Commit the latest API cursor",
      description: "Store a mapped response cursor only after the entire workflow succeeds.",
      configuration: { key: "last-cursor", value: "{{nodes.request.output.body.nextCursor}}" },
      flow: ["Use a stable key.", "Map the new value from a successful upstream node.", "Place the node in the successful path and verify the whole run completes."],
    },
    behavior: ["The write is staged during execution and committed only after the workflow succeeds.", "A failed or cancelled run leaves the previous committed value intact."],
    commonIssues: ["A successful node test previews the state update but deliberately does not commit it.", "Workflow state is for small checkpoints, not secrets, files, or an unbounded event archive."],
    related: [{ label: "Workflow state", href: "/files-and-data/workflow-state" }, { label: "Retries and recovery", href: "/execution/retries-and-recovery" }],
  },
  compare_previous: {
    useCases: ["Notify only when a polled value changes.", "Compare normalized text while remembering the latest successful observation."],
    example: {
      title: "Detect a changed page heading",
      description: "Compare mapped page text after collapsing whitespace.",
      configuration: { key: "homepage-heading", value: "{{nodes.extract.output.value}}", normalization: "collapse_whitespace" },
      flow: ["Map the current value and choose a durable key.", "Connect changed to a Condition node.", "Send notifications only from the true branch."],
    },
    behavior: ["The first observation is reported separately and is not considered a change.", "The current value is staged for commit only after the complete workflow succeeds."],
    commonIssues: ["Choose none when whitespace or capitalization is semantically important.", "Reusing one key for unrelated values makes comparisons misleading."],
    related: [{ label: "Workflow state", href: "/files-and-data/workflow-state" }, { label: "Branches and conditions", href: "/workflows/branches-and-conditions" }],
  },
  run_command: {
    useCases: ["Invoke a reviewed local program that has no dedicated node.", "Pass a structured argument list to a script and capture its exit result."],
    example: {
      title: "Run a checked reporting script",
      description: "Invoke Python directly with separate arguments instead of constructing a shell command.",
      configuration: { executable: "C:\\Python313\\python.exe", arguments: ["C:\\Automation\\report.py", "--format", "json"], workingDirectory: "C:\\Automation" },
      flow: ["Select the exact executable and approved working directory.", "Put every flag and value in its own arguments item.", "Check exitCode before parsing stdout."],
    },
    behavior: ["sndbox starts the executable directly; it does not concatenate arguments into a shell command.", "The output captures exitCode and the first 64 KiB each of stdout and stderr."],
    commonIssues: ["Executables available in an interactive shell may not be on the desktop app's PATH; prefer an explicit path.", "The current runner stops the child on cancellation but does not enforce the stored timeoutMs value. Ensure the program has its own bound and do not rely on this field until runtime enforcement is added."],
    related: [{ label: "Permissions", href: "/workflows/permissions" }, { label: "Logs and evidence", href: "/execution/logs-and-evidence" }],
  },
  ai_prompt: {
    useCases: ["Classify, summarize, extract, or draft from mapped workflow data.", "Turn unstructured text into a concise result before a human review step."],
    example: {
      title: "Summarize a support email",
      description: "Map the email body into a focused prompt and ask for a short draftable summary.",
      configuration: { connectionId: "ai-work", prompt: "Summarize the customer request and list required follow-up:\n{{trigger.email.body}}", systemPrompt: "You are a support triage assistant. Do not invent facts.", temperature: 0.2, maxTokens: 500, timeoutMs: 90000 },
      flow: ["Choose a connection whose provider and data policy are appropriate.", "Map only the context needed for the task.", "Review response before using it in communication or another side effect."],
    },
    behavior: ["The local runner waits for the provider and returns response text, provider-reported usage, and model ID.", "Prompt, system instruction, and mapped context leave sndbox for the selected provider; the credential remains in the host vault."],
    commonIssues: ["Model output is untrusted data: validate structure and preserve human review for consequential actions.", "Reduce prompt size or raise the timeout within limits when requests consistently time out."],
    related: [{ label: "AI connections", href: "/connections/ai" }, { label: "AI Builder", href: "/workflows/ai-builder" }],
  },
  code: {
    useCases: ["Transform data when built-in mapping and parser nodes are not enough.", "Author reusable HTML, JavaScript, or CSS source for Web Builder."],
    example: {
      title: "Transform mapped JSON with JavaScript",
      description: "Run JavaScript locally, reading the mapped value from SNDBOX_INPUT and printing a JSON result.",
      configuration: { language: "javascript", sourceCode: "const input = JSON.parse(process.env.SNDBOX_INPUT ?? \"null\");\nconsole.log(JSON.stringify({ count: input.rows.length }));", executionMode: "run", timeoutMs: 30000 },
      flow: ["Map the source value to input.", "Run in the full editor and resolve diagnostics.", "Inspect result, stdout, and exit behavior before connecting downstream nodes."],
    },
    behavior: ["Source mode returns the file without executing it; HTML and CSS always use source mode.", "Run mode invokes the installed node or python executable and requires command-execution approval."],
    commonIssues: ["SNDBOX_INPUT is a JSON string, so parse it before treating it as an object.", "Keep secrets out of source and stdout because both can appear in workflow or execution records."],
    related: [{ label: "Code and Web Builder", href: "/files-and-data/code-and-web-builder" }, { label: "Permissions", href: "/workflows/permissions" }],
  },
  web_builder: {
    useCases: ["Preview a small local interface assembled from separate HTML, JavaScript, and CSS nodes.", "Build a localhost dashboard for workflow output without deploying a public site."],
    example: {
      title: "Serve a local status dashboard",
      description: "Map source from three Code nodes and let sndbox choose an available loopback port.",
      configuration: { html: "{{nodes.html.output.code}}", javascript: "{{nodes.javascript.output.code}}", css: "{{nodes.css.output.code}}", port: 0, openBrowser: true },
      flow: ["Create HTML, JavaScript, and CSS Code nodes in source mode.", "Connect and map each code output to the matching Web Builder input.", "Run locally and use the returned URL while sndbox remains open."],
    },
    behavior: ["The server binds to 127.0.0.1 only; port 0 selects an available port.", "Rerunning the same Web Builder node replaces its previous server, and combined source is limited to 4 MB."],
    commonIssues: ["All three source inputs are required even when JavaScript or CSS is intentionally empty.", "The returned URL is local to the runner and is not a deployment or remotely reachable preview."],
    related: [{ label: "Code and Web Builder", href: "/files-and-data/code-and-web-builder" }, { label: "Local runner", href: "/execution/local-runner" }],
  },
  open_browser: {
    useCases: ["Start the managed session required by downstream browser actions.", "Reuse an isolated profile for sites that need persisted sign-in state."],
    example: {
      title: "Open a headless reporting session",
      description: "Use a prepared profile, a 1280 by 800 viewport, and a ten-minute session cap.",
      configuration: { profileId: "reporting-profile", headed: false, initialUrl: "https://portal.example.com", viewport: { width: 1280, height: 800 }, defaultTimeoutMs: 30000, closeAutomatically: true, keepOpenAfterManualTest: false, maximumDurationMs: 600000 },
      flow: ["Create and test an isolated profile in Settings.", "Place Open Browser upstream of every browser action.", "Leave automatic cleanup enabled for scheduled and failure paths."],
    },
    behavior: ["The node establishes session context used by downstream browser nodes in the same control path.", "Manual runs can be headed, while scheduled runs default to headless behavior."],
    commonIssues: ["A profile already locked by another browser process may not open.", "Keeping sessions open after tests is useful for debugging but can leave state that makes later tests unrepresentative."],
    related: [{ label: "Profiles and sessions", href: "/browser-automation/profiles-and-sessions" }, { label: "Browser troubleshooting", href: "/browser-automation/troubleshooting" }],
  },
  navigate: {
    useCases: ["Load the next page in an active managed browser session.", "Wait for an initial page milestone before interaction begins."],
    example: {
      title: "Open a report page",
      description: "Navigate to the portal and wait until the DOM is ready, with a 30-second bound.",
      configuration: { url: "https://portal.example.com/reports", waitCondition: "dom_ready", timeoutMs: 30000 },
      flow: ["Connect from Open Browser or another action in the same session path.", "Choose the weakest readiness condition that is sufficient.", "Add Wait For when a specific dynamic control must become available."],
    },
    behavior: ["The URL must be inside the workflow's approved network boundary.", "dom_ready, page_loaded, network_idle, and element_visible describe different milestones and can complete at different times."],
    commonIssues: ["network_idle may never arrive on pages with analytics, streaming, or polling.", "A successful navigation does not guarantee that a later dynamic element is ready."],
    related: [{ label: "Navigation and waits", href: "/browser-automation/navigation-and-waits" }, { label: "Wait For", href: "/nodes/wait-for" }],
  },
  click_element: {
    useCases: ["Activate a recorded button, link, menu item, or other interactive target.", "Use double, right, or modified clicks when the application requires them."],
    example: {
      title: "Open the reports view",
      description: "Record the Open reports button, use a normal left click, and allow a short transition delay.",
      configuration: { locator: { primary: { kind: "role", value: "button", name: "Open reports" }, alternatives: [] }, clickType: "normal", mouseButton: "left", modifiers: [], waitAfterMs: 500, timeoutMs: 30000 },
      flow: ["Record the target in a representative page state.", "Test the locator and confirm it matches exactly one element.", "Follow with Wait For or Navigate readiness when the click starts asynchronous work."],
    },
    behavior: ["sndbox tries the recorded accessible locator and retained fallbacks, recording every attempt in browser diagnostics.", "waitAfterMs is a fixed post-click pause, not a proof that the expected result occurred."],
    commonIssues: ["If zero or several elements match, rerecord with a stable accessible name or test ID.", "Avoid weak text or positional CSS selectors when the page offers a role, label, or stable test ID."],
    related: [{ label: "Locators", href: "/browser-automation/locators" }, { label: "Navigation and waits", href: "/browser-automation/navigation-and-waits" }],
  },
  fill_field: {
    useCases: ["Enter mapped text into a recorded form control.", "Resolve a protected value at runtime and keep it redacted from evidence."],
    example: {
      title: "Fill a protected password",
      description: "Record the password field, map a protected variable to value, clear old content, and mark the input sensitive.",
      configuration: { locator: { primary: { kind: "label", value: "Password", name: "Password" }, alternatives: [] }, value: "", clearExisting: true, inputDelayMs: 0, sensitive: true, timeoutMs: 30000 },
      flow: ["Record the field by label or accessible role.", "Map the protected variable instead of storing literal secret text.", "Test that logs show redaction and that the page accepted the value."],
    },
    behavior: ["clearExisting replaces current content; otherwise input is appended using the browser's field behavior.", "sensitive marks the resolved value for redaction but does not change the destination website's handling of it."],
    commonIssues: ["A sensitive field with no protected mapping is intentionally incomplete.", "Framework-controlled inputs can reformat values; verify the resulting page state instead of assuming keystrokes were accepted."],
    related: [{ label: "Forms and uploads", href: "/browser-automation/forms-and-uploads" }, { label: "Secrets and connections", href: "/files-and-data/secrets-and-connections" }],
  },
  select_option: {
    useCases: ["Choose one option from a native select control.", "Select by stable submitted value, visible label, or zero-based index."],
    example: {
      title: "Choose a report format",
      description: "Record the Format select and choose its visible CSV label.",
      configuration: { locator: { primary: { kind: "label", value: "Format", name: "Format" }, alternatives: [] }, selectBy: "label", option: "CSV", timeoutMs: 30000 },
      flow: ["Record the select element itself.", "Prefer value when the submitted value is stable; use label when it is the clearest contract.", "Verify the page reflects the selected option before continuing."],
    },
    behavior: ["index is zero-based and can be brittle when options are reordered.", "The locator must resolve to a compatible select control."],
    commonIssues: ["A custom dropdown built from div elements may require Click Element steps instead of Select Option.", "Labels can be localized while values remain stable; choose the matching strategy deliberately."],
    related: [{ label: "Forms and uploads", href: "/browser-automation/forms-and-uploads" }, { label: "Locators", href: "/browser-automation/locators" }],
  },
  press_key: {
    useCases: ["Submit a form with Enter, dismiss a dialog with Escape, or use a supported shortcut.", "Trigger keyboard behavior when clicking is not equivalent."],
    example: {
      title: "Submit search with Enter",
      description: "Run Press Key immediately after filling the focused search field.",
      configuration: { key: "Enter", timeoutMs: 30000 },
      flow: ["Ensure the preceding action leaves focus on the intended control.", "Enter a validated key or key combination.", "Wait for the resulting navigation or element state."],
    },
    behavior: ["The key is sent to the active page using the current focus context.", "The timeout bounds dispatch and browser response, not all work started by the shortcut."],
    commonIssues: ["If focus moved, the page or wrong control may receive the key.", "Operating-system shortcuts and application-level browser shortcuts are not the same as page keyboard input."],
    related: [{ label: "Forms and uploads", href: "/browser-automation/forms-and-uploads" }, { label: "Navigation and waits", href: "/browser-automation/navigation-and-waits" }],
  },
  wait_for: {
    useCases: ["Synchronize with a dynamic element, text, URL, response, download, or page load state.", "Replace fragile fixed delays with a bounded observable condition."],
    example: {
      title: "Wait for an export to become ready",
      description: "Wait up to 60 seconds for the recorded Download report button to become visible.",
      configuration: { waitFor: "element_visible", locator: { primary: { kind: "role", value: "button", name: "Download report" }, alternatives: [] }, delayMs: 1000, timeoutMs: 60000 },
      flow: ["Choose the event that actually proves readiness.", "Record a locator or provide the conditional URL/text fields.", "Keep a finite timeout and inspect diagnostics when it expires."],
    },
    behavior: ["time uses delayMs; element modes use the locator; URL, network, and load-state modes expose their corresponding fields.", "Completion means the selected condition was observed, not that every background task on the page finished."],
    commonIssues: ["network_idle is unsuitable for pages with continuous network activity.", "A text condition can match hidden or repeated content differently than an element visibility check."],
    related: [{ label: "Navigation and waits", href: "/browser-automation/navigation-and-waits" }, { label: "Browser troubleshooting", href: "/browser-automation/troubleshooting" }],
  },
  extract_data: {
    useCases: ["Read text, an attribute, a link, an image URL, or tabular data from a page.", "Turn one or many matched elements into structured workflow data."],
    example: {
      title: "Extract all visible product names",
      description: "Record a representative product heading and return all unique matches under the field name products.",
      configuration: { locator: { primary: { kind: "css", value: "[data-testid='product-name']" }, alternatives: [] }, extract: "text", fieldName: "products", repeated: true, fields: {}, timeoutMs: 30000 },
      flow: ["Record the narrowest stable repeated target.", "Choose the extraction kind and a descriptive field name.", "Test against empty, single-result, and multi-result pages."],
    },
    behavior: ["repeated returns a list of unique matches; otherwise the node expects a single resolved value.", "Attribute extraction additionally requires the attribute name, while table extraction uses the fields mapping."],
    commonIssues: ["A locator that matches layout containers can return whitespace or duplicate text.", "Extracted page content is untrusted external data; validate it before commands, paths, or outbound messages."],
    related: [{ label: "Locators", href: "/browser-automation/locators" }, { label: "Data types", href: "/reference/data-types" }],
  },
  screenshot: {
    useCases: ["Capture visual evidence at an important checkpoint.", "Record a viewport, full page, or one selected element for debugging."],
    example: {
      title: "Capture a full report page",
      description: "Save a full-page image in execution history with a 10 MiB limit.",
      configuration: { mode: "full_page", includeInHistory: true, maximumBytes: 10485760, timeoutMs: 30000 },
      flow: ["Place Screenshot after the page state you want to prove.", "Choose the smallest capture area that contains the needed evidence.", "Inspect privacy-sensitive content before enabling retained history artifacts."],
    },
    behavior: ["The output is a trusted screenshot path; history attachment is controlled separately by includeInHistory.", "Element mode requires a recorded locator and all modes enforce maximumBytes."],
    commonIssues: ["Full-page images can exceed the size limit on long pages.", "Screenshots can capture personal data or secrets visible in the page even when text logs are redacted."],
    related: [{ label: "Screenshots", href: "/browser-automation/screenshots" }, { label: "Logs and evidence", href: "/execution/logs-and-evidence" }],
  },
  download_file: {
    useCases: ["Click a recorded download control and save the resulting file inside an approved folder.", "Create a trusted path that later file and parser nodes can consume."],
    example: {
      title: "Download a daily CSV report",
      description: "Save the report with a stable filename, renaming automatically if it already exists.",
      configuration: { locator: { primary: { kind: "role", value: "button", name: "Download report" }, alternatives: [] }, destinationFolder: "C:\\Reports\\Daily", filename: "daily-report.csv", collisionBehaviour: "rename", maximumBytes: 104857600, timeoutMs: 60000 },
      flow: ["Record the control that starts the download.", "Select an approved destination and choose collision behavior.", "Map the returned path into Parse CSV or another file node."],
    },
    behavior: ["The node coordinates the click and browser download event, then returns path and byte count.", "rename preserves an existing file, overwrite replaces it, and fail stops on a collision."],
    commonIssues: ["Use Wait For download_begins only when a separate action starts the download; Download File already owns its click.", "A response larger than maximumBytes is rejected rather than partially trusted."],
    related: [{ label: "Downloads", href: "/browser-automation/downloads" }, { label: "Files and folders", href: "/files-and-data/files-and-folders" }],
  },
  upload_file: {
    useCases: ["Attach an approved local file to a recorded file input.", "Pass a trusted path from an earlier download or file node into a web form."],
    example: {
      title: "Upload a generated report",
      description: "Record the file input and map Write File's trusted path into file.",
      configuration: { locator: { primary: { kind: "label", value: "Upload report", name: "Upload report" }, alternatives: [] }, file: "{{nodes.write.output.path}}", timeoutMs: 30000 },
      flow: ["Record the actual file input or its associated label.", "Select a local file or map a trusted path output.", "Wait for the page's upload-complete state before submitting."],
    },
    behavior: ["The host validates the file boundary before handing the path to the managed browser.", "Selecting a file does not necessarily wait for the website's server-side processing."],
    commonIssues: ["A plain path string without trusted provenance may be rejected.", "Custom drag-and-drop upload widgets may require recording their underlying file input."],
    related: [{ label: "Forms and uploads", href: "/browser-automation/forms-and-uploads" }, { label: "Files and folders", href: "/files-and-data/files-and-folders" }],
  },
  close_browser: {
    useCases: ["Release a managed session before a long non-browser tail of the workflow.", "Make the intended browser lifecycle explicit in the graph."],
    example: {
      title: "Close after capturing evidence",
      description: "Place Close Browser after the final Screenshot or Download File node.",
      flow: ["Connect it in the same control path as Open Browser.", "Ensure no later node needs the session.", "Keep Open Browser's automatic cleanup enabled as a failure-path fallback."],
    },
    behavior: ["The active managed session is closed and cannot be used by later browser actions.", "Workflow-end cleanup still handles remaining sessions when automatic cleanup is enabled."],
    commonIssues: ["A browser node after Close Browser fails because its session context is gone.", "Close Browser is useful for clarity, but it should not be the only cleanup protection."],
    related: [{ label: "Profiles and sessions", href: "/browser-automation/profiles-and-sessions" }, { label: "Browser overview", href: "/browser-automation/overview" }],
  },
  gmail_get_email: {
    useCases: ["Retrieve full message details after receiving an ID from a trigger or prior result.", "Fetch content only on the branch that actually needs it."],
    example: {
      title: "Load a triggered message",
      description: "Use the same Gmail connection as New Email and map the trigger's message ID.",
      configuration: { credentialId: "gmail-support", messageId: "{{trigger.email.messageId}}" },
      flow: ["Select the Gmail connection.", "Map a message or thread ID from the trigger.", "Inspect the returned shape before mapping body, headers, or attachments."],
    },
    behavior: ["The secure integration host resolves the credential and returns message data without exposing token material.", "Reading is distinct from drafting, sending, or changing labels."],
    commonIssues: ["A thread ID and message ID are not interchangeable in every provider operation.", "Fetched email content can contain sensitive or hostile text; treat it as untrusted input."],
    related: [{ label: "Gmail connection", href: "/connections/gmail" }, { label: "Secrets and connections", href: "/files-and-data/secrets-and-connections" }],
  },
  gmail_create_draft: {
    useCases: ["Prepare an email for human review without sending it.", "Make an AI- or data-generated response visible in Gmail before delivery."],
    example: {
      title: "Create a reviewed support reply",
      description: "Map the sender, subject, and generated response into a draft on the original thread.",
      configuration: { credentialId: "gmail-support", to: "{{trigger.email.from}}", cc: "", bcc: "", subject: "Re: {{trigger.email.subject}}", body: "{{nodes.ai.output.response}}", htmlBody: "", replyToMessage: "{{trigger.email.messageId}}" },
      flow: ["Map and validate at least one recipient.", "Use replyToMessage when the draft belongs on an existing thread.", "Open Gmail and review recipients and content before sending."],
    },
    behavior: ["Creating a draft changes mailbox state but does not transmit the message to recipients.", "The connection is resolved by the secure integration host and requires external communication permission."],
    commonIssues: ["When both body and htmlBody are used, verify they communicate the same content.", "Generated recipients and content still need validation even though the action only creates a draft."],
    related: [{ label: "Gmail connection", href: "/connections/gmail" }, { label: "Permissions", href: "/workflows/permissions" }],
  },
  gmail_send_email: {
    useCases: ["Send an approved transactional or notification email from a connected Gmail account.", "Continue an existing thread after recipient logic has been reviewed."],
    example: {
      title: "Send an approved report",
      description: "Send a mapped summary and approved attachment to a fixed recipient.",
      configuration: { credentialId: "gmail-reports", to: "ops@example.com", cc: "", bcc: "", subject: "Daily report", body: "{{nodes.ai.output.response}}", htmlBody: "", replyToMessage: "", attachments: ["{{nodes.write.output.path}}"] },
      flow: ["Keep recipient logic narrow and visible.", "Put a Manual Approval node before Send Email for run-time review when appropriate.", "Publish and approve the exact workflow revision before automatic use."],
    },
    behavior: ["The node performs an external communication side effect and requires both general communication permission and revision-bound send approval.", "Attachments must resolve to approved paths."],
    commonIssues: ["Changing recipient logic or other material workflow behavior revokes approval.", "Retries can duplicate mail unless the surrounding workflow has a deduplication strategy."],
    related: [{ label: "Gmail connection", href: "/connections/gmail" }, { label: "Approvals and publishing", href: "/cloud/approvals-and-publishing" }],
  },
  gmail_add_label: {
    useCases: ["Mark a processed message or move it through a label-based triage system.", "Add and remove several Gmail labels in one reviewed action."],
    example: {
      title: "Mark a message as processed",
      description: "Map the triggered message ID, add the Processed label ID, and remove the Inbox label ID.",
      configuration: { credentialId: "gmail-support", messageId: "{{trigger.email.messageId}}", addLabelIds: ["Label_Processed"], removeLabelIds: ["INBOX"] },
      flow: ["Use label IDs from Gmail rather than display names when required.", "Map the exact message ID.", "Run label changes after every earlier step whose failure should leave the message unprocessed."],
    },
    behavior: ["Adds and removals are submitted through the secure Gmail integration and mutate mailbox state.", "An empty add or remove list is allowed, but at least one intended change makes the node useful."],
    commonIssues: ["Display names can differ from provider label IDs.", "If a run fails after labeling, decide whether the workflow needs a compensating label change."],
    related: [{ label: "Gmail connection", href: "/connections/gmail" }, { label: "Retries and recovery", href: "/execution/retries-and-recovery" }],
  },
  discord_webhook: {
    useCases: ["Send a concise alert to a Discord channel through a stored webhook.", "Post mapped workflow results without placing the webhook URL in workflow data."],
    example: {
      title: "Post a service alert",
      description: "Send a mapped HTTP status with a recognizable bot name.",
      configuration: { credentialId: "discord-ops", content: "Checkout health returned {{nodes.request.output.status}}.", username: "sndbox monitor", avatarUrl: "" },
      flow: ["Create the Discord webhook connection.", "Map concise, non-sensitive content.", "Branch so alerts are posted only for the intended condition."],
    },
    behavior: ["The webhook URL remains in the host vault; the node sends content through the secure integration host.", "username and avatarUrl override presentation only for this message when Discord permits it."],
    commonIssues: ["Discord rate limits and content limits still apply.", "Avoid posting secrets or raw customer data to a broad channel."],
    related: [{ label: "Discord connection", href: "/connections/discord" }, { label: "Permissions", href: "/workflows/permissions" }],
  },
  discord_embed: {
    useCases: ["Post a structured Discord alert with a title, fields, color, and optional link or image.", "Make monitoring results easier to scan than a plain webhook message."],
    example: {
      title: "Post a structured deployment result",
      description: "Send a green embed with the deployment status and revision.",
      configuration: { credentialId: "discord-ops", content: "", title: "Deployment complete", description: "Production deployment succeeded.", fields: [{ name: "Revision", value: "{{trigger.revision}}", inline: true }], color: 5793266, link: "https://example.com/deployments", image: "" },
      flow: ["Use a decimal color value and short field names.", "Map only fields suitable for the destination channel.", "Test rendering with realistic lengths."],
    },
    behavior: ["description supplies the required embed content; content can add surrounding plain text.", "The webhook credential remains in the vault and sending requires communication permission."],
    commonIssues: ["Discord enforces per-field and total embed limits.", "Remote image URLs disclose a fetch to their host and may fail if not publicly accessible."],
    related: [{ label: "Discord connection", href: "/connections/discord" }, { label: "Limits", href: "/reference/limits" }],
  },
  slack_webhook: {
    useCases: ["Post a plain alert or status update to a Slack incoming webhook.", "Send mapped workflow results while keeping the webhook secret out of the graph."],
    example: {
      title: "Notify the operations channel",
      description: "Post a mapped status only from the failure branch of a health check.",
      configuration: { credentialId: "slack-ops", content: "Health check failed with status {{nodes.request.output.status}}." },
      flow: ["Create a Slack webhook connection.", "Connect the node only to the branch that should communicate.", "Keep the message concise and link to non-sensitive evidence when needed."],
    },
    behavior: ["The incoming webhook URL is resolved inside the host and never becomes workflow data.", "Sending is an external communication side effect governed by workflow permission review."],
    commonIssues: ["Webhook destinations are fixed by their Slack configuration; confirm the selected connection points to the intended workspace and channel.", "Rate limits or a revoked webhook cause a node failure that should not be retried without bounds."],
    related: [{ label: "Slack connection", href: "/connections/slack" }, { label: "Permissions", href: "/workflows/permissions" }],
  },
  approval: {
    useCases: ["Pause before sending, deleting, publishing, or performing another consequential action.", "Show the operator a resolved preview and attachments at the moment of decision."],
    example: {
      title: "Approve an outbound email",
      description: "Present the recipient, subject, and message preview, then continue to Send Email only after approval.",
      configuration: { proposedAction: "Send the prepared customer reply", recipient: "{{nodes.compose.output.to}}", subject: "{{nodes.compose.output.subject}}", messagePreview: "{{nodes.compose.output.body}}", attachments: [], expiresInMinutes: 60 },
      flow: ["Place Manual Approval directly before the guarded action.", "Map enough resolved context for an informed decision.", "Handle rejection or expiry as an expected failed outcome in operations."],
    },
    behavior: ["The execution pauses locally and appears in Pending approvals and the system tray.", "Approval, rejection, cancellation, and expiry are recorded against this execution; approval does not silently broaden workflow permissions."],
    commonIssues: ["Closing or disconnecting the local app can prevent a reviewer from acting before expiry.", "Do not use vague proposedAction text: the reviewer should know exactly what changes and where."],
    related: [{ label: "Approvals and publishing", href: "/cloud/approvals-and-publishing" }, { label: "Permissions", href: "/workflows/permissions" }],
  },
};

function slug(type: string): string {
  return type.replaceAll("_", "-").replaceAll(".", "-");
}

function titleCase(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ").replace(/^./, character => character.toUpperCase());
}

function typeOf(value: unknown, name: string): string {
  if (name === "locator") return "locator";
  if (["path", "folder", "source", "destination", "destinationFolder", "workingDirectory", "file"].includes(name)) return "path";
  if (value === null || value === undefined) return "any";
  if (Array.isArray(value)) return "array";
  return typeof value === "object" ? "object" : typeof value;
}

function fieldRows(node: NodeDefinition): string {
  const byName = new Map<string, FieldOverride>();
  for (const name of Object.keys(node.defaults)) byName.set(name, { name });
  for (const extra of extras[node.type] ?? []) byName.set(extra.name, { ...byName.get(extra.name), ...extra });
  if (node.type === "navigate" && !byName.has("timeoutMs")) byName.set("timeoutMs", { name: "timeoutMs" });
  const rows = [...byName.values()].map(field => {
    const value = node.defaults[field.name];
    const defaultValue = Object.prototype.hasOwnProperty.call(node.defaults, field.name) ? `\`${compact(value)}\`` : "—";
    const values = field.options ?? options[`${node.type}.${field.name}`];
    const details = [field.description ?? nodeFieldDescriptions[`${node.type}.${field.name}`] ?? fieldDescriptions[field.name] ?? `Configuration value for ${titleCase(field.name)}.`, values ? `Values: ${values.map(item => `\`${item}\``).join(", ")}.` : "", field.shownWhen ? `Shown when ${field.shownWhen}.` : ""].filter(Boolean).join(" ");
    return `| \`${field.name}\` | ${field.type ?? typeOf(value, field.name)} | ${defaultValue} | ${details} |`;
  });
  return ["| Field | Type | Default | What it controls |", "| --- | --- | --- | --- |", ...rows].join("\n");
}

function compact(value: unknown): string {
  if (typeof value === "string") return value === "" ? '""' : JSON.stringify(value);
  return JSON.stringify(value);
}

function portRows(ports: NodeDefinition["inputs"] | NodeDefinition["outputs"]): string {
  if (ports.length === 0) return "This node has no typed ports in this direction.";
  return [
    "| Port | Type | Required | Description |",
    "| --- | --- | --- | --- |",
    ...ports.map(port => `| \`${port.key}\` | \`${port.type}\` | ${port.required ? "Yes" : "No"} | ${port.label} |`),
  ].join("\n");
}

function exampleNode(node: NodeDefinition): string {
  return JSON.stringify({ type: node.type, version: 1, configuration: node.defaults }, null, 2);
}

function guideFor(node:NodeDefinition):NodeGuide|undefined{
  if(node.type==="javascript_code"||node.type==="python_code")return nodeGuides.code;
  return nodeGuides[node.type];
}

function renderGuide(node: NodeDefinition): string {
  const guide = guideFor(node);
  if (!guide) throw new Error(`Missing documentation guidance for ${node.type}`);
  const serializedExample = JSON.stringify(guide.example.configuration ?? {});
  const exampleCaveats = [
    /(?:credentialId|connectionId|profileId)/.test(serializedExample) ? "Connection and profile IDs are illustrative; select the real resource in the inspector." : "",
    /(?:[Pp]ath|[Ff]older|[Ff]ile|[Dd]estination|[Ss]ource|workingDirectory)/.test(serializedExample) ? "Local paths must be selected, mapped from a trusted path, or covered by the runner's approved boundary." : "",
    serializedExample.includes('"locator"') ? "The locator is shortened for readability; use the recorder to create the complete structured locator bundle." : "",
  ].filter(Boolean);
  const exampleNote = ["This shows the important settings, not a complete exported node.", ...exampleCaveats].join(" ");
  const exampleConfiguration = guide.example.configuration
    ? `

\`\`\`json title="Example settings"
${JSON.stringify(guide.example.configuration, null, 2)}
\`\`\`

${exampleNote}
`
    : "";
  return `## When to use this node

${guide.useCases.map(item => `- ${item}`).join("\n")}

## Example: ${guide.example.title}

${guide.example.description}
${exampleConfiguration}

${guide.example.flow.map((item, index) => `${index + 1}. ${item}`).join("\n")}
`;
}

function renderBehavior(node: NodeDefinition): string {
  const guide = guideFor(node)!;
  const portSummary = node.type === "note"
    ? "This annotation has no output ports because it never participates in execution."
    : node.outputs.length
    ? `The editor catalogue declares ${node.outputs.map(port => `\`${port.key}\` (${port.type})`).join(", ")} for mapping. The execution inspector can contain additional evidence fields; inspect a real result before selecting nested paths from object or any outputs.`
    : "This node has no declared output ports; its value is in controlling when or how later work proceeds.";
  return `## Execution behavior

${guide.behavior.map(item => `- ${item}`).join("\n")}
- ${portSummary}

## Common issues

${guide.commonIssues.map(item => `- ${item}`).join("\n")}
`;
}

function renderRelated(node: NodeDefinition): string {
  return `## Related guides

${guideFor(node)!.related.map(item => `- [${item.label}](${item.href})`).join("\n")}`;
}

function renderNode(node: NodeDefinition): string {
  const notes = nodeNotes[node.type] ?? [];
  const annotation = node.type === "note";
  const placementNames: Record<string, string> = { local: "Desktop local runner", paired_runner: "Paired self-hosted runner", hosted_runner: "Hosted runner", managed_browser: "Managed browser worker" };
  const classification = annotation
    ? "Notes are non-executable canvas annotations and do not affect workflow behavior."
    : node.sideEffect
      ? "sndbox classifies this node as side-effecting, so tests or automatic runs can require additional confirmation and permission review."
      : "This node is not marked with the catalogue's generic side-effect flag. That classification is not a guarantee that every configured operation is read-only; review the concrete action and its destination.";
  const mappingGuidance = annotation
    ? "Note content is stored with the workflow for collaborators and is never treated as executable input."
    : "Values may be entered literally or mapped from an earlier compatible output when the inspector exposes a mapping control. See [Variables and data mapping](/workflows/variables-and-data).";
  const placementGuidance = annotation
    ? "Notes stay on the workflow canvas and are never dispatched to a desktop, paired, hosted, or browser runner."
    : node.placements.map(placement => `- ${placementNames[placement] ?? placement}`).join("\n");
  const inspectionGuidance = annotation
    ? "Edit the note directly on the canvas. It is saved with the workflow but does not appear as an executable step in run history."
    : "Use **Test node** in the editor to preview this step with the current configuration. A full run records resolved inputs, outputs, logs, duration, and any artifacts in the execution inspector. Side-effecting or destructive nodes can require an additional confirmation or approved workflow permission.";
  return `---
title: "${node.name}"
description: "${node.description}. Exact configuration, ports, placement, and execution behavior."
icon: "${categoryIcons[node.group] ?? "blocks"}"
---

**Node type:** \`${node.type}\` · **Version:** \`1\` · **Category:** ${node.group}

${node.description}. ${classification}

${renderGuide(node)}

## Configuration

${fieldRows(node)}

${notes.map(note => `<Note>${note}</Note>`).join("\n\n")}

## Workflow JSON

The editor stores this node with the following implemented default configuration:

\`\`\`json title="Default node configuration"
${exampleNode(node)}
\`\`\`

${mappingGuidance}

## Inputs

${portRows(node.inputs)}

## Outputs

${portRows(node.outputs)}

${renderBehavior(node)}

## Where it can run

${placementGuidance}

## Test and inspect

${inspectionGuidance}

${renderRelated(node)}
`;
}

function renderIndex(): string {
  const groups = categoryOrder.map(category => {
    const nodes = NODE_DEFINITIONS.filter(node => node.group === category);
    return `## ${category}\n\n${nodes.map(node => `<Card title="${node.name}" icon="${categoryIcons[category]}" href="/nodes/${slug(node.type)}">\n  ${node.description}.\n</Card>`).join("\n")}`;
  });
  return `---
title: "Built-in nodes"
description: "Every node currently implemented in sndbox, generated from the product catalogue."
icon: "blocks"
---

sndbox currently implements **${NODE_DEFINITIONS.length} built-in nodes** across triggers, logic, data, network, browser, communication, and system automation. These pages are generated from \`src/catalogue.ts\`; names, type IDs, defaults, typed ports, side-effect flags, and supported placements are not hand-copied.

<Tip>
  Start with a trigger, connect compatible ports, and map outputs into later node fields. The node inspector only shows settings implemented by that node.
</Tip>

## How nodes fit together

A workflow combines two separate kinds of connection:

| Connection | What it controls | Example |
| --- | --- | --- |
| Control edge | Which node runs next and, for Condition, which branch is followed | HTTP Request → Condition → true branch |
| Input binding | Which runtime value a field receives | Map HTTP Request's \`status\` output to Condition's \`left\` input |

Drawing an edge does not automatically map every output. Open the destination node and use its mapping control to select the exact source and path. A source must be upstream on the active control path, and its port type must be compatible with the destination.

## A reliable starting pattern

1. Add exactly one trigger and test it with the smallest useful event.
2. Add read-only nodes first, such as HTTP Request, Read File, or Extract Data.
3. Test and inspect their real output shapes before creating mappings.
4. Add Condition or validation steps before nodes that write, send, delete, or execute.
5. Review permissions, run the complete workflow, and inspect execution evidence.
6. Only then replace Manual Trigger with Schedule Trigger or another automatic trigger.

## Choose a category

| Need | Start here | Keep in mind |
| --- | --- | --- |
| Start work | Triggers | Local schedules and polling need an online runner. |
| Route or pause | Logic | Control branches are separate from data mappings. |
| Shape or remember values | Data | Workflow state commits only after full success. |
| Call an API | Network | Approve domains and design retries around idempotency. |
| Interact with a site | Browser | Open a managed session first and prefer recorded accessible locators. |
| Send or modify messages | Communication | Credentials stay in connections; mutations require permission review. |
| Change the local system | System | Keep filesystem and command boundaries narrow. |
| Explain the workflow | Notes | Notes document context but do not enforce behavior or execute. |

## Read a node page

Every reference page includes:

- concrete use cases and an end-to-end example;
- the exact implemented defaults and supported option values;
- typed input and output ports;
- runtime placement and side-effect status;
- behavior, failure guidance, and links to deeper concept guides.

The **Default node configuration** block is the exact generated storage shape. **Example settings** blocks focus on the fields relevant to the scenario and can contain illustrative IDs or shortened recorded locators.

<Warning>
  A node without the catalogue's generic side-effect flag is not automatically read-only. An HTTP mutation or browser click can still change an external system. Review the configured method, target, account, and downstream effect.
</Warning>

${groups.join("\n\n")}
`;
}

rmSync(nodesRoot, { recursive: true, force: true });
mkdirSync(nodesRoot, { recursive: true });
mkdirSync(apiRoot, { recursive: true });
writeFileSync(resolve(nodesRoot, "index.mdx"), renderIndex());
for (const node of NODE_DEFINITIONS) writeFileSync(resolve(nodesRoot, `${slug(node.type)}.mdx`), renderNode(node));
copyFileSync(resolve(repositoryRoot, "docs/api/openapi-v1.json"), resolve(apiRoot, "openapi.json"));
console.log(`Generated ${NODE_DEFINITIONS.length} Mintlify node pages and copied the OpenAPI document.`);
