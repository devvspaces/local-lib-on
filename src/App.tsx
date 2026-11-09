import { ThemeProvider } from "@/components/ThemeProvider";
import { Layout } from "@/components/Layout";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { TooltipProvider } from "@radix-ui/react-tooltip";

export default function App() {
  return (
    <ThemeProvider defaultTheme="system" storageKey="local-lib-theme">
      <TooltipProvider delayDuration={400}>
        <ErrorBoundary label="the app"><Layout /></ErrorBoundary>
      </TooltipProvider>
    </ThemeProvider>
  );
}
