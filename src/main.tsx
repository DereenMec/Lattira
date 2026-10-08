import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// 性能验证工具：开发模式，或生产构建地址带 ?perf 时按需加载，见 src/dev/perf.ts
if (import.meta.env.DEV || new URLSearchParams(location.search).has("perf")) void import("./dev/perf");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
