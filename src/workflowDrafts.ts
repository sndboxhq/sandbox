import type { Workflow } from "./types";

const VERSION = 1; const MAX_BYTES = 1024 * 1024; const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export interface WorkflowDraft { version: 1; workflowId: string; baseUpdatedAt: string; workflow: Workflow; savedAt: number; }
export const draftKey = (workflowId: string) => `sandbox.workflow-draft.v1.${workflowId}`;
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
export const canSaveDraft = (dirty: boolean, workflow: Workflow) => dirty && bytes(JSON.stringify(workflow)) <= MAX_BYTES;
export function writeWorkflowDraft(workflow: Workflow, baseUpdatedAt: string): "saved" | "too-large" | "failed" {
  try { if (!canSaveDraft(true, workflow)) return "too-large"; localStorage.setItem(draftKey(workflow.id), JSON.stringify({ version: VERSION, workflowId: workflow.id, baseUpdatedAt, workflow, savedAt: Date.now() } satisfies WorkflowDraft)); return "saved"; } catch { return "failed"; }
}
export function readWorkflowDraft(workflowId: string, now = Date.now()): WorkflowDraft | undefined {
  try { const raw = localStorage.getItem(draftKey(workflowId)); if (!raw || bytes(raw) > MAX_BYTES) { clearWorkflowDraft(workflowId); return undefined; } const item = JSON.parse(raw) as Partial<WorkflowDraft> | null; if (!item || item.version !== VERSION || item.workflowId !== workflowId || typeof item.baseUpdatedAt !== "string" || !item.baseUpdatedAt || typeof item.savedAt !== "number" || !Number.isFinite(item.savedAt) || now - item.savedAt > MAX_AGE_MS || !item.workflow || typeof item.workflow !== "object" || item.workflow.id !== workflowId || !Array.isArray(item.workflow.nodes) || !Array.isArray(item.workflow.edges)) { clearWorkflowDraft(workflowId); return undefined; } return item as WorkflowDraft; } catch { clearWorkflowDraft(workflowId); return undefined; }
}
export function clearWorkflowDraft(workflowId: string): void { try { localStorage.removeItem(draftKey(workflowId)); } catch {} }
export const draftUsesEarlierBase = (draft: WorkflowDraft, saved: Workflow) => draft.baseUpdatedAt !== saved.updatedAt;
