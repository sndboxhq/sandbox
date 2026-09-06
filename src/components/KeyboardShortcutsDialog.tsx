import { Dialog } from "./ui/Dialog";

export function KeyboardShortcutsDialog({ open, onOpenChange, editor }: { open: boolean; onOpenChange: (open: boolean) => void; editor: boolean }) {
  const groups = [
    ["Global", [["Ctrl/Cmd + K", editor ? "Open node picker" : "Open commands"], ["?", "Show keyboard shortcuts"]]],
    ["Workflows", [["/", "Focus workflow or template search"]]],
    ["Editor", [["Ctrl/Cmd + S", "Save workflow"], ["Ctrl/Cmd + Enter", "Save, validate, and run"], ["Ctrl/Cmd + D", "Duplicate selected node"], ["Ctrl/Cmd + Z", "Undo"], ["Ctrl/Cmd + Shift + Z", "Redo"], ["Ctrl/Cmd + Shift + V", "Validate workflow"], ["Delete / Backspace", "Delete selected node"], ["A", "Add node"], ["Escape", "Clear selection or close picker"]]],
  ] as const;
  return <Dialog open={open} onOpenChange={onOpenChange} title="Keyboard shortcuts" description="Shortcuts available in the current workspace."><div className="shortcut-groups">{groups.map(([title, entries]) => (title === "Editor" && !editor ? null : <section key={title} aria-label={`${title} shortcuts`}><h3>{title}</h3>{entries.map(([keys, label]) => <div key={keys} className="shortcut-row"><span>{label}</span><kbd>{keys}</kbd></div>)}</section>))}</div></Dialog>;
}
