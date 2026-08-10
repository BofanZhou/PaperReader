import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "./ui/button";
import { redactSensitive } from "../lib/utils";
import { logError } from "../lib/errorLog";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 本地日志（Prompt 10 §8）：错误 + 组件栈写入 logs/app.log，发布版可定位
    console.error("[ErrorBoundary]", error, info.componentStack);
    logError("ErrorBoundary", `${error}\ncomponentStack: ${info.componentStack ?? ""}`);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
          <AlertTriangle className="size-12 text-error" />
          <div>
            <p className="text-base font-medium">应用出错了</p>
            <p className="mt-1 max-w-md text-sm text-fg-secondary">
              {/* P3-10：渲染路径也要脱敏（console 已脱敏，此处补 UI 展示） */}
              {this.state.error?.message ? redactSensitive(this.state.error.message) : "未知错误"}
            </p>
          </div>
          <Button
            onClick={() => {
              this.setState({ hasError: false, error: null });
              window.location.reload();
            }}
          >
            <RotateCcw /> 重新加载
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
