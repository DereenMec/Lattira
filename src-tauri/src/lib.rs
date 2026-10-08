mod clipboard;
mod commands;
mod db;
mod desktop;
mod error;
mod files;
mod ocr;
mod transfer;
mod trash;
mod workspace;

use workspace::AppState;

pub fn run() {
    tauri::Builder::default()
        // 必须最先注册：再次启动程序时只把已运行的窗口调出来
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| desktop::show_main(app)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(desktop::global_shortcut_plugin())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState::default())
        .manage(desktop::Desktop::default())
        .setup(|app| Ok(desktop::setup_tray(app)?))
        .on_window_event(desktop::on_window_event)
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
            trash::list_trash,
            trash::restore_trash,
            trash::purge_trash,
            trash::empty_trash,
            transfer::export_canvas,
            transfer::import_canvases,
            desktop::set_global_shortcut,
            desktop::set_close_to_tray,
            desktop::set_tray_labels,
            desktop::exit_app,
        ])
        .run(tauri::generate_context!())
        .expect("启动栖页失败");
}
