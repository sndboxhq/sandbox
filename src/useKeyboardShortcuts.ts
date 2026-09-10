import { useEffect } from "react";

export function isTextEntryTarget(target: EventTarget | null): boolean { return target instanceof Element && Boolean(target.closest("input,textarea,select,[contenteditable=true],[role=combobox],.custom-select")); }
export function useKeyboardShortcuts(handler: (event: KeyboardEvent) => void, dependencies: unknown[] = []): void { useEffect(() => { window.addEventListener("keydown", handler); return () => window.removeEventListener("keydown", handler); }, dependencies); }
