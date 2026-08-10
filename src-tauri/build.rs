fn main() {
    tauri_build::build();

    // 编译时将 Python 解析脚本复制到 target/{debug,release}/scripts/ 下，
    // 这样 dev（cargo run）与 release（tauri build 产出的 exe）都能在
    // `exe_dir/scripts/` 找到它们（script_path 查找链第 2 项）。
    // 直接强制拷贝，不做 mtime 比较 —— NTFS 上偶尔出现 dst ≥ src 的
    // 误判，导致 src 改动后 target 仍是旧版本（已踩过两次坑）。
    for script in ["parse_pdf.py", "ocr_page.py"] {
        copy_script(script);
    }
}

fn copy_script(script: &str) {
    let script_src = std::path::Path::new("scripts").join(script);
    if !script_src.exists() {
        panic!(
            "scripts/{} 不存在！请在 src-tauri/ 下创建 scripts/{} 后重试",
            script, script
        );
    }

    if let Ok(target_dir) = std::env::var("CARGO_TARGET_DIR") {
        if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
            let src = std::path::Path::new(&manifest_dir).join(&script_src);
            // debug（cargo run）+ release（tauri build）都要复制；文件几 KB，开销可忽略
            for profile in ["debug", "release"] {
                let dst_dir = std::path::Path::new(&target_dir).join(profile).join("scripts");
                let dst = dst_dir.join(script);
                if let Err(e) = force_copy(&src, &dst) {
                    eprintln!("build.rs: 复制脚本到 target/{} 失败 ({}): {}", profile, script, e);
                } else {
                    println!("cargo:rerun-if-changed={}", src.display());
                }
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