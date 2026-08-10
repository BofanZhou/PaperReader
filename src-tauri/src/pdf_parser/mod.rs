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

use crate::env_manager::app_data_dir;

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
pub(crate) fn papers_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_data_dir(app)?.join("papers");
    fs::create_dir_all(&dir).map_err(|e| format!("创建 papers 目录失败: {}", e))?;
    Ok(dir)
}

/// 由 pdf 路径生成稳定 uuid（同一 PDF 复用缓存，避免重复解析）
pub(crate) fn pdf_uuid(pdf_path: &str) -> String {
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
                    // 锁毒化时跳过记录（不 panic；P3-1 防御）
                    if let Ok(mut g) = error_buf2.lock() {
                        let _ = g.insert(e.clone());
                    }
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

/// 读取子进程 stderr（后台线程收集，避免阻塞）。
///
/// stderr 默认上限 64KB：足够完整保留一个 Python traceback（约 2-4KB），
/// 同时避免超长 JAR 异常输出撑爆内存。Rust 端拼接错误详情时优先使用
/// stdout 中的 ERROR 行（包含完整 traceback），stderr 仅作补充兜底。
fn spawn_stderr_collector(stderr: std::process::ChildStderr) -> std::sync::Arc<std::sync::Mutex<String>> {
    let buf = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let buf2 = buf.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            // 锁毒化时丢弃本行（P3-1 防御，不 panic）
            if let Ok(mut b) = buf2.lock() {
                if b.len() < 65536 {
                    b.push_str(&line);
                    b.push('\n');
                }
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

/// 同一 PDF 的并发解析互斥锁。
///
/// 当用户连续点击「重试」或切换文件再切回同一 PDF 时，避免两个 Python
/// 进程同时写 `papers/{uuid}/parsed.json` 导致 race condition。
/// 用 `tokio::sync::Mutex`（异步友好）按 uuid 分桶；用 std::sync::OnceLock 做
/// 全局静态初始化（Rust 1.70+ 内置，无需 once_cell 依赖）。
static PARSE_LOCKS: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<tokio::sync::Mutex<()>>>>,
> = std::sync::OnceLock::new();

fn lock_for(uuid: &str) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    let map = PARSE_LOCKS
        .get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    // 锁毒化时兜底：退化为独立锁（P3-1 防御，不 panic）
    let Ok(mut map) = map.lock() else {
        return std::sync::Arc::new(tokio::sync::Mutex::new(()));
    };
    map.entry(uuid.to_string())
        .or_insert_with(|| std::sync::Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

/// 解析 PDF：输入路径，输出 ParsedResult（含缓存与进度事件）
#[tauri::command]
pub async fn parse_pdf(app: AppHandle, pdf_path: String) -> Result<ParsedResult, String> {
    // 0. 前置检查
    if !Path::new(&pdf_path).exists() {
        return Err("ENV:PDF_NOT_FOUND".into());
    }

    // 0.5 同 PDF 并发互斥：第二个调用方会等待第一个完成（解析结果会被缓存，
    // 等第一个完成时第二个能直接命中缓存，几乎无感）。
    let uuid = pdf_uuid(&pdf_path);
    let lock = lock_for(&uuid);
    let _guard = lock.lock().await;

    // 1. papers/{uuid}/ 目录 + PDF 副本（工程补充文档 §2.1 [copying] + §4.1）
    //    副本在缓存检查前复制：缓存命中时也要保证副本存在（源文件可能已被移动）。
    //    幂等：副本已存在则跳过。
    let paper_dir = papers_dir(&app)?.join(&uuid);
    fs::create_dir_all(&paper_dir).map_err(|e| e.to_string())?;
    let work_dir = paper_dir.join("work");
    let original_pdf = paper_dir.join("original.pdf");
    if !original_pdf.exists() {
        fs::copy(&pdf_path, &original_pdf).map_err(|e| format!("复制 PDF 副本失败: {}", e))?;
    }
    // 解析统一用副本（源路径仅用于 uuid 计算，保持不变）
    let parse_source = if original_pdf.exists() {
        original_pdf.to_string_lossy().to_string()
    } else {
        pdf_path.clone()
    };

    // 2. 缓存：papers/{uuid}/parsed.json
    //    命中直接返回，无需环境检测（读缓存不依赖解析引擎）。
    let out_json = paper_dir.join("parsed.json");
    if out_json.exists() {
        // 缓存反序列化失败时降级重新解析（Python/Rust 字段命名变化时会触发）。
        // 只有序列化成功才直接返回，避免被旧缓存卡住。
        if let Ok(raw) = fs::read_to_string(&out_json) {
            if let Ok(mut result) = serde_json::from_str::<ParsedResult>(&raw) {
                // 旧版本缓存里 imageSrc 可能是相对 work_dir 的路径（如 _images/x.png）。
                // 补全为绝对路径，保证前端 convertFileSrc 能加载。
                for page in &mut result.pages {
                    for el in &mut page.elements {
                        if let Some(src) = &el.image_src {
                            let p = Path::new(src);
                            if !p.is_absolute() {
                                el.image_src = Some(work_dir.join(src).to_string_lossy().to_string());
                            }
                        }
                    }
                }
                return Ok(result);
            }
            // 旧缓存格式不匹配，丢弃并重新解析
            let _ = fs::remove_file(&out_json);
        }
    }

    // 3. 环境检测（进程级 TTL 缓存；代码审查 P4：不再每次解析都探测子进程）
    let env = crate::env_manager::check_environment_cached(&app, Duration::from_secs(30))
        .map_err(|e| e.to_string())?;
    if !env.opendataloader.installed {
        return Err("ENV:OPENDATALOADER_NOT_READY".into());
    }

    // 1.5 清理上次失败遗留的 ERROR_*.log，避免本次解析失败时误读旧内容。
    // ERROR_*.log 由 Python 端在 except 兜底写入；本次解析前清掉，保证只反映本次错误。
    if let Ok(entries) = fs::read_dir(&paper_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("ERROR_") && name.ends_with(".log") {
                let _ = fs::remove_file(entry.path());
            }
        }
    }

    // 2. Python（进程级 TTL 缓存，避免每次解析探测）
    let Some(python) = crate::env_manager::pick_python_cached(&app, Duration::from_secs(30)) else {
        return Err("ENV:PYTHON_NOT_READY".into());
    };

    // 3. 构造命令：python parse_pdf.py <pdf> <paper_dir> <work_dir>
    let script = script_path(&app)?;
    fs::create_dir_all(&work_dir).map_err(|e| e.to_string())?;

    let mut cmd = python.command();
    cmd.arg(&script)
        .arg(&parse_source)
        .arg(&paper_dir)
        .arg(&work_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // P2-1：Windows 静默——禁止子进程弹出控制台窗口
    //（CREATE_NO_WINDOW = 0x08000000；无此标志时 GUI 应用 spawn 的控制台
    //  子进程可能新建黑色窗口闪现）
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    // 5. 启动 + 进度/错误收集
    let mut child = cmd.spawn().map_err(|e| format!("启动解析失败: {}", e))?;
    let stdout = child.stdout.take().ok_or("无法获取子进程 stdout")?;
    let stderr = child.stderr.take().ok_or("无法获取子进程 stderr")?;
    let (stdout_error, _stdout_rx) = spawn_stdout_reader(app.clone(), stdout);
    let stderr_buf = spawn_stderr_collector(stderr);

    // 6. 等待完成（含超时）
    let started = Instant::now();
    let status = loop {
        if started.elapsed() > PARSE_TIMEOUT {
            let _ = child.kill();
            return Err("ERR:TIMEOUT".into());
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            // 非阻塞轮询：tokio::time::sleep 挂起当前任务而非阻塞线程
            // （代码审查 P4：原 std::thread::sleep 会卡住 async runtime）
            Ok(None) => tokio::time::sleep(Duration::from_millis(200)).await,
            Err(e) => return Err(format!("等待解析进程失败: {}", e)),
        }
    };

    // 7. 失败处理：优先使用 stdout ERROR 行的完整 traceback，stderr / ERROR.log 作补充
    if !status.success() {
        // 锁毒化时退化为空（不 panic，P3-1 防御）
        let mut detail = match stdout_error.lock() {
            Ok(mut g) => g.take().unwrap_or_default(),
            Err(_) => String::new(),
        };
        if detail.is_empty() {
            if let Ok(g) = stderr_buf.lock() {
                let t = g.trim();
                if !t.is_empty() {
                    detail = t.to_string();
                }
            }
        }
        // 终极兜底：Python 写到 paper_dir/ERROR_*.log（绕开 pipe）。当上述 stdout / stderr
        // 都因 Tauri pipe broken 而丢失时，这个文件包含完整错误详情。Python 端用时间戳
        // 命名避免同秒覆盖；这里取最新一个。
        if detail.is_empty() {
            if let Ok(entries) = fs::read_dir(&paper_dir) {
                let mut err_logs: Vec<_> = entries
                    .flatten()
                    .filter(|e| {
                        let n = e.file_name();
                        let n = n.to_string_lossy();
                        n.starts_with("ERROR_") && n.ends_with(".log")
                    })
                    .collect();
                err_logs.sort_by_key(|e| e.file_name());
                if let Some(latest) = err_logs.last() {
                    if let Ok(content) = fs::read_to_string(latest.path()) {
                        detail = content.trim().to_string();
                    }
                }
            }
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

/// 返回论文解析副本 papers/{uuid}/original.pdf 的绝对路径
/// （供「原图视图」用 pdfjs 渲染；源 PDF 可能已被移动，副本始终存在）。
#[tauri::command]
pub fn get_paper_pdf_path(app: AppHandle, pdf_path: String) -> Result<String, String> {
    let uuid = pdf_uuid(&pdf_path);
    let p = papers_dir(&app)?.join(&uuid).join("original.pdf");
    if p.exists() {
        Ok(p.to_string_lossy().to_string())
    } else {
        Err("ERR:PARSE_NOT_FOUND:论文尚未解析".into())
    }
}

/// 返回论文的稳定 uuid（与 pdf_uuid 一致）。
/// 前端用它作为 SQLite papers 表主键，将解析结果落库（Prompt 9/10 数据库前置）。
#[tauri::command]
pub fn get_paper_uuid(pdf_path: String) -> String {
    pdf_uuid(&pdf_path)
}

/// 读取论文 AI 重排产物 papers/{uuid}/restructured.md。
/// 不存在、或 parsed.json 已变化（restructured.hash 不匹配）时返回
/// Err("NOT_FOUND")——前端据此触发重新重排（P1-2 缓存失效）。
#[tauri::command]
pub fn get_restructured_doc(app: AppHandle, pdf_path: String) -> Result<String, String> {
    let uuid = pdf_uuid(&pdf_path);
    let paper_dir = papers_dir(&app)?.join(&uuid);
    let p = paper_dir.join("restructured.md");
    if !p.exists() {
        return Err("NOT_FOUND".into());
    }
    // P1-2：缓存失效检测——parsed.json 变化后旧重排文档视为无效
    let hash_path = paper_dir.join("restructured.hash");
    let parsed_raw = std::fs::read_to_string(paper_dir.join("parsed.json"))
        .map_err(|_| "NOT_FOUND".to_string())?;
    let source_hash = crate::ai::translate::simple_hash(&parsed_raw);
    let hash_ok = std::fs::read_to_string(&hash_path)
        .map(|h| h.trim() == source_hash)
        .unwrap_or(false);
    if !hash_ok {
        return Err("NOT_FOUND".into());
    }
    std::fs::read_to_string(&p).map_err(|e| format!("读取重排文档失败: {}", e))
}

/// 读取论文图片为 base64（AI 重排 [图N] 渲染用）。
///
/// 为什么不用 convertFileSrc/asset 协议：Windows 上 asset 协议对反斜杠 URL
/// 的 scope 匹配不稳定（原图视图 PDF 403 同根因），改用 IPC 直传 base64
/// 100% 可靠。路径校验限定在 papers 目录内（防任意文件读取）。
#[tauri::command]
pub fn read_image_base64(app: AppHandle, path: String) -> Result<String, String> {
    // 路径必须在 papers 目录内
    let papers = papers_dir(&app)?;
    let canon = std::fs::canonicalize(&path).map_err(|e| format!("图片不存在: {}", e))?;
    let papers_canon = papers
        .canonicalize()
        .map_err(|e| format!("无法定位论文目录: {}", e))?;
    if !canon.starts_with(&papers_canon) {
        return Err("非法路径：图片必须在论文目录内".into());
    }
    let data = std::fs::read(&canon).map_err(|e| format!("读取图片失败: {}", e))?;
    if data.is_empty() {
        return Err("图片内容为空".into());
    }
    if data.len() > 8 * 1024 * 1024 {
        return Err("图片超过 8MB".into());
    }
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
    // 附带 MIME（按扩展名，简单处理）
    let ext = canon
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let mime = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "image/png",
    };
    Ok(format!("data:{mime};base64,{b64}"))
}

/// 读取论文原 PDF 为 base64（原图视图 pdfjs 加载用）。
///
/// 与 read_image_base64 同理：asset 协议对 Windows 反斜杠 URL 的 scope 匹配
/// 不稳定（收紧 scope 后 original.pdf 加载 403），改用 IPC 直传 100% 可靠。
/// 路径校验限定在 papers 目录内（防任意文件读取）。PDF 可能较大，上限 200MB
/// （原图视图本身有 MAX_PDF_PAGES=800 防御，此处兜底防超大文件撑爆内存）。
#[tauri::command]
pub fn read_pdf_base64(app: AppHandle, path: String) -> Result<String, String> {
    let papers = papers_dir(&app)?;
    let canon = std::fs::canonicalize(&path).map_err(|e| format!("PDF 不存在: {}", e))?;
    let papers_canon = papers
        .canonicalize()
        .map_err(|e| format!("无法定位论文目录: {}", e))?;
    if !canon.starts_with(&papers_canon) {
        return Err("非法路径：PDF 必须在论文目录内".into());
    }
    let data = std::fs::read(&canon).map_err(|e| format!("读取 PDF 失败: {}", e))?;
    if data.is_empty() {
        return Err("PDF 内容为空".into());
    }
    if data.len() > 200 * 1024 * 1024 {
        return Err("PDF 超过 200MB".into());
    }
    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(&data))
}

/// 获取最新的解析错误日志文件路径（供前端“查看详细日志”按钮使用）
#[tauri::command]
pub fn get_last_parse_log(app: AppHandle) -> Result<String, String> {
    let logs_dir = app_data_dir(&app)?.join("logs");
    if !logs_dir.exists() {
        return Err("日志目录不存在".into());
    }

    let mut entries: Vec<(std::time::SystemTime, PathBuf)> = fs::read_dir(&logs_dir)
        .map_err(|e| format!("读取日志目录失败: {}", e))?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_name()
                .to_str()
                .map(|n| n.starts_with("parse_error_") && n.ends_with(".log"))
                .unwrap_or(false)
        })
        .filter_map(|e| {
            let modified = e.metadata().ok()?.modified().ok()?;
            Some((modified, e.path()))
        })
        .collect();

    entries.sort_by(|a, b| b.0.cmp(&a.0)); // 最新的在前

    entries
        .first()
        .map(|(_, p)| p.to_string_lossy().to_string())
        .ok_or_else(|| "未找到解析错误日志".into())
}
