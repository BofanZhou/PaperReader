//! PDF 解析模块（Prompt 2）
//!
//! 调用 OpenDataLoader（经 Python 包装脚本 parse_pdf.py）解析 PDF，
//! 转换为统一内部格式 ParsedResult，缓存到 papers/{uuid}/parsed.json。
//!
//! 错误码约定（前端据此引导用户）：
//! - `ENV:PDF_NOT_FOUND`         文件不存在
//! - `ENV:PYTHON_NOT_READY`      Python 未安装
//! - `ENV:OPENDATALOADER_NOT_READY` OpenDataLoader 未安装（引导环境安装）
//! - `ERR:TIMEOUT`               解析超时（>10 分钟，大文件建议分段）
//! - `ERR:SCANNED_PDF`           疑似扫描版（无文本，建议启用 hybrid 模式）
//! - 其他                        解析失败详情

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

use crate::env_manager::{app_data_dir, pick_python};

// ========== 数据结构（与 parse_pdf.py 输出一致，camelCase） ==========

/// 解析结果（对应前端 ParsedResult）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedResult {
    pub pdf_path: String,
    pub title: Option<String>,
    pub author: Option<String>,
    pub pages: Vec<ParsedPage>,
}

/// 单页（width/height 为 PDF 坐标，BOTTOM-LEFT 原点）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedPage {
    pub page_number: u32,
    pub width: f32,
    pub height: f32,
    pub elements: Vec<ParsedElement>,
}

/// 版面元素
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedElement {
    pub id: String,
    #[serde(rename = "type")]
    pub element_type: String, // paragraph | heading | caption | table | figure | formula
    pub bbox: Bbox,
    pub text: String,
    pub font: Option<String>,
    pub font_size: Option<f32>,
    pub heading_level: Option<u32>,
    pub reading_order: u32,
    pub image_src: Option<String>,
}

/// PDF 坐标 bbox（BOTTOM-LEFT 原点，单位 pt）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bbox {
    pub left: f32,
    pub bottom: f32,
    pub right: f32,
    pub top: f32,
}

/// 解析进度事件载荷
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseProgress {
    pub stage: String, // starting | parsing | converting | done
    pub percent: u8,
    pub message: String,
}

const PARSE_EVENT: &str = "pdf-parse-progress";
const PARSE_TIMEOUT: Duration = Duration::from_secs(600);

/// stdout 协议中的结果/错误类型
enum ScriptLine {
    Progress(ParseProgress),
    Error(String),
    Output(String),
}

// ========== 路径与工具 ==========

/// papers 根目录（%APPDATA%/com.paperreader.app/papers）
fn papers_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_data_dir(app)?.join("papers");
    fs::create_dir_all(&dir).map_err(|e| format!("创建 papers 目录失败: {}", e))?;
    Ok(dir)
}

/// 由 pdf 路径生成稳定 uuid（同一 PDF 复用缓存，避免重复解析）
fn pdf_uuid(pdf_path: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    pdf_path.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// 定位 parse_pdf.py 的候选路径（按优先级查找）：
/// 1. 进程当前工作目录的 scripts/（cargo run / dev 启动时）
/// 2. 可执行文件同目录的 scripts/（build.rs 复制过去的，双击 exe 启动时）
/// 3. Tauri 资源目录下的 scripts/（bundle.resources 配置生效后）
/// 4. 用户级 app_data_dir/scripts/（手动复制兜底）
fn script_path(app: &AppHandle) -> Result<PathBuf, String> {
    let script_name = "parse_pdf.py";

    // 1. 当前工作目录的 scripts/parse_pdf.py
    if let Ok(cwd) = std::env::current_dir() {
        let p = cwd.join("scripts").join(script_name);
        if p.exists() {
            return Ok(p);
        }
    }

    // 2. 可执行文件同目录的 scripts/parse_pdf.py（build.rs 已自动复制）
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join("scripts").join(script_name);
            if p.exists() {
                return Ok(p);
            }
        }
    }

    // 3. Tauri 资源目录下的 scripts/
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("scripts").join(script_name);
        if p.exists() {
            return Ok(p);
        }
    }

    // 4. CARGO_MANIFEST_DIR（仅 cargo run 时有效，兜底）
    if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
        let p = Path::new(&manifest).join("scripts").join(script_name);
        if p.exists() {
            return Ok(p);
        }
    }

    Err(format!(
        "找不到 {script_name}。已搜索：当前目录、exe 同目录、Tauri 资源目录、CARGO_MANIFEST_DIR"
    ))
}

/// 解析脚本 stdout 的一行
fn parse_script_line(line: &str) -> Option<ScriptLine> {
    if let Some(rest) = line.strip_prefix("PROGRESS ") {
        let mut parts = rest.splitn(3, ' ');
        let stage = parts.next()?.to_string();
        let percent = parts.next()?.parse().unwrap_or(0);
        let message = parts.next().unwrap_or("").to_string();
        return Some(ScriptLine::Progress(ParseProgress { stage, percent, message }));
    }
    if let Some(rest) = line.strip_prefix("ERROR ") {
        // 多行错误被替换为字面 "\n"，还原回去
        let msg = rest.replace("\\n", "\n").to_string();
        return Some(ScriptLine::Error(msg));
    }
    if let Some(rest) = line.strip_prefix("OUTPUT ") {
        return Some(ScriptLine::Output(rest.to_string()));
    }
    None
}

/// 从 stdout 读取 PROGRESS/ERROR/OUTPUT 行并转发给前端
fn spawn_stdout_reader(
    app: AppHandle,
    stdout: std::process::ChildStdout,
) -> (std::sync::Arc<std::sync::Mutex<Option<String>>>, mpsc::Receiver<ScriptLine>) {
    let error_buf = std::sync::Arc::new(std::sync::Mutex::new(None));
    let error_buf2 = error_buf.clone();
    let (tx, rx) = mpsc::channel::<ScriptLine>();

    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            match parse_script_line(&line) {
                Some(ScriptLine::Progress(p)) => {
                    let _ = app.emit(PARSE_EVENT, &p);
                    let _ = tx.send(ScriptLine::Progress(p));
                }
                Some(ScriptLine::Error(e)) => {
                    let _ = error_buf2.lock().unwrap().insert(e.clone());
                    let _ = tx.send(ScriptLine::Error(e));
                }
                Some(ScriptLine::Output(o)) => {
                    let _ = tx.send(ScriptLine::Output(o));
                }
                None => {}
            }
        }
    });

    (error_buf, rx)
}

/// 读取子进程 stderr（后台线程收集，避免阻塞）
fn spawn_stderr_collector(stderr: std::process::ChildStderr) -> std::sync::Arc<std::sync::Mutex<String>> {
    let buf = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let buf2 = buf.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let mut b = buf2.lock().unwrap();
            if b.len() < 4096 {
                b.push_str(&line);
                b.push('\n');
            }
        }
    });
    buf
}

/// 将解析失败的完整错误写入日志，便于排查；返回日志文件路径
fn log_parse_error(app: &AppHandle, pdf_path: &str, message: &str) -> Result<PathBuf, String> {
    let logs_dir = app_data_dir(app)?.join("logs");
    fs::create_dir_all(&logs_dir).map_err(|e| format!("创建日志目录失败: {}", e))?;
    let path = logs_dir.join(format!(
        "parse_error_{}.log",
        chrono::Local::now().format("%Y%m%d_%H%M%S")
    ));
    let mut f = fs::File::create(&path).map_err(|e| format!("创建日志文件失败: {}", e))?;
    writeln!(f, "PDF: {}", pdf_path).map_err(|e| e.to_string())?;
    writeln!(f, "{}", message).map_err(|e| e.to_string())?;
    Ok(path)
}

// ========== 对外命令 ==========

/// 解析 PDF：输入路径，输出 ParsedResult（含缓存与进度事件）
#[tauri::command]
pub async fn parse_pdf(app: AppHandle, pdf_path: String) -> Result<ParsedResult, String> {
    // 0. 前置检查
    if !Path::new(&pdf_path).exists() {
        return Err("ENV:PDF_NOT_FOUND".into());
    }
    let env = crate::env_manager::check_environment(app.clone()).map_err(|e| e.to_string())?;
    if !env.opendataloader.installed {
        return Err("ENV:OPENDATALOADER_NOT_READY".into());
    }

    // 1. 缓存：papers/{uuid}/parsed.json
    let paper_dir = papers_dir(&app)?.join(pdf_uuid(&pdf_path));
    fs::create_dir_all(&paper_dir).map_err(|e| e.to_string())?;
    let out_json = paper_dir.join("parsed.json");
    if out_json.exists() {
        let raw = fs::read_to_string(&out_json).map_err(|e| format!("读取缓存失败: {}", e))?;
        let result: ParsedResult =
            serde_json::from_str(&raw).map_err(|e| format!("缓存解析失败: {}", e))?;
        return Ok(result);
    }

    // 2. Python
    let Some(python) = pick_python(&app) else {
        return Err("ENV:PYTHON_NOT_READY".into());
    };

    // 3. 构造命令：python parse_pdf.py <pdf> <paper_dir> <work_dir>
    let script = script_path(&app)?;
    let work_dir = paper_dir.join("work");
    fs::create_dir_all(&work_dir).map_err(|e| e.to_string())?;

    let mut cmd = python.command();
    cmd.arg(&script)
        .arg(&pdf_path)
        .arg(&paper_dir)
        .arg(&work_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // 4. 启动 + 进度/错误收集
    let mut child = cmd.spawn().map_err(|e| format!("启动解析失败: {}", e))?;
    let stdout = child.stdout.take().ok_or("无法获取子进程 stdout")?;
    let stderr = child.stderr.take().ok_or("无法获取子进程 stderr")?;
    let (stdout_error, _stdout_rx) = spawn_stdout_reader(app.clone(), stdout);
    let stderr_buf = spawn_stderr_collector(stderr);

    // 5. 等待完成（含超时）
    let started = Instant::now();
    let status = loop {
        if started.elapsed() > PARSE_TIMEOUT {
            let _ = child.kill();
            return Err("ERR:TIMEOUT".into());
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => std::thread::sleep(Duration::from_millis(200)),
            Err(e) => return Err(format!("等待解析进程失败: {}", e)),
        }
    };

    // 6. 失败处理：优先使用 stdout ERROR 行的完整 traceback，stderr 作补充
    if !status.success() {
        let mut detail = stdout_error.lock().unwrap().take().unwrap_or_default();
        if detail.is_empty() {
            detail = stderr_buf.lock().unwrap().trim().to_string();
        }
        if detail.is_empty() {
            detail = format!("退出码 {}", status.code().unwrap_or(-1));
        }

        let log_path = log_parse_error(&app, &pdf_path, &detail)
            .unwrap_or_else(|e| PathBuf::from(format!("<无法写入日志: {}>", e)));

        // 简化前端显示：只取第一行作为标题，完整信息仍保留
        let headline = detail.lines().next().unwrap_or("解析失败").to_string();
        return Err(format!(
            "ERR:PARSE_FAILED:{headline}\n\n{detail}\n\n日志: {}",
            log_path.display()
        ));
    }

    // 7. 读取结果
    let raw = fs::read_to_string(&out_json).map_err(|e| format!("解析未产出结果文件: {}", e))?;
    let result: ParsedResult =
        serde_json::from_str(&raw).map_err(|e| format!("结果文件解析失败: {}", e))?;

    // 8. 扫描版检测：有元素但全部无文本
    let total = result.pages.iter().map(|p| p.elements.len()).sum::<usize>();
    let text_count = result
        .pages
        .iter()
        .flat_map(|p| &p.elements)
        .filter(|e| !e.text.trim().is_empty())
        .count();
    if total > 0 && text_count == 0 {
        return Err("ERR:SCANNED_PDF".into());
    }

    Ok(result)
}
