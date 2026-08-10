/**
 * lib/errorLog.ts —— 前端错误日志（Prompt 10 §8）
 * 把未捕获异常 / 渲染错误写入 %APPDATA%/com.paperreader.app/logs/app.log，
 * 便于发布版本地调试。写入失败静默（不影响主流程）。
 */
import { invoke } from "@tauri-apps/api/core";

let pending: Promise<void> = Promise.resolve();

/** 追加一条日志（串行队列，避免并发 IPC 乱序） */
export function logError(tag: string, err: unknown): void {
  const text = err instanceof Error ? `${err.message}${err.stack ? `\n${err.stack}` : ""}` : String(err);
  // 只取前 2000 字符，防止异常堆栈撑爆日志
  const msg = `[${tag}] ${text.slice(0, 2000)}`;
  pending = pending
    .then(() => invoke("append_app_log", { message: msg }))
    .then(() => undefined)
    .catch(() => {
      /* 日志写入失败不影响应用 */
    });
}

/** 安装全局未捕获异常监听（main.tsx 调用一次） */
export function installGlobalErrorLogging(): void {
  window.addEventListener("error", (e) => {
    if (e.error) logError("window.onerror", e.error);
    else if (e.message) logError("window.onerror", e.message);
  });
  window.addEventListener("unhandledrejection", (e) => {
    logError("unhandledrejection", e.reason ?? e);
  });
}
