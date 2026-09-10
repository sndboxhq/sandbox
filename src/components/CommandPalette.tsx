import * as Dialog from "@radix-ui/react-dialog";
import { Command, Search } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
} from "react";
import {
  NODE_DEFINITIONS,
  isTrigger,
  type PluginNodeChoice,
} from "../catalogue";
import type { NodeType } from "../types";

type Choice = {
  id: string;
  group: string;
  name: string;
  description: string;
  category?: string;
  disabled?: boolean;
  action: () => void;
  icon?: ComponentType<{ size?: number }>;
};
export interface CommandAction {
  id: string;
  name: string;
  description: string;
  group?: string;
  action: () => void;
}
const recentKey = "sandbox.recent-node-types.v1";
const recentCommandKey = "sandbox.recent-commands.v1";
const suggestedFor = (source?: NodeType) =>
  source && isTrigger(source)
    ? ["condition", "http_request", "set_data", "open_browser"]
    : source === "condition"
      ? ["desktop_notification", "set_data", "http_request"]
      : ["condition", "set_data", "desktop_notification"];

export function CommandPalette({
  open,
  onClose,
  onAdd,
  onAddPlugin,
  onCreate,
  pluginNodes = [],
  unavailablePluginNodes = [],
  sourceType,
  hasTrigger = false,
  actions = [],
}: {
  open: boolean;
  onClose: () => void;
  onAdd?: (type: NodeType) => void;
  onAddPlugin?: (choice: PluginNodeChoice) => void;
  onCreate?: () => void;
  pluginNodes?: PluginNodeChoice[];
  unavailablePluginNodes?: PluginNodeChoice[];
  sourceType?: NodeType;
  hasTrigger?: boolean;
  actions?: CommandAction[];
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const resultsRef = useRef<HTMLDivElement>(null);
  const recent = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem(recentKey) ?? "[]") as NodeType[];
    } catch {
      return [];
    }
  }, [open]);
  const recentCommands = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem(recentCommandKey) ?? "[]") as string[];
    } catch {
      return [];
    }
  }, [open]);
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);
  const remember = (type: NodeType) =>
    localStorage.setItem(
      recentKey,
      JSON.stringify(
        [type, ...recent.filter((item) => item !== type)].slice(0, 6),
      ),
    );
  const choices = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const all: Choice[] = [];
    actions.forEach((item) =>
      all.push({ ...item, group: item.group ?? "Navigation", icon: Command }),
    );
    const addNode = (type: NodeType, group: string) => {
      const node = NODE_DEFINITIONS.find((item) => item.type === type);
      if (!node) return;
      const disabled = hasTrigger && isTrigger(type);
      all.push({
        id: `node-${type}`,
        group,
        name: node.name,
        description: disabled
          ? "A workflow already has a trigger. Remove or replace it first."
          : node.description,
        category: node.group,
        disabled,
        icon: node.icon,
        action: () => {
          if (disabled) return;
          remember(type);
          onAdd?.(type);
        },
      });
    };
    if (onCreate)
      all.push({
        id: "create-workflow",
        group: "Actions",
        name: "Create workflow",
        description: "Choose a template and name in the creation dialog.",
        action: onCreate,
        icon: Command,
      });
    if (onAdd) {
      const suggestions = suggestedFor(sourceType).filter((type) =>
        NODE_DEFINITIONS.some((node) => node.type === type),
      );
      suggestions.forEach((type) => addNode(type, "Suggested next"));
      recent
        .filter((type) => !suggestions.includes(type))
        .forEach((type) => addNode(type, "Recently used"));
      NODE_DEFINITIONS.filter(
        (node) =>
          !suggestions.includes(node.type) && !recent.includes(node.type),
      ).forEach((node) => addNode(node.type, node.group));
    }
    if (onAddPlugin)
      pluginNodes.forEach((choice) =>
        all.push({
          id: `plugin-${choice.plugin.packageIntegrity}-${choice.node.nodeType}`,
          group: "Plugins",
          name: choice.node.displayName,
          description: `${choice.plugin.manifest.name} · v${choice.plugin.version}`,
          category: choice.plugin.publisherId,
          action: () => onAddPlugin(choice),
        }),
      );
    unavailablePluginNodes.forEach((choice) =>
      all.push({
        id: `unavailable-${choice.plugin.packageIntegrity}-${choice.node.nodeType}`,
        group: "Unavailable",
        name: choice.node.displayName,
        description: `${choice.plugin.manifest.name} is ${choice.plugin.state}. Enable this exact version in Plugins to use the node.`,
        category: choice.plugin.publisherId,
        disabled: true,
        action: () => undefined,
      }),
    );
    const ordered = needle
      ? all
      : [
          ...recentCommands
            .map((id) => all.find((item) => item.id === id))
            .filter((item): item is Choice => Boolean(item))
            .map((item) => ({ ...item, group: "Recent commands" })),
          ...all,
        ];
    const filtered = needle
      ? ordered.filter((item) =>
          (item.name + item.description + item.group + (item.category ?? ""))
            .toLowerCase()
            .includes(needle),
        )
      : ordered;
    const seen = new Set<string>();
    return filtered.filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  }, [
    actions,
    hasTrigger,
    onAdd,
    onAddPlugin,
    onCreate,
    pluginNodes,
    unavailablePluginNodes,
    query,
    recent,
    recentCommands,
    sourceType,
  ]);
  useEffect(() => {
    setActive((value) => Math.min(value, Math.max(0, choices.length - 1)));
  }, [choices.length]);
  useEffect(() => {
    resultsRef.current
      ?.querySelector<HTMLElement>(`#command-choice-${active}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [active]);
  const activate = (index: number) => {
    const item = choices[index];
    if (item && !item.disabled) {
      localStorage.setItem(
        recentCommandKey,
        JSON.stringify(
          [item.id, ...recentCommands.filter((id) => id !== item.id)].slice(0, 8),
        ),
      );
      item.action();
      onClose();
    }
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((value) => Math.min(choices.length - 1, value + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((value) => Math.max(0, value - 1));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(Math.max(0, choices.length - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      activate(active);
    } else if (event.key === "Escape") onClose();
  };
  let lastGroup = "";
  return (
    <Dialog.Root open={open} onOpenChange={(value) => !value && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="ui-dialog-overlay" />
        <Dialog.Content
          className="command-modal"
          aria-describedby="command-description"
        >
          <Dialog.Title className="sr-only">Commands and nodes</Dialog.Title>
          <Dialog.Description id="command-description" className="sr-only">
            Search commands, navigation, and workflow nodes.
          </Dialog.Description>
          <div className="command-search">
            <Search size={17} />
            <input
              autoFocus
              role="combobox"
              aria-controls="command-results"
              aria-expanded="true"
              aria-activedescendant={
                choices.length ? `command-choice-${active}` : undefined
              }
              placeholder={
                onAdd ? "Search nodes and editor commands…" : "Search commands…"
              }
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={key}
            />
            <kbd>ESC</kbd>
          </div>
          <div
            ref={resultsRef}
            id="command-results"
            className="command-results"
            role="listbox"
          >
            {choices.length ? (
              choices.map((item, index) => {
                const heading = item.group !== lastGroup;
                lastGroup = item.group;
                const Icon = item.icon;
                return (
                  <div key={item.id}>
                    {heading && (
                      <div className="command-group-label">{item.group}</div>
                    )}
                    <button
                      id={`command-choice-${index}`}
                      role="option"
                      aria-selected={index === active}
                      disabled={item.disabled}
                      className={index === active ? "active" : ""}
                      onMouseMove={() => setActive(index)}
                      onClick={() => activate(index)}
                    >
                      {Icon ? (
                        <span className="command-icon">
                          <Icon size={15} />
                        </span>
                      ) : (
                        <span className="command-icon">P</span>
                      )}
                      <span>
                        <b>{item.name}</b>
                        <small>{item.description}</small>
                      </span>
                      {item.category && <em>{item.category}</em>}
                    </button>
                  </div>
                );
              })
            ) : (
              <div className="command-empty">
                No matching commands or nodes.
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
