fn main() {
    tauri_build::build();

    // 编译时将 Python 解析脚本复制到 exe 同目录的 scripts/ 下，
    // 这样双击 exe 启动时 Rust 端能在 `exe_dir/scripts/parse_pdf.py` 找到它。
    let script_src = std::path::Path::new("scripts").join("parse_pdf.py");
    if !script_src.exists() {
        panic!(
            "scripts/parse_pdf.py 不存在！请在 src-tauri/ 下创建 scripts/parse_pdf.py 后重试"
        );
    }

    // target/debug/scripts/parse_pdf.py
    if let Ok(target_dir) = std::env::var("CARGO_TARGET_DIR") {
        if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
            let src = std::path::Path::new(&manifest_dir).join(&script_src);
            let dst_dir = std::path::Path::new(&target_dir).join("debug").join("scripts");
            let dst = dst_dir.join("parse_pdf.py");
            if let Err(e) = copy_if_newer(&src, &dst) {
                eprintln!("build.rs: 复制脚本到 target/debug 失败: {}", e);
            } else {
                println!("cargo:rerun-if-changed={}", src.display());
            }
        }
    }
}

fn copy_if_newer(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    if let Ok(dst_meta) = std::fs::metadata(dst) {
        if let Ok(src_meta) = std::fs::metadata(src) {
            if dst_meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH)
                >= src_meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH)
            {
                return Ok(()); // 已存在且不更旧
            }
        }
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(src, dst)?;
    Ok(())
}