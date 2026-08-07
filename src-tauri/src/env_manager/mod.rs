//! 环境管理模块
//!
//! 负责检测 / 自动下载安装 Java、Python、OpenDataLoader 三个运行时依赖。
//! 安装进度通过 Tauri 事件 `env-install-progress` 推送至前端。

use futures_util::future::join;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// 单个组件的检测状态
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ComponentStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub error: Option<String>,
}

/// 环境检测总报告
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentReport {
    pub java: ComponentStatus,
    pub python: ComponentStatus,
    pub opendataloader: ComponentStatus,
    pub all_ready: bool,
}

impl EnvironmentReport {
    fn new(
        java: ComponentStatus,
        python: ComponentStatus,
        opendataloader: ComponentStatus,
    ) -> Self {
        let all_ready = java.installed && python.installed && opendataloader.installed;
        Self {
            java,
            python,
            opendataloader,
            all_ready,
        }
    }
}

/// 安装进度事件载荷
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    pub component: String, // "java" | "python" | "opendataloader"
    pub stage: String,     // "download" | "extract" | "install" | "verify" | "done" | "error"
    pub percent: u8,
    pub message: String,
}

const ENV_EVENT: &str = "env-install-progress";

// ========== 路径常量 ==========

const RESOURCES_DIR: &str = "resources";
const JRE_DIR: &str = "jre";
const PYTHON_DIR: &str = "python";
const TEMP_DIR: &str = "temp";

const JRE_ZIP_NAME: &str = "jre.zip";
const JRE_EXTRACT_DIR: &str = "jre_extract";
const PYTHON_ZIP_NAME: &str = "python.zip";

// ========== 下载源 ==========

// 华为云镜像（Adoptium 重定向到 GitHub，国内慢）
const JAVA_DOWNLOAD_URL: &str =
    "https://mirrors.huaweicloud.com/openjdk/17.0.2/openjdk-17.0.2_windows-x64_bin.zip";

// 华为云 Python 镜像
const PYTHON_DOWNLOAD_URL: &str =
    "https://mirrors.huaweicloud.com/python/3.11.9/python-3.11.9-embed-amd64.zip";

// get-pip 国内镜像（清华）
const GET_PIP_URL: &str = "https://mirrors.tuna.tsinghua.edu.cn/pypa/get-pip.py";

// PyPI 国内镜像
const PYPI_MIRROR: &str = "https://mirrors.huaweicloud.com/repository/pypi/simple";

// ========== 命令执行工具 ==========

/// 表示一个可执行命令（程序 + 前置参数），用于处理 `py -3` 这类带空格的命令。
#[derive(Debug, Clone)]
pub(crate) struct CmdLine {
    pub(crate) program: String,
    pub(crate) prefix_args: Vec<String>,
}

impl CmdLine {
    pub(crate) fn new(program: impl Into<String>, prefix_args: Vec<String>) -> Self {
        Self {
            program: program.into(),
            prefix_args,
        }
    }

    pub(crate) fn command(&self) -> Command {
        let mut cmd = Command::new(&self.program);
        cmd.args(&self.prefix_args);
        cmd
    }

    fn run_capture(&self, args: &[&str]) -> Result<String, String> {
        let mut cmd = self.command();
        cmd.args(args);
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

        let output = cmd.output().map_err(|e| {
            format!("无法执行 `{} {}`: {}", self.program, self.prefix_args.join(" "), e)
        })?;

        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

        if output.status.success() {
            Ok(if stdout.is_empty() { stderr } else { stdout })
        } else {
            let combined = if stdout.is_empty() {
                stderr
            } else {
                format!("{} {}", stdout, stderr)
            };
            Err(format!("命令失败 `{} {}`: {}", self.program, self.prefix_args.join(" "), combined))
        }
    }

    fn to_display(&self) -> String {
        if self.prefix_args.is_empty() {
            self.program.clone()
        } else {
            format!("{} {}", self.program, self.prefix_args.join(" "))
        }
    }
}

/// 获取应用数据目录（%APPDATA%/com.paperreader.app）
pub(crate) fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("无法获取数据目录: {}", e))
}

/// 内置运行时根目录
fn resources_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_data_dir(app)?.join(RESOURCES_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("创建 resources 目录失败: {}", e))?;
    Ok(dir)
}

/// 临时目录
fn temp_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_data_dir(app)?.join(TEMP_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("创建 temp 目录失败: {}", e))?;
    Ok(dir)
}

/// 内置 Java 可执行文件路径
fn bundled_java_exe(app: &AppHandle) -> PathBuf {
    app_data_dir(app)
        .unwrap_or_default()
        .join(RESOURCES_DIR)
        .join(JRE_DIR)
        .join("bin")
        .join("java.exe")
}

/// 内置 Python 可执行文件路径
fn bundled_python_exe(app: &AppHandle) -> PathBuf {
    app_data_dir(app)
        .unwrap_or_default()
        .join(RESOURCES_DIR)
        .join(PYTHON_DIR)
        .join("python.exe")
}

// ========== 版本解析与校验 ==========

/// 解析 Java 版本并返回 (major, 原始字符串)
fn parse_java_version(raw: &str) -> Option<(u32, String)> {
    let first = raw.lines().next()?;
    let version = first.split('"').nth(1)?;
    let major = java_major(&version)?;
    Some((major, version.to_string()))
}

/// 把 Java 版本字符串转为主版本号
fn java_major(version: &str) -> Option<u32> {
    let parts: Vec<&str> = version.split('.').collect();
    if parts.is_empty() {
        return None;
    }
    // Java 8 之前：1.x 格式
    if parts[0] == "1" && parts.len() >= 2 {
        parts[1].parse().ok()
    } else {
        parts[0].parse().ok()
    }
}

/// 判断 Java 版本是否满足要求（>= 11）
fn java_version_ok(raw: &str) -> Option<(u32, String)> {
    parse_java_version(raw).filter(|(major, _)| *major >= 11)
}

/// 解析 Python 版本输出
fn parse_python_version(raw: &str) -> String {
    raw.lines().next().map(|s| s.trim().to_string()).unwrap_or_default()
}

fn emit_progress(app: &AppHandle, p: &InstallProgress) {
    let _ = app.emit(ENV_EVENT, p.clone());
}

// ========== 检测逻辑 ==========

/// 检测 Java：系统优先，再检测内置；要求主版本 >= 11
fn detect_java(app: &AppHandle) -> ComponentStatus {
    // 1. 系统 Java（java -version 输出到 stderr，需合并 stdout+stderr）
    let system = CmdLine::new("java", vec![]);
    if let Ok(out) = system.run_capture(&["-version"]) {
            if let Some((_, version)) = java_version_ok(&out) {
            return ComponentStatus {
                installed: true,
                version: Some(version),
                path: Some(system.to_display()),
                error: None,
            };
        } else if let Some((major, version)) = parse_java_version(&out) {
            return ComponentStatus {
                installed: false,
                version: Some(version),
                path: Some(system.to_display()),
                error: Some(format!("Java 版本 {} 过低，需要 Java 11 或更高版本", major)),
            };
        }
    }

    // 2. 内置 Java
    let bundled = bundled_java_exe(app);
    if bundled.exists() {
        let bundled_cmd = CmdLine::new(
            bundled.to_str().unwrap_or("java").to_string(),
            vec![],
        );
        if let Ok(out) = bundled_cmd.run_capture(&["-version"]) {
            if let Some((_, version)) = java_version_ok(&out) {
                return ComponentStatus {
                    installed: true,
                    version: Some(version),
                    path: Some(bundled.to_string_lossy().to_string()),
                    error: None,
                };
            }
        }
    }

    ComponentStatus {
        installed: false,
        version: None,
        path: None,
        error: Some("Java 11+ 未安装".into()),
    }
}

/// 检测 Python：系统优先，再检测内置
fn detect_python(app: &AppHandle) -> ComponentStatus {
    // 1. 系统 python 优先
    for cmd in [CmdLine::new("python", vec![]), CmdLine::new("py", vec!["-3".into()])] {
        if let Ok(out) = cmd.run_capture(&["--version"]) {
            let version = parse_python_version(&out);
            if !version.is_empty() {
                return ComponentStatus {
                    installed: true,
                    version: Some(version),
                    path: Some(cmd.to_display()),
                    error: None,
                };
            }
        }
    }

    // 2. 内置 Python 兜底
    let bundled = bundled_python_exe(app);
    if bundled.exists() {
        let cmd = CmdLine::new(bundled.to_string_lossy().to_string(), vec![]);
        if let Ok(out) = cmd.run_capture(&["--version"]) {
            let version = parse_python_version(&out);
            if !version.is_empty() {
                return ComponentStatus {
                    installed: true,
                    version: Some(version),
                    path: Some(bundled.to_string_lossy().to_string()),
                    error: None,
                };
            }
        }
    }

    ComponentStatus {
        installed: false,
        version: None,
        path: None,
        error: Some("Python 未安装".into()),
    }
}

/// 选择用于安装 / 检测的 python：系统优先，其次内置（pdf_parser 也复用此逻辑）
pub(crate) fn pick_python(app: &AppHandle) -> Option<CmdLine> {
    if let Ok(out) = CmdLine::new("python", vec![]).run_capture(&["--version"]) {
        if !parse_python_version(&out).is_empty() {
            return Some(CmdLine::new("python", vec![]));
        }
    }
    if let Ok(out) = CmdLine::new("py", vec!["-3".into()]).run_capture(&["--version"]) {
        if !parse_python_version(&out).is_empty() {
            return Some(CmdLine::new("py", vec!["-3".into()]));
        }
    }
    let bundled = bundled_python_exe(app);
    if bundled.exists() {
        return Some(CmdLine::new(bundled.to_string_lossy().to_string(), vec![]));
    }
    None
}

/// 检测 OpenDataLoader（使用当前可用的 python）
fn detect_opendataloader(app: &AppHandle) -> ComponentStatus {
    let Some(python) = pick_python(app) else {
        return ComponentStatus {
            installed: false,
            version: None,
            path: None,
            error: Some("需要先安装 Python".into()),
        };
    };

    match python.run_capture(&[
        "-c",
        "from importlib.metadata import version; print(version('opendataloader-pdf'))",
    ]) {
        Ok(out) => ComponentStatus {
            installed: true,
            version: Some(out.trim().to_string()),
            path: Some(python.to_display()),
            error: None,
        },
        Err(e) => ComponentStatus {
            installed: false,
            version: None,
            path: None,
            error: Some(format!("opendataloader-pdf 未安装: {}", e)),
        },
    }
}

/// 对外命令：检测环境
#[tauri::command]
pub fn check_environment(app: AppHandle) -> Result<EnvironmentReport, String> {
    let java = detect_java(&app);
    let python = detect_python(&app);
    let opendataloader = detect_opendataloader(&app);
    Ok(EnvironmentReport::new(java, python, opendataloader))
}

/// 对外命令：安装指定组件（"java" | "python" | "opendataloader" | "all"）
#[tauri::command]
pub async fn install_component(app: AppHandle, component: String) -> Result<EnvironmentReport, String> {
    match component.as_str() {
        "java" => {
            install_java(&app).await?;
        }
        "python" => {
            install_python(&app).await?;
        }
        "opendataloader" => {
            install_opendataloader(&app).await?;
        }
        "all" => {
            // Java 和 Python 互相独立，可并发安装；OpenDataLoader 依赖 Python，需后装
            let (java_result, python_result) = join(install_java(&app), install_python(&app)).await;
            java_result?;
            python_result?;
            install_opendataloader(&app).await?;
        }
        other => return Err(format!("未知组件: {}", other)),
    }

    // 安装完成后返回最新环境报告
    check_environment(app)
}

// ========== 下载与安装工具 ==========

/// 下载文件到本地路径（带重试 + 进度事件）
async fn download(
    app: &AppHandle,
    component: &str,
    url: &str,
    dest: &Path,
    label: &str,
) -> Result<(), String> {
    const MAX_RETRIES: u32 = 3;
    let temp_dir = dest.parent().ok_or("无效下载路径")?;
    fs::create_dir_all(temp_dir).map_err(|e| format!("创建下载目录失败: {}", e))?;

    let mut last_err = String::new();
    for attempt in 1..=MAX_RETRIES {
        emit_progress(
            app,
            &InstallProgress {
                component: component.into(),
                stage: "download".into(),
                percent: 5,
                message: format!("开始下载 {} ... (尝试 {}/{})", label, attempt, MAX_RETRIES),
            },
        );

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(300))
            .build()
            .map_err(|e| format!("创建下载客户端失败: {}", e))?;

        let res = client.get(url).send().await;
        match res {
            Ok(res) => {
                if !res.status().is_success() {
                    last_err = format!("下载 {} 失败: HTTP {}", label, res.status());
                    emit_progress(
                        app,
                        &InstallProgress {
                            component: component.into(),
                            stage: "error".into(),
                            percent: 0,
                            message: last_err.clone(),
                        },
                    );
                    continue;
                }

                // 清理旧文件
                let _ = fs::remove_file(dest);
                let total = res.content_length().unwrap_or(0);
                let mut stream = res.bytes_stream();
                let mut file = fs::File::create(dest).map_err(|e| format!("创建文件失败: {}", e))?;
                let mut downloaded: u64 = 0;
                let mut ok = true;

                while let Some(chunk) = stream.next().await {
                    match chunk {
                        Ok(bytes) => {
                            file.write_all(&bytes).map_err(|e| format!("写入文件失败: {}", e))?;
                            downloaded += bytes.len() as u64;
                            if total > 0 {
                                let percent = (downloaded as f64 / total as f64 * 80.0) as u8 + 5;
                                emit_progress(
                                    app,
                                    &InstallProgress {
                                        component: component.into(),
                                        stage: "download".into(),
                                        percent: percent.min(85),
                                        message: format!(
                                            "下载 {}: {:.1} MB / {:.1} MB",
                                            label,
                                            downloaded as f64 / 1048576.0,
                                            total as f64 / 1048576.0
                                        ),
                                    },
                                );
                            }
                        }
                        Err(e) => {
                            last_err = format!("下载 {} 中断: {}", label, e);
                            ok = false;
                            break;
                        }
                    }
                }
                file.flush().map_err(|e| format!("刷新文件失败: {}", e))?;

                if ok {
                    // 简单校验文件大小
                    if total > 0 {
                        let actual = fs::metadata(dest)
                            .map_err(|e| format!("读取文件元信息失败: {}", e))?
                            .len();
                        if actual != total {
                            last_err = format!("下载 {} 大小不匹配: {} / {}", label, actual, total);
                            continue;
                        }
                    }
                    return Ok(());
                }
            }
            Err(e) => {
                last_err = format!("下载 {} 失败: {}", label, e);
            }
        }

        emit_progress(
            app,
            &InstallProgress {
                component: component.into(),
                stage: "error".into(),
                percent: 0,
                message: last_err.clone(),
            },
        );

        if attempt < MAX_RETRIES {
            tokio::time::sleep(Duration::from_secs(2_u64.pow(attempt - 1))).await;
        }
    }

    // 全部失败则删除残留文件
    let _ = fs::remove_file(dest);
    Err(format!("{} 下载重试 {} 次后仍然失败: {}", label, MAX_RETRIES, last_err))
}

/// 解压 zip 到目标目录（自动防路径穿越）
fn extract_zip(zip_path: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| format!("创建解压目录失败: {}", e))?;
    let file = fs::File::open(zip_path).map_err(|e| format!("打开 zip 失败: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("读取 zip 失败: {}", e))?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("读取 zip 条目失败: {}", e))?;
        let Some(name) = entry.enclosed_name() else {
            continue; // 跳过不安全的路径
        };
        let out_path = dest.join(name);
        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| format!("创建目录失败: {}", e))?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("创建父目录失败: {}", e))?;
            }
            let mut out = fs::File::create(&out_path).map_err(|e| format!("创建文件失败: {}", e))?;
            std::io::copy(&mut entry, &mut out).map_err(|e| format!("解压文件失败: {}", e))?;
        }
    }
    Ok(())
}

/// 清理临时安装目录/文件
fn cleanup_temp(paths: &[PathBuf]) {
    for p in paths {
        if p.is_dir() {
            let _ = fs::remove_dir_all(p);
        } else {
            let _ = fs::remove_file(p);
        }
    }
}

// ========== 各组件安装 ==========

/// 安装 Java（Eclipse Temurin JRE 17，华为云镜像）
async fn install_java(app: &AppHandle) -> Result<(), String> {
    let jre_dir = resources_dir(app)?.join(JRE_DIR);
    // 系统已装 Java 11+ 或内置 java.exe 可用 → 跳过
    if detect_java(app).installed {
        emit_progress(
            app,
            &InstallProgress {
                component: "java".into(),
                stage: "done".into(),
                percent: 100,
                message: "Java 已安装，跳过".into(),
            },
        );
        return Ok(());
    }

    let temp = temp_dir(app)?;
    let zip_path = temp.join(JRE_ZIP_NAME);
    let extract_to = temp.join(JRE_EXTRACT_DIR);

    download(app, "java", JAVA_DOWNLOAD_URL, &zip_path, "Java JRE 17").await?;

    emit_progress(
        app,
        &InstallProgress {
            component: "java".into(),
            stage: "extract".into(),
            percent: 85,
            message: "解压 Java JRE ...".into(),
        },
    );

    extract_zip(&zip_path, &extract_to)?;

    // 找到顶层目录并重命名为 jre
    let inner = find_single_child_dir(&extract_to)?;
    if inner.is_dir() {
        // 如果目标已存在，先删除
        let _ = fs::remove_dir_all(&jre_dir);
        fs::rename(&inner, &jre_dir).map_err(|e| format!("重命名 JRE 目录失败: {}", e))?;
    }

    cleanup_temp(&[zip_path, extract_to]);

    // 验证安装
    emit_progress(
        app,
        &InstallProgress {
            component: "java".into(),
            stage: "verify".into(),
            percent: 95,
            message: "验证 Java 安装 ...".into(),
        },
    );
    let verify = detect_java(app);
    if !verify.installed {
        return Err(verify.error.unwrap_or_else(|| "Java 安装验证失败".into()));
    }

    emit_progress(
        app,
        &InstallProgress {
            component: "java".into(),
            stage: "done".into(),
            percent: 100,
            message: "Java 安装完成".into(),
        },
    );
    Ok(())
}

/// 安装 Python（python.org 官方 embeddable 包 + get-pip）
async fn install_python(app: &AppHandle) -> Result<(), String> {
    let py_dir = resources_dir(app)?.join(PYTHON_DIR);
    if detect_python(app).installed {
        emit_progress(
            app,
            &InstallProgress {
                component: "python".into(),
                stage: "done".into(),
                percent: 100,
                message: "Python 已安装，跳过".into(),
            },
        );
        return Ok(());
    }

    let temp = temp_dir(app)?;
    let zip_path = temp.join(PYTHON_ZIP_NAME);
    let getpip = temp.join("get-pip.py");
    let py_exe = py_dir.join("python.exe");

    download(app, "python", PYTHON_DOWNLOAD_URL, &zip_path, "Python 3.11.9").await?;

    emit_progress(
        app,
        &InstallProgress {
            component: "python".into(),
            stage: "extract".into(),
            percent: 85,
            message: "解压 Python ...".into(),
        },
    );

    // 清理旧目录
    let _ = fs::remove_dir_all(&py_dir);
    fs::create_dir_all(&py_dir).map_err(|e| format!("创建 Python 目录失败: {}", e))?;
    extract_zip(&zip_path, &py_dir)?;
    let _ = fs::remove_file(&zip_path);

    // embeddable 包默认禁用 site-packages，需要修改 _pth 文件启用 import site
    if let Ok(entries) = fs::read_dir(&py_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|e| e == "pth") {
                if let Ok(content) = fs::read_to_string(&path) {
                    let fixed = content.replace("#import site", "import site");
                    let _ = fs::write(&path, fixed);
                }
            }
        }
    }

    // 安装 pip
    emit_progress(
        app,
        &InstallProgress {
            component: "python".into(),
            stage: "install".into(),
            percent: 90,
            message: "安装 pip ...".into(),
        },
    );
    download(app, "python", GET_PIP_URL, &getpip, "pip").await?;

    let cmd = CmdLine::new(py_exe.to_string_lossy().to_string(), vec![]);
    let output = cmd
        .command()
        .arg(getpip.to_str().unwrap_or("get-pip.py"))
        .output()
        .map_err(|e| format!("pip 安装失败: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "pip 安装失败: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let _ = fs::remove_file(&getpip);

    // 验证安装
    emit_progress(
        app,
        &InstallProgress {
            component: "python".into(),
            stage: "verify".into(),
            percent: 95,
            message: "验证 Python 安装 ...".into(),
        },
    );
    let verify = detect_python(app);
    if !verify.installed {
        return Err(verify.error.unwrap_or_else(|| "Python 安装验证失败".into()));
    }

    emit_progress(
        app,
        &InstallProgress {
            component: "python".into(),
            stage: "done".into(),
            percent: 100,
            message: "Python 安装完成".into(),
        },
    );
    Ok(())
}

/// 安装 OpenDataLoader（pip install opendataloader-pdf[hybrid]）
async fn install_opendataloader(app: &AppHandle) -> Result<(), String> {
    let python = pick_python(app).ok_or("Python 未安装，请先安装 Python")?;

    // 已安装则跳过
    if python
        .run_capture(&["-c", "import opendataloader_pdf"])
        .is_ok()
    {
        emit_progress(
            app,
            &InstallProgress {
                component: "opendataloader".into(),
                stage: "done".into(),
                percent: 100,
                message: "OpenDataLoader 已安装，跳过".into(),
            },
        );
        return Ok(());
    }

    emit_progress(
        app,
        &InstallProgress {
            component: "opendataloader".into(),
            stage: "install".into(),
            percent: 10,
            message: "pip install opendataloader-pdf[hybrid] ...".into(),
        },
    );

    let mut cmd = python.command();
    cmd.args([
        "-m", "pip", "install",
        "-i", PYPI_MIRROR,
        "-U", "opendataloader-pdf[hybrid]",
    ]);
    let output = cmd.output().map_err(|e| format!("pip 执行失败: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "opendataloader-pdf[hybrid] 安装失败: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    // 验证安装
    emit_progress(
        app,
        &InstallProgress {
            component: "opendataloader".into(),
            stage: "verify".into(),
            percent: 95,
            message: "验证 OpenDataLoader 安装 ...".into(),
        },
    );
    let verify = detect_opendataloader(app);
    if !verify.installed {
        return Err(verify.error.unwrap_or_else(|| "OpenDataLoader 安装验证失败".into()));
    }

    emit_progress(
        app,
        &InstallProgress {
            component: "opendataloader".into(),
            stage: "done".into(),
            percent: 100,
            message: "OpenDataLoader 安装完成".into(),
        },
    );
    Ok(())
}

/// 查找目录下唯一的子目录（用于 Java zip 解压后的顶层目录）
fn find_single_child_dir(dir: &Path) -> Result<PathBuf, String> {
    let entries: Vec<_> = fs::read_dir(dir)
        .map_err(|e| format!("读取目录失败: {}", e))?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .collect();
    if entries.len() == 1 {
        Ok(entries[0].path())
    } else {
        Err(format!(
            "解压目录结构异常，期望 1 个子目录，实际 {}",
            entries.len()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_java_version() {
        let cases = [
            ("openjdk version \"11.0.2\" 2019-01-15", Some((11, "11.0.2".to_string()))),
            ("java version \"17.0.5\" 2022-10-18", Some((17, "17.0.5".to_string()))),
            ("java version \"1.8.0_361\"", Some((8, "1.8.0_361".to_string()))),
            ("command not found", None),
        ];
        for (input, expected) in cases {
            assert_eq!(parse_java_version(input), expected);
        }
    }

    #[test]
    fn test_java_version_ok() {
        assert!(java_version_ok("openjdk version \"11.0.2\"").is_some());
        assert!(java_version_ok("java version \"1.8.0_361\"").is_none());
        assert!(java_version_ok("java version \"17.0.5\"").is_some());
    }

    #[test]
    fn test_parse_python_version() {
        let raw = "Python 3.11.9\n";
        assert_eq!(parse_python_version(raw), "Python 3.11.9".to_string());
    }
}
