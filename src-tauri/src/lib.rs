mod clipboard;
mod commands;
mod db;
mod error;
mod files;
mod ocr;
mod workspace;

use workspace::AppState;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::restore_workspace,
            commands::open_workspace,
            commands::list_projects,
            commands::create_project,
            commands::update_project,
            commands::list_canvases,
            commands::create_canvas,
            commands::update_canvas,
            commands::delete_canvas,
            commands::load_canvas,
            commands::save_canvas,
            commands::import_paths,
            commands::import_tree,
            commands::import_bytes,
            commands::list_assets,
            commands::open_asset,
            commands::reveal_asset,
            commands::reveal_canvas,
            commands::reveal_project,
            commands::reveal_workspace,
            commands::copy_asset_to,
            commands::delete_assets,
            commands::rename_asset,
            commands::copy_cards,
            commands::read_clipboard,
            commands::calendar_days,
            commands::search,
        ])
        .run(tauri::generate_context!())
        .expect("启动栖页失败");
}
