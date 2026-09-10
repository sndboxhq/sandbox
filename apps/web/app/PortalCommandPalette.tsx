"use client";

import { Command, Search, X } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { withWorkspaceContext } from "../lib/workspace-context";
import type { WorkspaceChoice } from "./WorkspaceSelector";

const recentKey = "sndbox.portal.recent-commands.v1";
const destinations = [
  ["/", "Overview", "Account and workspace health"],
  ["/organisations", "Workspaces", "Members, approvals, and governance"],
  ["/operations", "Runner operations", "Pair and manage Linux runners"],
  ["/usage", "Usage", "Hosted infrastructure usage"],
  ["/billing", "Plan & billing", "Plans, credit, and rates"],
  ["/security", "Security & API", "Sessions and credentials"],
  ["/settings", "Account settings", "Profile and account controls"],
  ["/support", "Help & support", "Guides and support access"],
] as const;

function readRecentCommands() {
  try {
    const value = JSON.parse(localStorage.getItem(recentKey) ?? "[]");
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export function PortalCommandPalette({ workspaces, workspaceId }: { workspaces: WorkspaceChoice[]; workspaceId?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setOpen((value) => !value); }
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    if (open) window.setTimeout(() => input.current?.focus(), 0);
    else if (wasOpen.current) trigger.current?.focus();
    wasOpen.current = open;
  }, [open]);
  const items = useMemo(() => {
    const base = [
      ...destinations.map(([href, name, description]) => ({ id: href, name, description, href: withWorkspaceContext(href, workspaceId) })),
      ...workspaces.map((workspace) => ({ id: `workspace:${workspace.id}`, name: workspace.label, description: `Switch workspace · ${workspace.role}`, href: `/?workspaceId=${encodeURIComponent(workspace.id)}` })),
    ];
    const needle = query.trim().toLowerCase();
    const recent = readRecentCommands();
    return base
      .filter((item) => !needle || `${item.name} ${item.description}`.toLowerCase().includes(needle))
      .sort((left, right) => {
        const leftIndex = recent.indexOf(left.id), rightIndex = recent.indexOf(right.id);
        return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex) - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex);
      });
  }, [query, workspaceId, workspaces]);
  useEffect(() => setActive(0), [query]);
  const choose = (item: (typeof items)[number]) => {
    const recent = readRecentCommands();
    localStorage.setItem(recentKey, JSON.stringify([item.id, ...recent.filter((id) => id !== item.id)].slice(0, 8)));
    setOpen(false);
    setQuery("");
    router.push(item.href);
  };
  return <>
    <button ref={trigger} className="portal-command-trigger" type="button" onClick={() => setOpen(true)} aria-label="Open commands"><Command aria-hidden="true" /><span>Commands</span><kbd>Ctrl K</kbd></button>
    {open && <div className="portal-command-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
      <section className="portal-command" role="dialog" aria-modal="true" aria-label="Account commands">
        <header><Search aria-hidden="true" /><input ref={input} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); setActive((value) => items.length ? Math.min(value + 1, items.length - 1) : 0); }
          if (event.key === "ArrowUp") { event.preventDefault(); setActive((value) => Math.max(value - 1, 0)); }
          if (event.key === "Enter" && items[active]) { event.preventDefault(); choose(items[active]); }
        }} placeholder="Search destinations and workspaces…" role="combobox" aria-controls="portal-command-results" aria-activedescendant={items[active] ? `portal-command-${active}` : undefined} /><button type="button" aria-label="Close commands" onClick={() => setOpen(false)}><X /></button></header>
        <div id="portal-command-results" role="listbox">{items.map((item, index) => <button type="button" role="option" aria-selected={index === active} id={`portal-command-${index}`} key={item.id} onMouseEnter={() => setActive(index)} onClick={() => choose(item)}><strong>{item.name}</strong><small>{item.description}</small></button>)}{!items.length && <p>No matching commands.</p>}</div>
        <footer><span>{pathname}</span><span>↑↓ Navigate · Enter Open · Esc Close</span></footer>
      </section>
    </div>}
  </>;
}
