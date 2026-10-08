import { Component, type ReactNode } from "react";
import { t } from "@/i18n";

interface Props {
  /** 变化时清除错误状态（例如切换到其他页面） */
  resetKey: string;
  children: ReactNode;
}

/** 某个页面渲染出错时只影响该区域，侧栏仍可用，可重试或切换到别的页面 */
export class ErrorBoundary extends Component<Props, { error: Error | null; key: string }> {
  state = { error: null as Error | null, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: { error: Error | null; key: string }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  componentDidCatch(error: Error) {
    console.error("[ErrorBoundary]", error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="error-page">
        <h2>{t("这个页面出错了")}</h2>
        <pre>{String(this.state.error.message || this.state.error)}</pre>
        <button className="btn primary" onClick={() => this.setState({ error: null })}>
          {t("重试")}
        </button>
      </div>
    );
  }
}
