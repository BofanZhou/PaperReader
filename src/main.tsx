import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { redactSensitive } from "./lib/utils";
import { installGlobalErrorLogging } from "./lib/errorLog";

// 全局错误/日志脱敏（工程补充文档 §5.3 敏感数据处理）
// API Key 形如 sk-xxx...，任何被带到 console / 错误上报的内容都替换掉，
// 防止开发者工具或日志文件泄露 Key。实现统一在 lib/utils.ts redactSensitive。

window.addEventListener("error", (e) => {
  if (e.error?.stack) {
    e.error.stack = redactSensitive(String(e.error.stack));
  }
});

// 全局未捕获异常 → 本地日志文件（Prompt 10 §8）
installGlobalErrorLogging();

const originalWarn = console.warn;
const originalError = console.error;
console.warn = (...args: unknown[]) =>
  originalWarn(...args.map((a) => (typeof a === "string" ? redactSensitive(a) : a)));
console.error = (...args: unknown[]) =>
  originalError(...args.map((a) => (typeof a === "string" ? redactSensitive(a) : a)));

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
