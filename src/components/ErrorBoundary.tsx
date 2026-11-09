import { Component, type ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

/** Catches render errors so one broken view shows a message instead of blanking the whole window. */
export class ErrorBoundary extends Component<{ children: ReactNode; label?: string; resetKey?: unknown }, { error: Error | null; resetKey?: unknown }> {
  state: { error: Error | null; resetKey?: unknown } = { error: null, resetKey: this.props.resetKey };
  static getDerivedStateFromError(error: Error) { return { error }; }
  static getDerivedStateFromProps(p: { resetKey?: unknown }, s: { resetKey?: unknown; error: Error | null }) {
    return p.resetKey !== s.resetKey ? { error: null, resetKey: p.resetKey } : null;
  }
  componentDidCatch(error: Error, info: { componentStack?: string | null }) { console.error("[ErrorBoundary]", this.props.label, error, info.componentStack); }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" className="flex h-full w-full flex-col items-center justify-center gap-3 p-8 text-center">
        <AlertTriangle className="h-8 w-8 text-destructive" />
        <p className="font-semibold">Something went wrong{this.props.label ? ` in ${this.props.label}` : ""}</p>
        <pre className="max-w-xl whitespace-pre-wrap rounded-md bg-secondary px-3 py-2 text-left text-xs text-muted-foreground">{error.message}</pre>
        <button onClick={() => this.setState({ error: null })} className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm hover:bg-secondary cursor-pointer"><RotateCcw className="h-3.5 w-3.5" /> Try again</button>
      </div>
    );
  }
}
