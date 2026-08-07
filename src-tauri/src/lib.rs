// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

mod env_manager;
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
        .invoke_handler(tauri::generate_handler![
            env_manager::check_environment,
            env_manager::install_component,
            pdf_parser::parse_pdf,
            pdf_parser::get_last_parse_log,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
