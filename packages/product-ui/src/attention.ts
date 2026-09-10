export type AttentionSeverity = "blocking" | "action_required" | "warning" | "healthy";

export interface AttentionItem {
  id: string;
  severity: AttentionSeverity;
  title: string;
  description: string;
  href?: string;
  actionLabel?: string;
}

const attentionPriority: Record<AttentionSeverity, number> = { blocking: 0, action_required: 1, warning: 2, healthy: 3 };

export function rankAttentionItems(items: AttentionItem[]): AttentionItem[] {
  return [...items].sort((left, right) => attentionPriority[left.severity] - attentionPriority[right.severity] || left.title.localeCompare(right.title));
}
