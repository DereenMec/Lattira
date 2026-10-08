//! 桌面集成：托盘图标、关闭时最小化到托盘、呼出主界面的全局快捷键
//!
//! 设置项由前端保存（见 src/store/settingsStore.ts），启动和修改时通过下面的命令同步过来。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Emitter, Manager, State, Window, WindowEvent, Wry};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::error::{Error, Result};

const TRAY_ID: &str = "main";

pub struct Desktop {
    close_to_tray: AtomicBool,
    /// 正在退出：关闭窗口时不再拦截
    quitting: AtomicBool,
    shortcut: Mutex<Option<Shortcut>>,
    menu: Mutex<Option<(MenuItem<Wry>, MenuItem<Wry>)>>,
}

impl Default for Desktop {
    fn default() -> Self {
        Self {
            close_to_tray: AtomicBool::new(true),
            quitting: AtomicBool::new(false),
            shortcut: Mutex::new(None),
            menu: Mutex::new(None),
        }
    }
}

/// 显示并聚焦主窗口（从托盘、全局快捷键或再次启动程序时）
pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// 先让前端把未保存的修改写盘，前端没有响应时 3 秒后直接退出
fn request_quit(app: &AppHandle) {
    app.state::<Desktop>().quitting.store(true, Ordering::SeqCst);
    let _ = app.emit("quit-requested", ());
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(3));
        handle.exit(0);
    });
}

pub fn setup_tray(app: &App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示栖页", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("栖页 · Lattira")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "quit" => request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    *app.state::<Desktop>().menu.lock().unwrap() = Some((show, quit));
    Ok(())
}

/// 点关闭按钮时隐藏到托盘，而不是退出
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        let desktop = window.state::<Desktop>();
        if desktop.close_to_tray.load(Ordering::SeqCst) && !desktop.quitting.load(Ordering::SeqCst) {
            api.prevent_close();
            let _ = window.hide();
        }
    }
}

pub fn global_shortcut_plugin() -> tauri::plugin::TauriPlugin<Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            // 只注册了「呼出主界面」一个快捷键
            if event.state() == ShortcutState::Pressed {
                show_main(app);
            }
        })
        .build()
}

fn lock_err<T>(_: T) -> Error {
    Error::Invalid("内部状态异常，请重启栖页".into())
}

/// 设置呼出主界面的全局快捷键；None 表示不使用。格式如 Ctrl+Shift+KeyL
#[tauri::command]
pub async fn set_global_shortcut(app: AppHandle, desktop: State<'_, Desktop>, accelerator: Option<String>) -> Result<()> {
    let wanted = match accelerator.as_deref().map(str::trim).filter(|a| !a.is_empty()) {
        Some(a) => Some(a.parse::<Shortcut>().map_err(|_| Error::Invalid(format!("快捷键格式不正确：{a}")))?),
        None => None,
    };
    let gs = app.global_shortcut();
    let mut current = desktop.shortcut.lock().map_err(lock_err)?;
    if *current == wanted {
        return Ok(());
    }
    let previous = current.take();
    if let Some(old) = previous {
        let _ = gs.unregister(old);
    }
    if let Some(s) = wanted {
        if let Err(e) = gs.register(s) {
            if let Some(old) = previous {
                if gs.register(old).is_ok() {
                    *current = Some(old);
                }
            }
            return Err(Error::Invalid(format!("无法注册全局快捷键，可能已被其他程序占用：{e}")));
        }
    }
    *current = wanted;
    Ok(())
}

#[tauri::command]
pub async fn set_close_to_tray(desktop: State<'_, Desktop>, enabled: bool) -> Result<()> {
    desktop.close_to_tray.store(enabled, Ordering::SeqCst);
    Ok(())
}

/// 托盘菜单随界面语言切换
#[tauri::command]
pub async fn set_tray_labels(app: AppHandle, desktop: State<'_, Desktop>, show: String, quit: String, tooltip: String) -> Result<()> {
    if let Some((show_item, quit_item)) = desktop.menu.lock().map_err(lock_err)?.as_ref() {
        show_item.set_text(show)?;
        quit_item.set_text(quit)?;
    }
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_tooltip(Some(tooltip))?;
    }
    Ok(())
}

/// 前端写完盘后调用，真正退出
#[tauri::command]
pub async fn exit_app(app: AppHandle) -> Result<()> {
    app.exit(0);
    Ok(())
}
