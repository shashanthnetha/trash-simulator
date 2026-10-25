// Trash Simulator – catches render errors and shows them instead of a blank screen.
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
  info: string;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: "" };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ error, info: info.componentStack ?? "" });
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    const text = `${this.state.error.message}\n${this.state.error.stack ?? ""}\n${this.state.info}`;
    return (
      <div className="fixed inset-0 z-[999] flex items-center justify-center bg-[#06202e] p-6 text-white">
        <div className="w-full max-w-lg rounded-2xl border border-red-400/40 bg-[#0b2a3a] p-5 shadow-2xl">
          <div className="mb-2 text-lg font-bold text-red-300">
            Oops – something went wrong
          </div>
          <p className="mb-3 text-sm text-white/80">
            The game hit an unexpected error. Reload the page – if the problem
            persists, the error text below helps track it down:
          </p>
          <pre className="scroll-thin mb-4 max-h-48 select-text overflow-auto whitespace-pre-wrap rounded-lg bg-black/40 p-3 text-[11px] leading-snug text-red-200">
            {text}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-xl bg-cyan-500 px-4 py-2 text-sm font-bold text-[#04222e] hover:bg-cyan-400"
          >
            Reload page
          </button>
        </div>
      </div>
    );
  }
}
