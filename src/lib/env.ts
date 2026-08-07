import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface ComponentStatus {
  installed: boolean;
  version: string | null;
  path: string | null;
  error: string | null;
}

export interface EnvironmentReport {
  java: ComponentStatus;
  python: ComponentStatus;
  opendataloader: ComponentStatus;
  allReady: boolean;
}

export interface InstallProgress {
  component: "java" | "python" | "opendataloader";
  stage: "download" | "extract" | "install" | "verify" | "done" | "error";
  percent: number;
  message: string;
}

export type EnvComponent = "java" | "python" | "opendataloader";

/** 检测环境 */
export const checkEnvironment = (): Promise<EnvironmentReport> =>
  invoke<EnvironmentReport>("check_environment");

/** 安装指定组件：java / python / opendataloader / all；返回安装后的最新环境报告 */
export const installComponent = (component: EnvComponent | "all"): Promise<EnvironmentReport> =>
  invoke<EnvironmentReport>("install_component", { component });

/** 订阅安装进度事件 */
export const onEnvProgress = (cb: (p: InstallProgress) => void): Promise<UnlistenFn> =>
  listen<InstallProgress>("env-install-progress", (event) => cb(event.payload));
