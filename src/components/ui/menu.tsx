import * as React from "react";
import * as M from "@radix-ui/react-dropdown-menu";
import * as C from "@radix-ui/react-context-menu";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

const content = "z-50 min-w-[11rem] rounded-md border bg-popover p-1 text-popover-foreground shadow-lg data-[state=open]:animate-in data-[state=open]:fade-in-0";
const item = "relative flex cursor-pointer select-none items-center gap-2 rounded px-2 py-1.5 text-[13px] outline-none data-[highlighted]:bg-secondary data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:text-muted-foreground";

export const Menu = M.Root;
export const MenuTrigger = M.Trigger;
export const MenuContent = ({ className, ...p }: React.ComponentProps<typeof M.Content>) => (
  <M.Portal><M.Content sideOffset={4} className={cn(content, className)} {...p} /></M.Portal>
);
export const MenuItem = ({ className, ...p }: React.ComponentProps<typeof M.Item>) => <M.Item className={cn(item, className)} {...p} />;
export const MenuCheck = ({ className, children, ...p }: React.ComponentProps<typeof M.CheckboxItem>) => (
  <M.CheckboxItem className={cn(item, "pl-7", className)} {...p}>
    <M.ItemIndicator className="absolute left-2"><Check className="h-3.5 w-3.5" /></M.ItemIndicator>
    {children}
  </M.CheckboxItem>
);
export const MenuSeparator = () => <M.Separator className="my-1 h-px bg-border" />;
export const MenuLabel = ({ className, ...p }: React.ComponentProps<typeof M.Label>) => <M.Label className={cn("px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground", className)} {...p} />;
export const MenuSub = M.Sub;
export const MenuSubTrigger = ({ className, ...p }: React.ComponentProps<typeof M.SubTrigger>) => <M.SubTrigger className={cn(item, className)} {...p} />;
export const MenuSubContent = ({ className, ...p }: React.ComponentProps<typeof M.SubContent>) => (
  <M.Portal><M.SubContent className={cn(content, className)} {...p} /></M.Portal>
);

export const ContextMenu = C.Root;
export const ContextMenuTrigger = C.Trigger;
export const ContextMenuContent = ({ className, ...p }: React.ComponentProps<typeof C.Content>) => (
  <C.Portal><C.Content className={cn(content, className)} {...p} /></C.Portal>
);
export const ContextMenuItem = ({ className, ...p }: React.ComponentProps<typeof C.Item>) => <C.Item className={cn(item, className)} {...p} />;
export const ContextMenuCheck = ({ className, children, ...p }: React.ComponentProps<typeof C.CheckboxItem>) => (
  <C.CheckboxItem className={cn(item, "pl-7", className)} {...p}>
    <C.ItemIndicator className="absolute left-2"><Check className="h-3.5 w-3.5" /></C.ItemIndicator>
    {children}
  </C.CheckboxItem>
);
export const ContextMenuSeparator = () => <C.Separator className="my-1 h-px bg-border" />;
export const ContextMenuSub = C.Sub;
export const ContextMenuSubTrigger = ({ className, ...p }: React.ComponentProps<typeof C.SubTrigger>) => <C.SubTrigger className={cn(item, className)} {...p} />;
export const ContextMenuSubContent = ({ className, ...p }: React.ComponentProps<typeof C.SubContent>) => (
  <C.Portal><C.SubContent className={cn(content, className)} {...p} /></C.Portal>
);
