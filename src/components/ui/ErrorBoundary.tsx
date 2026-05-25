// vibe-term — top-level React error boundary.
//
// Catches render-phase errors and recoveries that would otherwise unmount
// the entire app tree, logs them through `logger.error("react", ...)` so we
// can correlate them with backend traces, and renders a useful fallback:
//
//   ┌──────────────────────────────────────────────┐
//   │  Something went wrong                        │
//   │  Error ID: a1b2c3                            │
//   │  <one-line message>                          │
//   │  ▸ Details (collapsed)                       │
//   │  [Copy report] [Continue] [Reload]           │
//   └──────────────────────────────────────────────┘
//
// "Copy report" yields a JSON blob you can paste straight into an issue.
// "Continue" tries a soft recovery by resetting the boundary state — handy
// when the failure was localised to one component and the rest of the app
// is still healthy. "Reload" is the nuclear option.
//
// The boundary itself MUST stay a class component until React ships a
// hooks-based equivalent: `componentDidCatch` and `getDerivedStateFromError`
// have no functional twin.

import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

import { customAlphabet } from "nanoid";

import { copyText } from "@/lib/clipboard";
import { logger } from "@/lib/logger";
import { Button } from "@/components/ui/Button";

const nano6 = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 6);

export interface ErrorReport {
  id: string;
  msg: string;
  stack: string | null;
  componentStack: string | null;
  ua: string;
  ts: number;
}

export interface ErrorBoundaryFallbackProps {
  report: ErrorReport;
  onCopy: () => Promise<void>;
  onReload: () => void;
  onContinue: () => void;
  copied: boolean;
}

export interface ErrorBoundaryProps {
  children: ReactNode;
  /**
   * Render a custom fallback. Receives the structured report and the three
   * action callbacks. Useful for tests and for embedded boundaries that want
   * a smaller surface than the default panel.
   */
  fallback?: (props: ErrorBoundaryFallbackProps) => ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  componentStack: string | null;
  errorId: string;
  copied: boolean;
}

const INITIAL_STATE: ErrorBoundaryState = {
  hasError: false,
  error: null,
  componentStack: null,
  errorId: "",
  copied: false,
};

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = INITIAL_STATE;

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    // React calls this BEFORE `componentDidCatch`, so we generate the id
    // once and reuse it in both code paths.
    return {
      hasError: true,
      error,
      errorId: nano6(),
      copied: false,
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Persist the component stack for the fallback's "Details" section. We
    // also keep it in the logged payload so backend logs can correlate.
    this.setState({ componentStack: info.componentStack ?? null });
    logger.error("react", error.message || "Unknown render error", {
      stack: error.stack,
      componentStack: info.componentStack,
      // `this.state.errorId` is set by `getDerivedStateFromError` which has
      // already run by the time we get here.
      errorId: this.state.errorId,
    });
  }

  private buildReport(): ErrorReport {
    const { error, componentStack, errorId } = this.state;
    return {
      id: errorId,
      msg: error?.message ?? "Unknown error",
      stack: error?.stack ?? null,
      componentStack,
      ua:
        typeof navigator !== "undefined" && navigator.userAgent
          ? navigator.userAgent
          : "unknown",
      ts: Date.now(),
    };
  }

  private handleCopy = async (): Promise<void> => {
    const report = this.buildReport();
    const ok = await copyText(JSON.stringify(report, null, 2));
    if (ok) {
      this.setState({ copied: true });
      // Reset the "Copied!" affordance after a short while so the user can
      // tell the next click apart.
      window.setTimeout(() => {
        this.setState((s) =>
          s.errorId === report.id ? { ...s, copied: false } : s,
        );
      }, 2000);
    }
  };

  private handleReload = (): void => {
    if (typeof window !== "undefined") window.location.reload();
  };

  private handleContinue = (): void => {
    // Soft-reset: clear the boundary so its children get a fresh chance.
    // Whatever caused the error may still be there, in which case we will
    // simply re-enter this branch with a new id.
    this.setState(INITIAL_STATE);
  };

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;

    const report = this.buildReport();
    const fallbackProps: ErrorBoundaryFallbackProps = {
      report,
      onCopy: this.handleCopy,
      onReload: this.handleReload,
      onContinue: this.handleContinue,
      copied: this.state.copied,
    };

    if (this.props.fallback) return this.props.fallback(fallbackProps);
    return <DefaultFallback {...fallbackProps} />;
  }
}

function DefaultFallback({
  report,
  onCopy,
  onReload,
  onContinue,
  copied,
}: ErrorBoundaryFallbackProps) {
  return (
    <section
      role="alert"
      aria-live="assertive"
      data-testid="error-boundary-fallback"
      className="m-6 max-w-2xl rounded-xl border border-border bg-bg-elevated p-6 shadow-2xl"
    >
      <header className="mb-3">
        <h2 className="text-lg font-semibold text-zinc-100">
          Something went wrong
        </h2>
        <p className="mt-1 text-xs text-zinc-400">
          Error ID:{" "}
          <code className="font-mono text-zinc-300">{report.id}</code>
        </p>
      </header>

      <p className="mb-4 break-words text-sm text-zinc-200">{report.msg}</p>

      <details className="mb-4 rounded border border-border bg-bg-subtle p-3">
        <summary className="cursor-pointer select-none text-xs uppercase tracking-wide text-zinc-400">
          Details
        </summary>
        <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-zinc-300">
          {report.stack ?? "(no stack)"}
          {report.componentStack ? `\n\nComponent stack:${report.componentStack}` : ""}
        </pre>
      </details>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            void onCopy();
          }}
          aria-label="Copy error report to clipboard"
        >
          {copied ? "Copied!" : "Copy report"}
        </Button>
        <Button variant="subtle" size="sm" onClick={onContinue}>
          Continue
        </Button>
        <Button variant="danger" size="sm" onClick={onReload}>
          Reload
        </Button>
      </div>
    </section>
  );
}

export default ErrorBoundary;
