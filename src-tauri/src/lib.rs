// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod claude;
mod import;
mod manager;
mod pty;
mod store;

use manager::Manager;
use tauri::Manager as _;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 初始化会话管理器，加载持久化记录并广播初始列表。
            let manager = Manager::new().expect("初始化会话管理器失败");
            app.manage(manager);
            let manager_state = app.state::<Manager>();
            manager_state.restore_list(&app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            manager::session_list,
            manager::session_create,
            manager::session_write,
            manager::session_resize,
            manager::session_close,
            manager::session_remove,
            manager::session_set_active,
            manager::session_register,
            manager::is_directory,
            import::list_external_sessions,
        ])
        .on_window_event(|window, event| {
            // 应用关闭时清理所有运行中的 PTY 子进程。
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(manager) = window.app_handle().try_state::<Manager>() {
                    manager.cleanup_all();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
