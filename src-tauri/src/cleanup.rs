//! 临时文件清理（工程补充文档 §4.3）
//!
//! 应用启动/关闭时清理 app_data_dir/temp 下超过 7 天的残留文件。
//! 说明：当前解析的中间产物放在 papers/{uuid}/work/（含前端引用的图片，
//! 不能清理）；temp/ 目录供后续导出 PDF 等临时操作使用，此处做防御性清理。

use std::fs;
use std::time::{Duration, SystemTime};

pub fn cleanup_temp_files(app: &tauri::AppHandle) -> Result<(), String> {
    let temp_dir = crate::env_manager::app_data_dir(app)?.join("temp");
    if !temp_dir.exists() {
        return Ok(());
    }

    let now = SystemTime::now();
    let max_age = Duration::from_secs(7 * 24 * 3600); // 7 天

    for entry in fs::read_dir(&temp_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let metadata = entry.metadata().map_err(|e| e.to_string())?;

        if let Ok(modified) = metadata.modified() {
            if now.duration_since(modified).unwrap_or(Duration::ZERO) > max_age {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
    Ok(())
}
