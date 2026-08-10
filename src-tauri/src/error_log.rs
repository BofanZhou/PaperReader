//! 错误日志本地存储（Prompt 10 §8：错误处理）
//!
//! - `append_app_log`：前端把渲染错误 / 未捕获异常写入 logs/app.log（带时间戳）
//! - `install_panic_hook`：Rust panic 写 logs/panic.log（发布版崩溃定位）
//! 日志目录：%APPDATA%/com.paperreader.app/logs/

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

fn logs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| format!("获取数据目录失败: {}", e))?.join("logs");
    fs::create_dir_all(&dir).map_err(|e| format!("创建日志目录失败: {}", e))?;
    Ok(dir)
}

fn now_ts() -> String {
    // 不引入 chrono，用简单本地时间格式（SystemTime → unix → 手算 UTC+8）
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (y, mo, d, h, mi, s) = from_unix(secs + 8 * 3600); // UTC+8
    format!("{}-{:02}-{:02} {:02}:{:02}:{:02}", y, mo, d, h, mi, s)
}

/// unix 秒（UTC+8 已加偏移）→ 日历字段
fn from_unix(secs: u64) -> (i64, u32, u32, u32, u32, u32) {
    let days = secs / 86400;
    let rem = secs % 86400;
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let mut y = 1970i64;
    let mut d = days as i64;
    loop {
        let ydays = if leap(y) { 366 } else { 365 };
        if d < ydays {
            break;
        }
        d -= ydays;
        y += 1;
    }
    let mut mo = 1u32;
    for mdays in [31, if leap(y) { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] {
        if d < mdays {
            break;
        }
        d -= mdays;
        mo += 1;
    }
    (y, mo, (d + 1) as u32, h, mi, s)
}

fn leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn append_line(path: &PathBuf, line: &str) {
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{}", line);
    }
}

/// 前端错误写日志（Prompt 10 §8：错误日志本地存储，便于发布版调试）
#[tauri::command]
pub fn append_app_log(app: AppHandle, message: String) -> Result<(), String> {
    let line = format!("[{}] {}", now_ts(), message);
    let dir = logs_dir(&app)?;
    append_line(&dir.join("app.log"), &line);
    Ok(())
}

/// 安装 Rust panic hook：崩溃信息写 logs/panic.log（带时间戳 + 可选位置）。
/// 在 tauri setup 中调用；hook 内不能用 AppHandle（避免 panic 嵌套），
/// 用路径字符串提前捕获 app_data_dir。
pub fn install_panic_hook(app: &AppHandle) {
    let log_path = match logs_dir(app) {
        Ok(d) => d.join("panic.log"),
        Err(_) => return,
    };
    std::panic::set_hook(Box::new(move |info| {
        let line = format!("[{}] PANIC: {}", now_ts(), info);
        append_line(&log_path, &line);
        // 默认行为保留（stderr + 退出码），日志为附加
    }));
}
