import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn/ui 风格 className 合并工具 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * 敏感信息脱敏（工程补充文档 §5.3 / P3-10）。
 * API Key 形如 sk-xxx...，任何进入 console / 错误上报 / UI 渲染的文本
 * 都替换掉，防止开发者工具或日志文件泄露 Key。
 * 由 main.tsx（全局 console/error）与 ErrorBoundary（渲染路径）共用。
 */
export function redactSensitive(text: string): string {
  return text.replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***");
}
