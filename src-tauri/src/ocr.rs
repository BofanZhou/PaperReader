//! 原图视图：扫描页 OCR（Tesseract-on-render）
//!
//! 前端把 pdfjs 渲染出的页面图像（base64 PNG）传过来，这里用系统 tesseract
//! 做 OCR，返回 word 级像素坐标。坐标与输入图像同坐标系 → 前端可在同一
//! canvas 上精确叠加透明文本层（Google PDF Viewer 风格）。
//!
//! 设计依据（2026-08-09 决策）：扫描版 PDF 没有文本层，pdfjs 无法提取文字；
//! 若复用 OpenDataLoader 的 OCR 结果（其自身坐标系）叠加到 pdfjs 底图会错位
//! （2026-08-07 放弃 Canvas 方案的根因）。改为「Tesseract 跑在 pdfjs 渲染
//! 结果上」，OCR 像素坐标 = canvas 坐标，天然对齐。

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrWord {
    pub text: String,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrResult {
    pub words: Vec<OcrWord>,
}

/// 定位 ocr_page.py（策略与 pdf_parser::script_path 一致）
fn ocr_script_path() -> Result<std::path::PathBuf, String> {
    let name = "ocr_page.py";

    // 1. 当前工作目录 scripts/
    if let Ok(cwd) = std::env::current_dir() {
        let p = cwd.join("scripts").join(name);
        if p.exists() {
            return Ok(p);
        }
    }
    // 2. exe 同目录 scripts/（build.rs 已复制）
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join("scripts").join(name);
            if p.exists() {
                return Ok(p);
            }
        }
    }
    // 3. CARGO_MANIFEST_DIR（cargo run 兜底）
    if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
        let p = std::path::Path::new(&manifest).join("scripts").join(name);
        if p.exists() {
            return Ok(p);
        }
    }
    Err(format!("找不到 {name}"))
}

/// OCR 单页图片：接收 base64 PNG，返回 word 级像素坐标。
#[tauri::command]
pub async fn ocr_page_image(
    app: AppHandle,
    image_base64: String,
    lang: Option<String>,
) -> Result<OcrResult, String> {
    if image_base64.is_empty() || image_base64.len() > 30 * 1024 * 1024 {
        return Err("图片数据无效（为空或超过 30MB）".into());
    }
    let script = ocr_script_path()?;
    let Some(python) =
        crate::env_manager::pick_python_cached(&app, std::time::Duration::from_secs(30))
    else {
        return Err("ENV:PYTHON_NOT_READY".into());
    };
    let lang = lang.unwrap_or_else(|| "chi_sim+eng".to_string());

    // OCR 耗时可能数秒~数十秒，放 spawn_blocking 避免阻塞 async runtime
    let output = tokio::task::spawn_blocking(move || {
        let mut cmd = python.command();
        cmd.arg(&script)
            .arg(&image_base64)
            .arg(&lang)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        cmd.output()
    })
    .await
    .map_err(|e| format!("OCR 任务失败: {}", e))?
    .map_err(|e| format!("OCR 执行失败: {}", e))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if err.is_empty() {
            format!("OCR 退出码 {}", output.status.code().unwrap_or(-1))
        } else {
            err
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let v: serde_json::Value = serde_json::from_str(&stdout)
        .map_err(|e| format!("OCR 结果解析失败: {}", e))?;
    if let Some(err) = v["error"].as_str() {
        return Err(err.to_string());
    }
    let words: Vec<OcrWord> = serde_json::from_value(v["words"].clone()).unwrap_or_default();
    Ok(OcrResult { words })
}
