// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

mod ai;
mod cleanup;
mod env_manager;
mod net;
mod ocr;
mod pdf_parser;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .setup(|app| {
            // 启动时清理过期临时文件（工程补充文档 §4.3）
            let _ = cleanup::cleanup_temp_files(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            env_manager::check_environment,
            env_manager::install_component,
            pdf_parser::parse_pdf,
            pdf_parser::get_last_parse_log,
            pdf_parser::get_paper_pdf_path,
            pdf_parser::get_restructured_doc,
            pdf_parser::read_image_base64,
            ai::get_ai_config,
            ai::save_ai_config,
            ai::save_api_key,
            ai::delete_api_key,
            ai::test_connection,
            ai::chat_completion,
            ai::translate::translate_paper,
            ai::restructure::ai_restructure,
            ocr::ocr_page_image,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
