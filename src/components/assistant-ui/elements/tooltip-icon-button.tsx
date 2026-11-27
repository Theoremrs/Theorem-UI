"use client";

import { forwardRef } from "react";
import type { ComponentPropsWithRef } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type TooltipIconButtonProps = ComponentPropsWithRef<typeof Button> & {
  /** The button's name, read by assistive tech. Nothing pops up on hover or focus. */
  tooltip: string;
  /** Kept so call sites copied from upstream still type-check; unused. */
  side?: "top" | "bottom" | "left" | "right";
  /** Kept so call sites copied from upstream still type-check; unused. */
  delay?: number;
};

/**
 * assistant-ui's icon button without its tooltip: Theorem's controls carry
 * their name as screen-reader text instead of a hover popup (owner,
 * 2026-11-23 and 2026-11-24). Upstream elements import this name, so it stays.
 */
export const TooltipIconButton = forwardRef<
  HTMLButtonElement,
  TooltipIconButtonProps
>(({ children, tooltip, side: _side, delay: _delay, className, ...rest }, ref) => {
  return (
    <Button
      variant="ghost"
      size="icon"
      {...rest}
      className={cn("aui-button-icon size-6 p-1", className)}
      ref={ref}
    >
      {children}
      <span className="aui-sr-only sr-only">{tooltip}</span>
    </Button>
  );
});

TooltipIconButton.displayName = "TooltipIconButton";
