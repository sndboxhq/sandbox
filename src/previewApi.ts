import type {
  BrowserProfile,
  BrowserProfileSettings,
  BugReportDraft,
  BugReportReceipt,
  ConnectionMetadata,
  ExecutionQuery,
  ExecutionRecord,
  NodeExecution,
  RunnerStatus,
  ValidationIssue,
  Workflow,
  WorkflowMetadata,
  WorkflowMetadataPatch,
  WorkflowRevisionSummary,
  WorkflowSummary,
} from "./types";
import { createAdditionalTemplateWorkflow } from "./workflowTemplates";

const KEY = "sandbox-preview-workflows";
const RUNS = "sandbox-preview-runs";
const META = "sandbox-preview-workflow-metadata";
const REVISIONS = "sandbox-preview-workflow-revisions-v1";
const RUNNER = "sandbox-preview-runner-paused";
const PROFILES = "sandbox-preview-profiles";
const CONNECTIONS = "sandbox-preview-connections";
const now = () => new Date().toISOString();
const defaultCollectionLimits = () => ({
  maxInputItems: 10_000,
  maxResultItems: 10_000,
  maxItemBytes: 1_048_576,
  maxAggregateBytes: 16_777_216,
  maxCartesianItems: 25_000,
  maxLoopIterations: 10_000,
  maxLoopConcurrency: 16,
  maxDeduplicationKeys: 50_000,
  maxHistoryItemPreviews: 100,
});
const blank = (template = "blank"): Workflow => {
  const id = crypto.randomUUID();
  const createdAt = now();
  const base = {
    id,
    schemaVersion: 6,
    description: "",
    enabled: false,
    settings: {
      defaultNodeTimeoutMs: 30000,
      maxConcurrentNodes: 4,
      expressionLanguageVersion: 1,
      collectionLimits: defaultCollectionLimits(),
      permissions: {
        approvedFolders: [],
        approvedNetworkDomains: [],
        approvedBrowserProfileIds: [],
        browserAutomationPermitted: false,
        externalCommunicationPermitted: false,
        commandExecutionPermitted: false,
        backgroundExecutionPermitted: false,
      },
    },
    createdAt,
    updatedAt: createdAt,
  };
  const additionalTemplate = createAdditionalTemplateWorkflow(template, base);
  if (additionalTemplate) return additionalTemplate;
  if (template === "website-change-monitor")
    return {
      ...base,
      name: "Website Change Monitor",
      triggerNodeId: "schedule",
      settings: {
        ...base.settings,
        permissions: {
          ...base.settings.permissions,
          approvedNetworkDomains: ["example.com"],
        },
      },
      nodes: [
        {
          id: "schedule",
          type: "schedule_trigger",
          version: 1,
          name: "Every 30 minutes",
          position: { x: 60, y: 220 },
          configuration: {
            scheduleType: "minutes",
            every: 30,
            time: "09:00",
            cron: "*/30 * * * *",
          },
          disabled: false,
        },
        {
          id: "browser",
          type: "open_browser",
          version: 1,
          name: "Open monitored browser",
          position: { x: 340, y: 220 },
          configuration: {
            profileId: "",
            headed: false,
            viewport: { width: 1280, height: 800 },
            closeAutomatically: true,
          },
          disabled: false,
        },
        {
          id: "navigate",
          type: "navigate",
          version: 1,
          name: "Open monitored page",
          position: { x: 620, y: 220 },
          configuration: {
            url: "https://example.com",
            waitCondition: "dom_ready",
            timeoutMs: 30000,
          },
          disabled: false,
        },
        {
          id: "extract",
          type: "extract_data",
          version: 1,
          name: "Extract page heading",
          position: { x: 900, y: 220 },
          configuration: {
            locator: {
              primary: {
                kind: "role",
                value: "heading",
                name: "Example Domain",
              },
              alternatives: [],
              tag: "h1",
              stableAttributes: {},
              framePath: [],
              recordingUrl: "https://example.com",
            },
            extract: "text",
            fieldName: "heading",
            repeated: false,
          },
          disabled: false,
        },
        {
          id: "condition",
          type: "condition",
          version: 1,
          name: "Has expected heading",
          position: { x: 1180, y: 220 },
          configuration: {
            left: "{{nodes.extract.output.data.heading}}",
            operator: "contains",
            right: "Example Domain",
          },
          disabled: false,
        },
        {
          id: "changed",
          type: "desktop_notification",
          version: 1,
          name: "Notify when changed",
          position: { x: 1460, y: 330 },
          configuration: {
            title: "Website content changed",
            message: "The monitored heading changed.",
          },
          disabled: false,
        },
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "schedule",
          sourceHandle: "output",
          targetNodeId: "browser",
          targetHandle: "input",
        },
        {
          id: "e2",
          sourceNodeId: "browser",
          sourceHandle: "output",
          targetNodeId: "navigate",
          targetHandle: "input",
        },
        {
          id: "e3",
          sourceNodeId: "navigate",
          sourceHandle: "output",
          targetNodeId: "extract",
          targetHandle: "input",
        },
        {
          id: "e4",
          sourceNodeId: "extract",
          sourceHandle: "output",
          targetNodeId: "condition",
          targetHandle: "input",
        },
        {
          id: "e5",
          sourceNodeId: "condition",
          sourceHandle: "false",
          targetNodeId: "changed",
          targetHandle: "input",
        },
      ],
    };
  if (template === "download-daily-report")
    return {
      ...base,
      name: "Download Daily Report",
      triggerNodeId: "schedule",
      nodes: [
        {
          id: "schedule",
          type: "schedule_trigger",
          version: 1,
          name: "Daily at 09:00",
          position: { x: 60, y: 220 },
          configuration: { scheduleType: "daily", time: "09:00" },
          disabled: false,
        },
        {
          id: "browser",
          type: "open_browser",
          version: 1,
          name: "Open reporting profile",
          position: { x: 340, y: 220 },
          configuration: {
            profileId: "",
            headed: false,
            viewport: { width: 1280, height: 800 },
            closeAutomatically: true,
          },
          disabled: false,
        },
        {
          id: "navigate",
          type: "navigate",
          version: 1,
          name: "Open report portal",
          position: { x: 620, y: 220 },
          configuration: {
            url: "https://example.com",
            waitCondition: "dom_ready",
          },
          disabled: false,
        },
        {
          id: "download",
          type: "download_file",
          version: 1,
          name: "Download report",
          position: { x: 900, y: 220 },
          configuration: {
            locator: {
              primary: {
                kind: "role",
                value: "button",
                name: "Download report",
              },
              alternatives: [],
              tag: "button",
              stableAttributes: {},
              framePath: [],
              recordingUrl: "https://example.com",
            },
            destinationFolder: "",
            filename: "daily-report.csv",
          },
          disabled: false,
        },
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "schedule",
          sourceHandle: "output",
          targetNodeId: "browser",
          targetHandle: "input",
        },
        {
          id: "e2",
          sourceNodeId: "browser",
          sourceHandle: "output",
          targetNodeId: "navigate",
          targetHandle: "input",
        },
        {
          id: "e3",
          sourceNodeId: "navigate",
          sourceHandle: "output",
          targetNodeId: "download",
          targetHandle: "input",
        },
      ],
    };
  if (template === "email-enquiry-draft")
    return {
      ...base,
      name: "Email Enquiry Draft",
      triggerNodeId: "new_email",
      nodes: [
        {
          id: "new_email",
          type: "gmail_new_email_trigger",
          version: 1,
          name: "New enquiry email",
          position: { x: 60, y: 220 },
          configuration: {
            credentialId: "",
            pollIntervalMinutes: 5,
            subjectContains: "enquiry",
          },
          disabled: false,
        },
        {
          id: "condition",
          type: "condition",
          version: 1,
          name: "Has a sender",
          position: { x: 340, y: 220 },
          configuration: {
            left: "{{trigger.email.sender}}",
            operator: "exists",
            right: null,
          },
          disabled: false,
        },
        {
          id: "compose",
          type: "set_data",
          version: 1,
          name: "Prepare acknowledgement",
          position: { x: 620, y: 150 },
          configuration: {
            values: {
              recipient: "{{trigger.email.sender}}",
              subject: "Re: {{trigger.email.subject}}",
              body: "Thanks for your enquiry.",
            },
          },
          disabled: false,
        },
        {
          id: "draft",
          type: "gmail_create_draft",
          version: 1,
          name: "Create Gmail draft",
          position: { x: 900, y: 150 },
          configuration: {
            credentialId: "",
            to: "{{nodes.compose.output.recipient}}",
            subject: "{{nodes.compose.output.subject}}",
            body: "{{nodes.compose.output.body}}",
          },
          disabled: false,
        },
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "new_email",
          sourceHandle: "output",
          targetNodeId: "condition",
          targetHandle: "input",
        },
        {
          id: "e2",
          sourceNodeId: "condition",
          sourceHandle: "true",
          targetNodeId: "compose",
          targetHandle: "input",
        },
        {
          id: "e3",
          sourceNodeId: "compose",
          sourceHandle: "output",
          targetNodeId: "draft",
          targetHandle: "input",
        },
      ],
    };
  if (template === "website-status-discord")
    return {
      ...base,
      name: "Website Status to Discord",
      triggerNodeId: "schedule",
      settings: {
        ...base.settings,
        permissions: {
          ...base.settings.permissions,
          approvedNetworkDomains: ["example.com"],
        },
      },
      nodes: [
        {
          id: "schedule",
          type: "schedule_trigger",
          version: 1,
          name: "Every 15 minutes",
          position: { x: 60, y: 220 },
          configuration: { scheduleType: "minutes", every: 15 },
          disabled: false,
        },
        {
          id: "request",
          type: "http_request",
          version: 1,
          name: "Check website",
          position: { x: 340, y: 220 },
          configuration: {
            method: "GET",
            url: "https://example.com",
            headers: {},
            query: {},
          },
          disabled: false,
        },
        {
          id: "condition",
          type: "condition",
          version: 1,
          name: "Status is healthy",
          position: { x: 620, y: 220 },
          configuration: {
            left: "{{nodes.request.output.status}}",
            operator: "equals",
            right: 200,
          },
          disabled: false,
        },
        {
          id: "discord",
          type: "discord_webhook",
          version: 1,
          name: "Alert Discord",
          position: { x: 900, y: 330 },
          configuration: { credentialId: "", content: "Website check failed." },
          disabled: false,
        },
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "schedule",
          sourceHandle: "output",
          targetNodeId: "request",
          targetHandle: "input",
        },
        {
          id: "e2",
          sourceNodeId: "request",
          sourceHandle: "output",
          targetNodeId: "condition",
          targetHandle: "input",
        },
        {
          id: "e3",
          sourceNodeId: "condition",
          sourceHandle: "false",
          targetNodeId: "discord",
          targetHandle: "input",
        },
      ],
    };
  if (template === "website-health")
    return {
      ...base,
      name: "Website Health Monitor",
      triggerNodeId: "manual_trigger",
      settings: {
        ...base.settings,
        permissions: {
          ...base.settings.permissions,
          approvedNetworkDomains: ["example.com"],
        },
      },
      nodes: [
        {
          id: "manual_trigger",
          type: "manual_trigger",
          version: 1,
          name: "Manual Trigger",
          position: { x: 60, y: 220 },
          configuration: {},
          disabled: false,
        },
        {
          id: "http_request",
          type: "http_request",
          version: 1,
          name: "HTTP Request",
          position: { x: 340, y: 220 },
          configuration: {
            method: "GET",
            url: "https://example.com",
            timeoutMs: 30000,
            retryCount: 1,
            headers: {},
            query: {},
          },
          disabled: false,
        },
        {
          id: "condition",
          type: "condition",
          version: 1,
          name: "Condition",
          position: { x: 620, y: 220 },
          configuration: {
            left: "{{nodes.http_request.output.status}}",
            operator: "equals",
            right: 200,
          },
          disabled: false,
        },
        {
          id: "notification_success",
          type: "desktop_notification",
          version: 1,
          name: "Desktop Notification",
          position: { x: 920, y: 150 },
          configuration: {
            title: "Website is healthy",
            message: "example.com returned 200",
          },
          disabled: false,
        },
        {
          id: "notification_failed",
          type: "desktop_notification",
          version: 1,
          name: "Desktop Notification",
          position: { x: 920, y: 330 },
          configuration: {
            title: "Website needs attention",
            message: "Check the latest response",
          },
          disabled: false,
        },
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "manual_trigger",
          sourceHandle: "output",
          targetNodeId: "http_request",
          targetHandle: "input",
        },
        {
          id: "e2",
          sourceNodeId: "http_request",
          sourceHandle: "output",
          targetNodeId: "condition",
          targetHandle: "input",
        },
        {
          id: "e3",
          sourceNodeId: "condition",
          sourceHandle: "true",
          targetNodeId: "notification_success",
          targetHandle: "input",
        },
        {
          id: "e4",
          sourceNodeId: "condition",
          sourceHandle: "false",
          targetNodeId: "notification_failed",
          targetHandle: "input",
        },
      ],
    };
  if (template === "downloads-organiser")
    return {
      ...base,
      name: "Downloads Folder Organiser",
      triggerNodeId: "file_watch",
      nodes: [
        {
          id: "file_watch",
          type: "file_watch_trigger",
          version: 1,
          name: "File Watch Trigger",
          position: { x: 60, y: 220 },
          configuration: { folder: "", events: ["created"], pattern: "*.pdf" },
          disabled: false,
        },
        {
          id: "condition",
          type: "condition",
          version: 1,
          name: "Condition",
          position: { x: 340, y: 220 },
          configuration: {
            left: "{{trigger.extension}}",
            operator: "equals",
            right: "pdf",
          },
          disabled: false,
        },
        {
          id: "move_file",
          type: "move_file",
          version: 1,
          name: "Move File",
          position: { x: 650, y: 150 },
          configuration: {
            source: "{{trigger.path}}",
            destinationFolder: "",
            renameTo: "",
            overwrite: false,
          },
          disabled: false,
        },
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "file_watch",
          sourceHandle: "output",
          targetNodeId: "condition",
          targetHandle: "input",
        },
        {
          id: "e2",
          sourceNodeId: "condition",
          sourceHandle: "true",
          targetNodeId: "move_file",
          targetHandle: "input",
        },
      ],
    };
  return {
    ...base,
    name: "Untitled workflow",
    triggerNodeId: "manual_trigger",
    nodes: [
      {
        id: "manual_trigger",
        type: "manual_trigger",
        version: 1,
        name: "Manual Trigger",
        position: { x: 80, y: 220 },
        configuration: {},
        disabled: false,
      },
    ],
    edges: [],
  };
};
const workflows = (): Workflow[] =>
  (JSON.parse(localStorage.getItem(KEY) ?? "[]") as Workflow[]).map(workflow=>({...workflow,schemaVersion:6,settings:{...workflow.settings,expressionLanguageVersion:workflow.settings.expressionLanguageVersion??1,collectionLimits:workflow.settings.collectionLimits??defaultCollectionLimits(),permissions:{...workflow.settings.permissions,approvedEnvironmentVariables:workflow.settings.permissions.approvedEnvironmentVariables??[]}}} as Workflow));
const saveAll = (v: Workflow[]) => localStorage.setItem(KEY, JSON.stringify(v));
const runs = () =>
  JSON.parse(localStorage.getItem(RUNS) ?? "[]") as ExecutionRecord[];
const saveRuns = (v: ExecutionRecord[]) =>
  localStorage.setItem(RUNS, JSON.stringify(v));
const metadata = () =>
  JSON.parse(localStorage.getItem(META) ?? "{}") as Record<
    string,
    WorkflowMetadata
  >;
const saveMetadata = (value: Record<string, WorkflowMetadata>) =>
  localStorage.setItem(META, JSON.stringify(value));
interface PreviewRevision {
  summary: WorkflowRevisionSummary;
  workflow: Workflow;
}
const revisions = () =>
  JSON.parse(localStorage.getItem(REVISIONS) ?? "{}") as Record<
    string,
    PreviewRevision[]
  >;
const saveRevisions = (value: Record<string, PreviewRevision[]>) =>
  localStorage.setItem(REVISIONS, JSON.stringify(value));
const previewHash = (workflow: Workflow) => {
  const copy: Partial<Workflow> = structuredClone(workflow);
  delete copy.updatedAt;
  let hash = 2166136261;
  for (const character of JSON.stringify(copy)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `preview:${(hash >>> 0).toString(16).padStart(8, "0")}`;
};
const defaultMetadata = (): WorkflowMetadata => ({ favorite: false, tags: [] });
export const previewApi = {
  async listWorkflows(includeArchived = false): Promise<WorkflowSummary[]> {
    const meta = metadata();
    return workflows()
      .map((workflow) => ({
        workflow,
        metadata: meta[workflow.id] ?? defaultMetadata(),
        lastExecution: runs().find((r) => r.workflowId === workflow.id),
      }))
      .filter((item) => includeArchived || !item.metadata.archivedAt);
  },
  async getWorkflow(id: string) {
    const workflow = workflows().find((w) => w.id === id);
    if (workflow)
      await this.updateWorkflowMetadata(id, { lastOpenedAt: now() });
    return workflow;
  },
  async saveWorkflow(workflow: Workflow) {
    workflow.schemaVersion = 6;
    workflow.updatedAt = now();
    const all = workflows();
    const i = all.findIndex((w) => w.id === workflow.id);
    if (i < 0) all.unshift(workflow);
    else all[i] = workflow;
    saveAll(all);
    const allRevisions = revisions();
    const history = allRevisions[workflow.id] ?? [];
    const contentHash = previewHash(workflow);
    if (history[0]?.summary.contentHash !== contentHash) {
      const revisionId = crypto.randomUUID();
      history.unshift({
        summary: {
          revisionId,
          workflowId: workflow.id,
          parentRevisionId: history[0]?.summary.revisionId,
          schemaVersion: workflow.schemaVersion,
          contentHash,
          changeSummary: history.length ? "Changed workflow" : "Created workflow",
          createdAt: workflow.updatedAt,
          current: true,
        },
        workflow: structuredClone(workflow),
      });
      history.forEach((revision, index) => {
        revision.summary.current = index === 0;
      });
      allRevisions[workflow.id] = history;
      saveRevisions(allRevisions);
    }
    return workflow;
  },
  async listWorkflowRevisions(workflowId: string) {
    const workflow = workflows().find((item) => item.id === workflowId);
    const history = revisions()[workflowId] ?? [];
    if (!history.length && workflow) {
      await this.saveWorkflow(workflow);
      return (revisions()[workflowId] ?? []).map((item) => item.summary);
    }
    return history.map((item) => item.summary);
  },
  async getWorkflowRevision(workflowId: string, revisionId: string) {
    return revisions()[workflowId]?.find(
      (item) => item.summary.revisionId === revisionId,
    )?.workflow;
  },
  async restoreWorkflowRevision(workflowId: string, revisionId: string) {
    const revision = await this.getWorkflowRevision(workflowId, revisionId);
    if (!revision) throw new Error("Workflow revision no longer exists.");
    return this.saveWorkflow(structuredClone(revision));
  },
  async createWorkflow(templateKey?: string, name?: string) {
    const w = blank(templateKey);
    if (name) w.name = name;
    return this.saveWorkflow(w);
  },
  async deleteWorkflow(id: string) {
    saveAll(workflows().filter((w) => w.id !== id));
  },
  async updateWorkflowMetadata(id: string, patch: WorkflowMetadataPatch) {
    if (patch.folder != null && patch.folder.trim().length > 64)
      throw new Error("Folder names are limited to 64 characters.");
    if (
      patch.tags &&
      (patch.tags.length > 10 ||
        patch.tags.some((tag) => tag.trim().length > 32))
    )
      throw new Error(
        "Use at most 10 tags, each no longer than 32 characters.",
      );
    const meta = metadata();
    const current = meta[id] ?? defaultMetadata();
    const folder =
      patch.folder === null
        ? undefined
        : (patch.folder?.trim() ?? current.folder);
    let tags = patch.tags?.map((tag) => tag.trim()).filter(Boolean) ?? current.tags;
    for (const tag of patch.addTags?.map((value) => value.trim()).filter(Boolean) ?? []) if (!tags.some((current) => current.toLowerCase() === tag.toLowerCase())) tags.push(tag);
    const removedTags = new Set(patch.removeTags?.map((value) => value.trim().toLowerCase()) ?? []);
    tags = tags.filter((tag) => !removedTags.has(tag.toLowerCase()));
    const { addTags: _addTags, removeTags: _removeTags, ...plainPatch } = patch;
    meta[id] = {
      ...current,
      ...plainPatch,
      folder,
      tags,
      archivedAt:
        patch.archivedAt === null
          ? undefined
          : (patch.archivedAt ?? current.archivedAt),
      lastOpenedAt:
        patch.lastOpenedAt === null
          ? undefined
          : (patch.lastOpenedAt ?? current.lastOpenedAt),
    };
    saveMetadata(meta);
    return (await this.listWorkflows(true)).find(
      (item) => item.workflow.id === id,
    )!;
  },
  async batchUpdateWorkflowMetadata(ids: string[], patch: WorkflowMetadataPatch) {
    const existing = new Set(workflows().map((workflow) => workflow.id));
    if (!ids.length) throw new Error("Choose at least one workflow.");
    if (ids.length > 500) throw new Error("Bulk actions are limited to 500 workflows.");
    if (ids.some((id) => !existing.has(id))) throw new Error("A selected workflow no longer exists.");
    if (patch.folder != null && patch.folder.trim().length > 64) throw new Error("Folder names are limited to 64 characters.");
    if (patch.tags && (patch.tags.length > 10 || patch.tags.some((tag) => tag.trim().length > 32))) throw new Error("Use at most 10 tags, each no longer than 32 characters.");
    for (const id of [...new Set(ids)]) await this.updateWorkflowMetadata(id, patch);
  },
  async duplicateWorkflow(id: string, name?: string) {
    const source = workflows().find((item) => item.id === id);
    if (!source) throw new Error("Workflow no longer exists.");
    const existing = new Set(
      workflows().map((item) => item.name.toLowerCase()),
    );
    let next = name?.trim() || `${source.name} copy`;
    let suffix = 2;
    while (existing.has(next.toLowerCase()))
      next = `${source.name} copy ${suffix++}`;
    const created = structuredClone(source);
    created.id = crypto.randomUUID();
    created.name = next;
    created.enabled = false;
    created.createdAt = created.updatedAt = now();
    created.settings.permissions = {
      approvedFolders: [],
      approvedNetworkDomains: [],
      approvedBrowserProfileIds: [],
      browserAutomationPermitted: false,
      externalCommunicationPermitted: false,
      commandExecutionPermitted: false,
      backgroundExecutionPermitted: false,
    };
    saveAll([created, ...workflows()]);
    return created;
  },
  async archiveWorkflow(id: string) {
    const workflow = workflows().find((item) => item.id === id);
    if (workflow?.enabled) {
      workflow.enabled = false;
      await this.saveWorkflow(workflow);
    }
    await this.updateWorkflowMetadata(id, { archivedAt: now() });
  },
  async archiveWorkflows(ids: string[]) {
    const existing = new Set(workflows().map((workflow) => workflow.id));
    if (!ids.length || ids.some((id) => !existing.has(id))) throw new Error("A selected workflow no longer exists.");
    for (const id of [...new Set(ids)]) await this.archiveWorkflow(id);
  },
  async restoreWorkflow(id: string) {
    const workflow = workflows().find((item) => item.id === id);
    if (workflow?.enabled) {
      workflow.enabled = false;
      await this.saveWorkflow(workflow);
    }
    await this.updateWorkflowMetadata(id, { archivedAt: null });
  },
  async restoreWorkflows(ids: string[]) {
    const existing = new Set(workflows().map((workflow) => workflow.id));
    if (!ids.length || ids.some((id) => !existing.has(id))) throw new Error("A selected workflow no longer exists.");
    for (const id of [...new Set(ids)]) await this.restoreWorkflow(id);
  },
  async purgeWorkflow(id: string) {
    const item = (await this.listWorkflows(true)).find(
      (summary) => summary.workflow.id === id,
    );
    if (!item?.metadata.archivedAt)
      throw new Error("Only archived workflows can be permanently deleted.");
    await this.deleteWorkflow(id);
  },
  async validateWorkflow(workflow: Workflow): Promise<ValidationIssue[]> {
    const issues: ValidationIssue[] = [];
    const triggers = workflow.nodes.filter((n) => n.type.endsWith("trigger"));
    if (triggers.length !== 1)
      issues.push({
        code: "trigger_count",
        message: `Workflow requires exactly one trigger; found ${triggers.length}.`,
        severity: "error",
        suggestion: "Keep one trigger node at the start of the workflow.",
      });
    workflow.nodes.forEach((n) => {
      if (n.type === "http_request" && !n.configuration.url)
        issues.push({
          code: "incomplete_node",
          message: "HTTP Request requires a URL.",
          severity: "error",
          nodeId: n.id,
          fieldPath: "configuration.url",
          suggestion: "Enter an http:// or https:// URL.",
        });
      const missing = (field: string) => !n.inputBindings?.[field] && !String(n.configuration[field] ?? "").trim();
      const requiredField = n.type === "ai_prompt"
        ? (missing("connectionId") ? "connectionId" : missing("prompt") ? "prompt" : undefined)
        : n.type === "code"
          ? (missing("sourceCode") ? "sourceCode" : undefined)
          : n.type === "web_builder"
            ? (["html", "javascript", "css"].find(missing))
            : undefined;
      if (requiredField) issues.push({
        code: "incomplete_node",
        message: n.type === "web_builder" ? "Web Builder requires mapped HTML, JavaScript, and CSS inputs." : `${n.name} requires ${requiredField.replaceAll(/([A-Z])/g, " $1").toLowerCase()}.`,
        severity: "error",
        nodeId: n.id,
        fieldPath: `configuration.${requiredField}`,
        suggestion: "Complete this field before running the workflow.",
      });
    });
    return issues;
  },
  async runWorkflow(id: string): Promise<ExecutionRecord> {
    const workflow = workflows().find((w) => w.id === id)!;
    const startedAt = now();
    const records: NodeExecution[] = workflow.nodes.map((n, i) => ({
      nodeId: n.id,
      status: n.id === "notification_failed" ? "skipped" : "successful",
      startedAt: new Date(Date.now() + i * 120).toISOString(),
      completedAt: new Date(Date.now() + i * 120 + 60).toISOString(),
      durationMs:
        n.type === "http_request"
          ? 284
          : Math.max(2, Math.round(Math.random() * 20)),
      input: i
        ? { dependencies: { [workflow.nodes[i - 1].id]: "Structured output" } }
        : { trigger: { type: "manual" } },
      output:
        n.type === "http_request"
          ? {
              status: 200,
              headers: { "content-type": "text/html" },
              body: "<!doctype html>…",
              durationMs: 284,
              finalUrl: "https://example.com/",
            }
          : n.type === "condition"
            ? { result: true, left: 200, right: 200, operator: "equals" }
            : n.type === "ai_prompt"
              ? { response: "Preview AI response", model: "preview-model", usage: { totalTokens: 24 } }
              : n.type === "code"
                ? { code: String(n.configuration.sourceCode ?? ""), language: n.configuration.language, result: String(n.configuration.sourceCode ?? "") }
                : n.type === "web_builder"
                  ? { url: "http://127.0.0.1:4173/", port: 4173, status: "preview" }
            : { delivered: n.type === "desktop_notification" },
      logs: [
        n.type === "http_request"
          ? "GET https://example.com/ completed with status 200."
          : `${n.name} completed.`,
      ],
      retryCount: 0,
      skipReason:
        n.id === "notification_failed"
          ? "The node was not reached because its branch was not followed."
          : undefined,
      branchFollowed: n.type === "condition" ? "true" : undefined,
    }));
    const run: ExecutionRecord = {
      id: crypto.randomUUID(),
      workflowId: id,
      workflowVersion: 1,
      trigger: { type: "manual" },
      status: "successful",
      startedAt,
      completedAt: now(),
      durationMs: 412,
      nodeExecutions: records,
      recoveredAfterCrash: false,
    };
    saveRuns([run, ...runs()]);
    return run;
  },
  async testWorkflowNode(
    workflow: Workflow,
    nodeId: string,
    inputOverrides: Record<string, unknown>,
    previousExecutionId?: string,
    allowSideEffects = false,
  ): Promise<ExecutionRecord> {
    const node = workflow.nodes.find((item) => item.id === nodeId);
    if (!node) throw new Error("The selected node no longer exists.");
    const sideEffects = new Set([
      "desktop_notification",
      "move_file",
      "write_file",
      "copy_path",
      "delete_path",
      "run_command",
      "code",
      "javascript_code",
      "python_code",
      "web_builder",
      "gmail_create_draft",
      "gmail_send_email",
      "gmail_add_label",
      "discord_webhook",
      "discord_embed",
      "slack_webhook",
      "approval",
      "set_workflow_state",
      "compare_previous",
    ]);
    if (sideEffects.has(node.type) && !allowSideEffects)
      throw new Error(
        "Testing this node can change external state. Confirm side effects before running the test.",
      );
    const startedAt = now();
    const execution: ExecutionRecord = {
      id: crypto.randomUUID(),
      workflowId: workflow.id,
      workflowVersion: workflow.schemaVersion,
      trigger: { type: "node_test", previousExecutionId },
      status: "successful",
      startedAt,
      completedAt: now(),
      durationMs: 8,
      nodeExecutions: [
        {
          nodeId,
          status: "successful",
          startedAt,
          completedAt: now(),
          durationMs: 8,
          input: { overrides: inputOverrides, previousExecutionId },
          output: {
            tested: true,
            configuration: { ...node.configuration, ...inputOverrides },
          },
          logs: [
            "Tested only this node; upstream and downstream nodes did not run.",
          ],
          retryCount: 0,
        },
      ],
      recoveredAfterCrash: false,
    };
    saveRuns([execution, ...runs()]);
    return execution;
  },
  async retryFailedNode(
    executionId: string,
    nodeId: string,
  ): Promise<ExecutionRecord> {
    const previous = runs().find((r) => r.id === executionId);
    if (!previous) throw new Error("Execution no longer exists.");
    const failed = previous.nodeExecutions.find(
      (n) => n.nodeId === nodeId && n.status === "failed",
    );
    if (!failed)
      throw new Error("Only a failed node can be retried independently.");
    const startedAt = now();
    const nodeExecution: NodeExecution = {
      ...failed,
      status: "successful",
      startedAt,
      completedAt: now(),
      durationMs: 12,
      output: { retried: true },
      logs: [...failed.logs, "Failed node retry completed."],
      retryCount: failed.retryCount + 1,
      error: undefined,
    };
    const run: ExecutionRecord = {
      id: crypto.randomUUID(),
      workflowId: previous.workflowId,
      workflowVersion: previous.workflowVersion,
      trigger: previous.trigger,
      status: "successful",
      startedAt,
      completedAt: now(),
      durationMs: 12,
      nodeExecutions: [nodeExecution],
      recoveredAfterCrash: false,
    };
    saveRuns([run, ...runs()]);
    return run;
  },
  async listExecutions(workflowId?: string) {
    return runs().filter((r) => !workflowId || r.workflowId === workflowId);
  },
  async getExecution(id: string) {
    return runs().find((r) => r.id === id);
  },
  async clearExecutionHistory(keep = 0) {
    saveRuns(runs().slice(0, keep));
    return keep;
  },
  async cancelExecution() {},
  async queryExecutions(query: ExecutionQuery) {
    let values = runs();
    const meta = workflows();
    if (query.search) {
      const needle = query.search.toLowerCase();
      values = values.filter(
        (run) =>
          (meta.find((workflow) => workflow.id === run.workflowId)?.name ?? "")
            .toLowerCase()
            .includes(needle) ||
          run.error?.message.toLowerCase().includes(needle) ||
          run.nodeExecutions.some(
            (node) =>
              node.error?.message.toLowerCase().includes(needle) ||
              node.error?.detail?.toLowerCase().includes(needle),
          ),
      );
    }
    if (query.workflowIds?.length)
      values = values.filter((run) =>
        query.workflowIds!.includes(run.workflowId),
      );
    if (query.statuses?.length)
      values = values.filter((run) => query.statuses!.includes(run.status));
    if (query.triggerTypes?.length)
      values = values.filter((run) =>
        query.triggerTypes!.includes(
          String((run.trigger as { type?: string }).type ?? "manual"),
        ),
      );
    if (query.startedAfter)
      values = values.filter((run) => run.startedAt >= query.startedAfter!);
    if (query.startedBefore)
      values = values.filter((run) => run.startedAt <= query.startedBefore!);
    values.sort(
      (a, b) =>
        b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id),
    );
    if (query.cursor) {
      const [startedAt, id] = query.cursor.split("|");
      values = values.filter(
        (run) =>
          run.startedAt < startedAt ||
          (run.startedAt === startedAt && run.id < id),
      );
    }
    const limit = Math.min(100, Math.max(1, query.limit ?? 50));
    const items = values.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        values.length > limit && last
          ? `${last.startedAt}|${last.id}`
          : undefined,
    };
  },
  async deleteExecution(id: string) {
    saveRuns(runs().filter((run) => run.id !== id));
  },
  async runnerStatus(): Promise<RunnerStatus> {
    const scheduled = workflows().filter(
      (workflow) =>
        workflow.enabled &&
        workflow.nodes.some((node) => node.type === "schedule_trigger"),
    );
    return {
      paused: localStorage.getItem(RUNNER) === "true",
      activeWorkflowIds: [],
      localSchedulesStopOnQuit: true,
      scheduledWorkflowCount: scheduled.length,
    };
  },
  async setRunnerPaused(paused: boolean) {
    localStorage.setItem(RUNNER, String(paused));
    window.dispatchEvent(new CustomEvent("runner-status-changed"));
    return this.runnerStatus();
  },
  async listBrowserProfiles() {
    const stored = JSON.parse(
      localStorage.getItem(PROFILES) ?? "[]",
    ) as Partial<BrowserProfile>[];
    return stored
      .filter((profile) => profile.id && profile.name)
      .map(
        (profile) =>
          ({
            ...profile,
            persistent: profile.persistent !== false,
            dataPath: profile.dataPath ?? "Managed application data",
            settings: {
              viewportWidth: profile.settings?.viewportWidth ?? 1280,
              viewportHeight: profile.settings?.viewportHeight ?? 800,
              permissions: profile.settings?.permissions ?? [],
              downloadFolder: profile.settings?.downloadFolder,
              proxy: profile.settings?.proxy,
              userAgent: profile.settings?.userAgent,
            },
            createdAt: profile.createdAt ?? now(),
          }) as BrowserProfile,
      );
  },
  async createBrowserProfile(
    name: string,
    persistent = true,
    settings?: BrowserProfileSettings,
  ) {
    const profile: BrowserProfile = {
      id: crypto.randomUUID(),
      name,
      persistent,
      dataPath: "Managed application data",
      settings: settings ?? {
        viewportWidth: 1280,
        viewportHeight: 800,
        permissions: [],
      },
      createdAt: now(),
    };
    const profiles = await this.listBrowserProfiles();
    localStorage.setItem(PROFILES, JSON.stringify([...profiles, profile]));
    return profile;
  },
  async updateBrowserProfile(
    id: string,
    name: string,
    persistent: boolean,
    settings: BrowserProfileSettings,
  ) {
    const profiles = await this.listBrowserProfiles();
    const profile = profiles.find((item) => item.id === id)!;
    Object.assign(profile, { name, persistent, settings });
    localStorage.setItem(PROFILES, JSON.stringify(profiles));
    return profile;
  },
  async duplicateBrowserProfile(id: string) {
    const source = (await this.listBrowserProfiles()).find(
      (item) => item.id === id,
    )!;
    return this.createBrowserProfile(
      `${source.name} copy`,
      source.persistent,
      source.settings,
    );
  },
  async deleteBrowserProfile(id: string) {
    localStorage.setItem(
      PROFILES,
      JSON.stringify(
        (await this.listBrowserProfiles()).filter((item) => item.id !== id),
      ),
    );
  },
  async listConnections() {
    return JSON.parse(
      localStorage.getItem(CONNECTIONS) ?? "[]",
    ) as ConnectionMetadata[];
  },
  async submitBugReport(report: BugReportDraft): Promise<BugReportReceipt> {
    if (!report.summary.trim() || !report.description.trim())
      throw new Error("A summary and description are required.");
    const response = await fetch("/__sndbox/bug-reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
    });
    const body = await response.text();
    let payload: BugReportReceipt & { error?: string };
    try {
      payload = JSON.parse(body) as BugReportReceipt & { error?: string };
    } catch {
      throw new Error(
        response.ok
          ? "The bug-report service returned an invalid response."
          : "The development bug-report service is unavailable.",
      );
    }
    if (!response.ok) throw new Error(payload.error || "Bug report delivery failed.");
    return payload;
  },
};
