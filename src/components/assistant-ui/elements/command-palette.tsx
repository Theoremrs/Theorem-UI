// SOURCING: assistant-ui command-palette element (copied from its registry source, extended in place)
"use client";

// assistant-ui's command-palette element (https://www.assistant-ui.com/elements/command-palette),
// copied from its registry source. Theorem's changes: a command may carry an
// icon, a faint hint after its label, words the search matches but the row
// does not show, and a check for the one that is in effect; its keys are
// optional; the search mark is Theorem's; `paletteMatches` is exported so a
// host can tell which command a query leaves first.

import { useEffect, useId, type ComponentProps, type ReactNode } from "react";
import { Icon } from "@/components/icons";
import { cn } from "@/lib/utils";
import { field, floating, mono } from "./surfaces";

export interface PaletteCommand {
  id: string;
  label: string;
  group: string;
  keys?: readonly string[];
  /** Theorem: drawn before the label. */
  icon?: ReactNode;
  /** Theorem: faint text after the label, and searched. */
  hint?: string;
  /** Theorem: words the search matches but the row does not show. */
  keywords?: string;
  /** Theorem: a check after the label, for the command in effect. */
  active?: boolean;
}

const optionId = (listId: string, id: string) => `${listId}-${id}`;

/** The commands a query keeps, in the order the palette shows them. */
export function paletteMatches(
  commands: readonly PaletteCommand[],
  query: string,
): PaletteCommand[] {
  const needle = query.toLowerCase();
  const matches = commands.filter((command) =>
    [command.label, command.hint, command.keywords]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(needle),
  );
  const groups = [...new Set(matches.map((command) => command.group))];
  return groups.flatMap((group) =>
    matches.filter((command) => command.group === group),
  );
}

export function CommandPalette({
  commands,
  query,
  activeId,
  onQueryChange,
  onActiveChange,
  onRun,
  placeholder = "Type a command",
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  | "children"
  | "commands"
  | "query"
  | "activeId"
  | "onQueryChange"
  | "onActiveChange"
  | "onRun"
> & {
  commands: readonly PaletteCommand[];
  query: string;
  activeId: string;
  onQueryChange?: (query: string) => void;
  onActiveChange?: (id: string) => void;
  onRun?: (id: string) => void;
  placeholder?: string;
}) {
  const listId = useId();
  // display order, which is grouped and so differs from the filter order
  const ordered = paletteMatches(commands, query);
  const groups = [...new Set(ordered.map((command) => command.group))];

  const move = (delta: number) => {
    if (ordered.length === 0) return;
    const at = ordered.findIndex((command) => command.id === activeId);
    // activeId can be filtered out by the query; start from the edge the key implies
    const from = at === -1 ? (delta > 0 ? -1 : 0) : at;
    const next = ordered[(from + delta + ordered.length) % ordered.length];
    if (next && onActiveChange) onActiveChange(next.id);
  };

  // aria-activedescendant moves the highlight without moving focus, and only
  // focus scrolls; the list is short enough to walk the active row out of view.
  useEffect(() => {
    document
      .getElementById(optionId(listId, activeId))
      ?.scrollIntoView({ block: "nearest" });
  }, [activeId, listId]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
      return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const active = ordered.find((command) => command.id === activeId);
      if (active && onRun) onRun(active.id);
    }
  };

  return (
    <div
      data-slot="command-palette"
      className={cn(
        floating,
        "flex w-full max-w-sm flex-col overflow-hidden rounded-[20px]",
        className,
      )}
      {...props}
    >
      <div className="flex items-center gap-2.5 px-3.5 py-3">
        <Icon.Search className="text-muted-foreground size-3.5 shrink-0" />
        <input
          value={query}
          onChange={(event) => onQueryChange?.(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label={placeholder}
          role="combobox"
          aria-expanded={ordered.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            ordered.some((command) => command.id === activeId)
              ? optionId(listId, activeId)
              : undefined
          }
          className="text-foreground/85 placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-[13.5px] outline-none"
        />
        <span
          className={cn(
            field,
            mono,
            "text-muted-foreground rounded px-1.5 py-0.5",
          )}
        >
          esc
        </span>
      </div>

      <div
        id={listId}
        role="listbox"
        aria-label="Commands"
        className="border-foreground/[0.07] flex max-h-72 flex-col overflow-y-auto border-t p-1.5"
      >
        {groups.map((group) => (
          <div
            key={group}
            role="group"
            aria-label={group}
            className="flex flex-col"
          >
            <span
              aria-hidden
              className={cn(mono, "text-muted-foreground px-2 pt-2 pb-1")}
            >
              {group}
            </span>
            {ordered
              .filter((command) => command.group === group)
              .map((command) => {
                const className = cn(
                  "flex items-center gap-2 rounded-xl px-2 py-1.5 text-start transition-colors",
                  command.id === activeId
                    ? "bg-foreground/[0.06]"
                    : onRun
                      ? "hover:bg-foreground/[0.03]"
                      : undefined,
                );
                const content = (
                  <>
                    {command.icon}
                    <span className="min-w-0 truncate text-[13px]">
                      {command.label}
                    </span>
                    <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                      {command.hint}
                    </span>
                    {command.active && (
                      <Icon.Check className="text-muted-foreground size-3.5 shrink-0" />
                    )}
                    {command.keys && command.keys.length > 0 && (
                      <span className="flex shrink-0 gap-1">
                        {command.keys.map((key) => (
                          <span
                            key={key}
                            className={cn(
                              field,
                              mono,
                              "text-muted-foreground rounded px-1.5 py-0.5",
                            )}
                          >
                            {key}
                          </span>
                        ))}
                      </span>
                    )}
                  </>
                );

                return onRun ? (
                  <button
                    key={command.id}
                    id={optionId(listId, command.id)}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={command.id === activeId}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseMove={() =>
                      command.id !== activeId && onActiveChange?.(command.id)
                    }
                    onClick={() => onRun(command.id)}
                    className={className}
                  >
                    {content}
                  </button>
                ) : (
                  <div
                    key={command.id}
                    id={optionId(listId, command.id)}
                    role="option"
                    aria-selected={command.id === activeId}
                    className={className}
                  >
                    {content}
                  </div>
                );
              })}
          </div>
        ))}
      </div>
      {ordered.length === 0 && (
        <div className="border-foreground/[0.07] border-t p-1.5">
          <span className="text-muted-foreground block px-2 py-4 text-center text-xs break-words">
            No command matches “{query}”
          </span>
        </div>
      )}
    </div>
  );
}
