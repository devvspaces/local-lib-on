import * as React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";

/** Icon-only toolbar button with tooltip + optional shortcut hint. */
export const ToolButton = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; shortcut?: string; active?: boolean }
>(({ label, shortcut, active, className, children, ...props }, ref) => (
  <Tooltip.Root>
    <Tooltip.Trigger asChild>
      <button
        ref={ref}
        aria-label={label}
        aria-pressed={active}
        className={cn(
          "inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40 disabled:pointer-events-none cursor-pointer [&_svg]:size-4",
          active && "bg-accent text-accent-foreground hover:bg-accent",
          className
        )}
        {...props}
      >
        {children}
      </button>
    </Tooltip.Trigger>
    <Tooltip.Portal>
      <Tooltip.Content side="bottom" sideOffset={6} className="z-50 rounded-md bg-foreground px-2 py-1 text-[11px] text-background shadow-md">
        {label}
        {shortcut && <span className="ml-2 opacity-60 font-mono">{shortcut}</span>}
      </Tooltip.Content>
    </Tooltip.Portal>
  </Tooltip.Root>
));
ToolButton.displayName = "ToolButton";
