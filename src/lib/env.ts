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

// ========== PDF 解析（Prompt 2） ==========

export interface Bbox {
  left: number;
  bottom: number;
  right: number;
  top: number;
}

export type ElementType =
  | "paragraph"
  | "heading"
  | "caption"
  | "table"
  | "figure"
  | "formula";

export interface ParsedElement {
  id: string;
  type: ElementType;
  bbox: Bbox;
  text: string;
  font: string | null;
  fontSize: number | null;
  headingLevel: number | null;
  readingOrder: number;
  imageSrc: string | null;
}

export interface ParsedPage {
  pageNumber: number;
  width: number;
  height: number;
  elements: ParsedElement[];
}

export interface ParsedResult {
  pdfPath: string;
  title: string | null;
  author: string | null;
  pages: ParsedPage[];
}

export interface ParseProgress {
  stage: "starting" | "parsing" | "converting" | "done";
  percent: number;
  message: string;
}

/** 解析 PDF（Rust 端自动缓存，重复解析同一 PDF 直接返回缓存） */
export const parsePdf = (pdfPath: string): Promise<ParsedResult> =>
  invoke<ParsedResult>("parse_pdf", { pdfPath });

/** 订阅解析进度事件 */
export const onPdfProgress = (cb: (p: ParseProgress) => void): Promise<UnlistenFn> =>
  listen<ParseProgress>("pdf-parse-progress", (event) => cb(event.payload));

/** 获取最新的解析错误日志文件路径 */
export const getLastParseLog = (): Promise<string> => invoke<string>("get_last_parse_log");

// ========== Prompt 9 存储管理 / 导出（Rust 命令封装） ==========

/** 删除论文缓存目录 papers/{uuid}（单篇删除） */
export const deletePaperDir = (uuid: string): Promise<void> =>
  invoke<void>("delete_paper_dir", { uuid });

/** 统计 papers 缓存目录总大小（字节） */
export const papersCacheSize = (): Promise<number> => invoke<number>("papers_cache_size");

/** 读取系统 CJK 字体（base64，导出翻译 PDF 嵌入用） */
export const readSystemFont = (): Promise<string> => invoke<string>("read_system_font");
