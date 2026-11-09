import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 cursor-pointer",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline:
          "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 rounded-md px-3",
        lg: "h-11 rounded-md px-8",
        icon: "h-10 w-10",
        xs: "h-7 rounded-md px-2 text-xs",
        "icon-sm": "h-7 w-7 [&_svg]:size-3.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
  /** Show a spinner and disable. Also set automatically while an async onClick is pending. */
  loading?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading, onClick, disabled, children, ...props }, ref) => {
    // An async onClick disables the button at once (no double starts) and shows a spinner if it takes >150 ms.
    const [pending, setPending] = React.useState(0) // 0 idle, 1 pending (disabled), 2 pending + spinner
    const alive = React.useRef(true)
    React.useEffect(() => () => { alive.current = false }, [])
    const handle = onClick && ((e: React.MouseEvent<HTMLButtonElement>) => {
      const r = onClick(e) as unknown
      if (r && typeof (r as Promise<unknown>).then === "function") {
        setPending(1)
        const t = setTimeout(() => alive.current && setPending((p) => (p ? 2 : 0)), 150)
        ;(r as Promise<unknown>).finally(() => { clearTimeout(t); if (alive.current) setPending(0) }).catch(() => {})
      }
    })
    const spin = !!loading || pending === 2
    if (asChild) {
      return <Slot className={cn(buttonVariants({ variant, size, className }))} ref={ref} onClick={handle} {...props}>{children}</Slot>
    }
    return (
      <button
        className={cn(buttonVariants({ variant, size, className }), spin && "[&>svg:not(.ll-spin)]:hidden")}
        ref={ref}
        onClick={handle}
        disabled={disabled || !!loading || pending > 0}
        aria-busy={spin || undefined}
        {...props}
      >
        {spin && <Loader2 className="ll-spin animate-spin" />}
        {children}
      </button>
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
