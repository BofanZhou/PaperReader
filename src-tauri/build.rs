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
            // 直接强制拷贝，不做 mtime 比较 —— NTFS 上偶尔出现 dst ≥ src 的
            // 误判，导致 src 改动后 target 仍是旧版本（已踩过两次坑）。
            // 文件只有几 KB，开销可忽略。
            if let Err(e) = force_copy(&src, &dst) {
                eprintln!("build.rs: 复制脚本到 target/debug 失败: {}", e);
            } else {
                println!("cargo:rerun-if-changed={}", src.display());
            }
        }
    }
}

fn force_copy(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(src, dst)?;
    Ok(())
}