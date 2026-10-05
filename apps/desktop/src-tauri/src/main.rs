#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, AtomicU8, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use tokio::sync::oneshot;

type Reply = Result<Value, String>;
const MAX_REQUEST: usize = 300_000;
const MAX_FRAME: usize = 32 * 1024 * 1024;

struct Bridge {
    child: Mutex<Option<CommandChild>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Reply>>>,
    next: AtomicU64,
    generation: AtomicU64,
    exit_phase: AtomicU8,
    args: Vec<String>,
}
impl Bridge {
    fn new(args: Vec<String>) -> Self {
        Self {
            child: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
            generation: AtomicU64::new(0),
            exit_phase: AtomicU8::new(0),
            args,
        }
    }
    fn write(&self, value: Value) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
        if bytes.len() > MAX_REQUEST {
            return Err("Desktop request is too large".into());
        }
        bytes.push(b'\n');
        self.child
            .lock()
            .unwrap()
            .as_mut()
            .ok_or("Desktop backend is not running")?
            .write(&bytes)
            .map_err(|e| e.to_string())
    }
    fn start(self: &Arc<Self>, app: &tauri::AppHandle) -> Result<(), String> {
        let mut current = self.child.lock().unwrap();
        if current.is_some() {
            return Ok(());
        }
        if self.exit_phase.load(Ordering::SeqCst) != 0 {
            return Err("The desktop app is closing".into());
        }
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let executable = std::env::current_exe().map_err(|e| e.to_string())?;
        let parent = executable
            .parent()
            .ok_or("Desktop executable has no directory")?;
        let daemon = parent.join(if cfg!(windows) {
            "demesned.exe"
        } else {
            "demesned"
        });
        if !daemon.is_file() {
            return Err(
                "The bundled daemon is missing. Rebuild or reinstall the complete desktop app."
                    .into(),
            );
        }
        let mut runtime = app
            .path()
            .resource_dir()
            .map_err(|e| e.to_string())?
            .join("runtime");
        if cfg!(debug_assertions) && !runtime.join("node_modules").is_dir() {
            runtime = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/runtime");
        }
        let command = app
            .shell()
            .sidecar("demesne-desktop-host")
            .map_err(|e| e.to_string())?
            .args(&self.args)
            .env("DEMESNE_DAEMON_BIN", &daemon)
            .env("DEMESNE_NATIVE_RUNTIME_DIR", &runtime);
        let (mut events, child) = command
            .spawn()
            .map_err(|e| format!("Desktop backend could not start: {e}"))?;
        *current = Some(child);
        let bridge = Arc::clone(self);
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(event) = events.recv().await {
                if bridge.generation.load(Ordering::SeqCst) != generation {
                    break;
                }
                match event {
                    CommandEvent::Stdout(bytes) => {
                        if bytes.len() > MAX_FRAME {
                            bridge.failed(
                                &handle,
                                generation,
                                "Desktop backend exceeded the message limit".into(),
                            );
                            break;
                        }
                        match serde_json::from_slice::<Value>(&bytes) {
                            Ok(value) => bridge.receive(&handle, value).await,
                            Err(_) => {
                                bridge.failed(
                                    &handle,
                                    generation,
                                    "Desktop backend returned an invalid message".into(),
                                );
                                break;
                            }
                        }
                    }
                    CommandEvent::Stderr(bytes) => {
                        eprintln!("desktop backend: {}", String::from_utf8_lossy(&bytes))
                    }
                    CommandEvent::Error(error) => {
                        bridge.failed(
                            &handle,
                            generation,
                            format!("Desktop backend connection failed: {error}"),
                        );
                        break;
                    }
                    CommandEvent::Terminated(status) => {
                        bridge.failed(
                            &handle,
                            generation,
                            format!("Desktop backend exited ({:?})", status.code),
                        );
                        break;
                    }
                    _ => {}
                }
            }
        });
        Ok(())
    }
    fn failed(&self, app: &tauri::AppHandle, generation: u64, message: String) {
        if self.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        log_event(app, &format!("backend: {message}"));
        if let Some(child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
        }
        for (_, sender) in self.pending.lock().unwrap().drain() {
            let _ = sender.send(Err(message.clone()));
        }
        if self.exit_phase.load(Ordering::SeqCst) == 0 {
            let _ = app.emit_to("main", "demesne:desktop-error", json!({"message":message}));
        }
    }
    async fn receive(&self, app: &tauri::AppHandle, value: Value) {
        match value.get("kind").and_then(Value::as_str) {
            Some("response") => {
                if let Some(id) = value.get("id").and_then(Value::as_u64) {
                    if let Some(sender) = self.pending.lock().unwrap().remove(&id) {
                        let result = if value["ok"] == true {
                            Ok(value.get("value").cloned().unwrap_or(Value::Null))
                        } else {
                            Err(value["error"]
                                .as_str()
                                .unwrap_or("Desktop action failed")
                                .to_string())
                        };
                        let _ = sender.send(result);
                    }
                }
            }
            Some("update") => {
                if let Some(update) = value.get("update") {
                    let _ = app.emit_to("main", "demesne:update", update);
                }
            }
            Some("command") => {
                if let Some(command) = value.get("command") {
                    let _ = app.emit_to("main", "demesne:command", command);
                }
            }
            Some("native") => {
                if let Some(id) = value.get("id").and_then(Value::as_u64) {
                    let result = native_action(app, &value);
                    let reply = match result {
                        Ok(()) => json!({"kind":"native-response","id":id,"ok":true,"value":null}),
                        Err(error) => {
                            json!({"kind":"native-response","id":id,"ok":false,"error":error})
                        }
                    };
                    let _ = self.write(reply);
                }
            }
            Some("protocol-error") => {
                eprintln!("desktop backend protocol error: {}", value["error"])
            }
            _ => eprintln!("desktop backend returned an unknown message"),
        }
    }
    async fn request(self: &Arc<Self>, app: &tauri::AppHandle, method: &str, args: Value) -> Reply {
        validate_request(method, &args)?;
        if method != "shutdown" {
            self.start(app)?;
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, sender);
        if let Err(error) =
            self.write(json!({"kind":"request","id":id,"method":method,"args":args}))
        {
            self.pending.lock().unwrap().remove(&id);
            return Err(error);
        }
        let response = tokio::time::timeout(Duration::from_secs(120), receiver).await;
        self.pending.lock().unwrap().remove(&id);
        response
            .map_err(|_| "The desktop backend did not respond in time".to_string())?
            .map_err(|_| "Desktop backend disconnected".to_string())?
    }
}
fn validate_request(method: &str, args: &Value) -> Result<(), String> {
    if method.is_empty() || method.len() > 80 || !args.is_object() {
        return Err("Invalid desktop request".into());
    }
    if serde_json::to_vec(args).map_err(|e| e.to_string())?.len() > 260_000 {
        return Err("Desktop request is too large".into());
    }
    Ok(())
}
fn local_app_url(url: &url::Url) -> bool {
    allowed_app_url(url, cfg!(target_os = "windows"))
}
fn allowed_app_url(url: &url::Url, windows: bool) -> bool {
    if !url.username().is_empty() || url.password().is_some() || url.port().is_some() {
        return false;
    }
    if windows {
        matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost")
    } else {
        url.scheme() == "tauri" && url.host_str() == Some("localhost")
    }
}
fn native_action(app: &tauri::AppHandle, value: &Value) -> Result<(), String> {
    match value["method"].as_str() {
        Some("copy") => {
            let text = value["args"]["text"]
                .as_str()
                .ok_or("Invalid clipboard text")?;
            if text.len() > 1_100_000 {
                return Err("Clipboard text is too large".into());
            }
            app.clipboard().write_text(text).map_err(|e| e.to_string())
        }
        Some("open") => {
            let path = value["args"]["path"]
                .as_str()
                .ok_or("Invalid item to open")?;
            if let Ok(url) = url::Url::parse(path) {
                if !matches!(url.scheme(), "http" | "https") {
                    return Err("Unsupported link protocol".into());
                }
                app.opener()
                    .open_url(path, None::<&str>)
                    .map_err(|e| e.to_string())
            } else {
                let file = PathBuf::from(path);
                if !file.is_absolute() || !file.exists() {
                    return Err("The item to open is unavailable".into());
                }
                app.opener()
                    .open_path(path, None::<&str>)
                    .map_err(|e| e.to_string())
            }
        }
        _ => Err("Unsupported native desktop action".into()),
    }
}
/// Appends a line to the app's log (why it exited, or why its backend
/// failed), so a window that "disappears" can be explained afterwards.
fn log_event(app: &tauri::AppHandle, line: &str) {
    use std::io::Write;
    let Ok(dir) = app.path().app_log_dir() else { return };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("desktop.log")) {
        let _ = writeln!(file, "{at} {line}");
    }
}
fn request_exit(app: &tauri::AppHandle, reason: &str) {
    let bridge = Arc::clone(app.state::<Arc<Bridge>>().inner());
    if bridge
        .exit_phase
        .compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    log_event(app, &format!("exit: {reason}"));
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let running = bridge.child.lock().unwrap().is_some();
        if running {
            let _ = tokio::time::timeout(
                Duration::from_secs(2),
                bridge.request(&handle, "shutdown", json!({})),
            )
            .await;
        }
        if let Some(child) = bridge.child.lock().unwrap().take() {
            let _ = child.kill();
        }
        bridge.exit_phase.store(2, Ordering::SeqCst);
        handle.exit(0);
    });
}
#[tauri::command]
async fn desktop_request(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    bridge: tauri::State<'_, Arc<Bridge>>,
    method: String,
    args: Value,
) -> Reply {
    if window.label() != "main" || !local_app_url(&window.url().map_err(|e| e.to_string())?) {
        return Err("Desktop actions are restricted to the main window".into());
    }
    validate_request(&method, &args)?;
    match method.as_str() {
        "desktop-ready" => {
            window.show().map_err(|e| e.to_string())?;
            window.set_focus().map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "quit" | "desktop-quit" => {
            request_exit(&app, &format!("{method} requested by the interface"));
            Ok(Value::Null)
        }
        "desktop-select-project" => {
            let (sender, receiver) = oneshot::channel();
            app.dialog()
                .file()
                .set_title("Open a Demesne project")
                .pick_folder(move |selected| {
                    let _ = sender.send(selected);
                });
            let selected = receiver
                .await
                .map_err(|_| "Project chooser closed".to_string())?;
            if let Some(file) = selected {
                let path = file.into_path().map_err(|e| e.to_string())?;
                bridge
                    .request(
                        &app,
                        "desktop-open-project",
                        json!({"path":path.to_string_lossy()}),
                    )
                    .await
            } else {
                bridge.request(&app, "desktop-bootstrap", json!({})).await
            }
        }
        _ => bridge.request(&app, &method, args).await,
    }
}
/// Text and layout size, like a browser's zoom: ⌘= / ⌘- / ⌘0 in the View
/// menu. The level is saved in the app's config folder and restored at launch.
const ZOOM_LEVELS: [f64; 12] = [0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0];
struct Zoom(Mutex<f64>);
fn zoom_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join("zoom.json"))
}
fn load_zoom(app: &tauri::AppHandle) -> f64 {
    zoom_path(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value["zoom"].as_f64())
        .filter(|level| ZOOM_LEVELS.iter().any(|known| (known - level).abs() < 1e-9))
        .unwrap_or(1.0)
}
/// The next level up (step 1), down (-1), or back to 100% (0).
fn next_zoom(current: f64, step: i32) -> f64 {
    match step {
        0 => 1.0,
        1 => ZOOM_LEVELS.iter().copied().find(|level| *level > current + 1e-9).unwrap_or(current),
        _ => ZOOM_LEVELS.iter().rev().copied().find(|level| *level < current - 1e-9).unwrap_or(current),
    }
}
fn apply_zoom(app: &tauri::AppHandle, step: i32) {
    let state = app.state::<Zoom>();
    let mut level = state.0.lock().unwrap();
    *level = next_zoom(*level, step);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_zoom(*level);
    }
    if let Some(path) = zoom_path(app) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(path, json!({ "zoom": *level }).to_string());
    }
}

fn main() {
    let args = std::env::args()
        .skip(1)
        .filter(|arg| {
            arg.starts_with("--workspace=")
                || arg.starts_with("--server=")
                || arg.starts_with("--session=")
                || arg.starts_with("--model=")
                || arg.starts_with("--prompt=")
                || arg == "--setup"
        })
        .collect();
    let bridge = Arc::new(Bridge::new(args));
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .manage(bridge)
        .manage(Zoom(Mutex::new(1.0)))
        .invoke_handler(tauri::generate_handler![desktop_request])
        .setup(|app| {
            let config = app
                .config()
                .app
                .windows
                .first()
                .ok_or("The main desktop window is not configured")?;
            let window = tauri::WebviewWindowBuilder::from_config(app, config)?
                .on_navigation(local_app_url)
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build()?;
            let saved = load_zoom(app.handle());
            *app.state::<Zoom>().0.lock().unwrap() = saved;
            let _ = window.set_zoom(saved);
            let menu = tauri::menu::Menu::default(app.handle())?;
            let project = tauri::menu::Submenu::new(app, "Project", true)?;
            project.append(&tauri::menu::MenuItem::with_id(
                app,
                "open-project",
                "Open project…",
                true,
                Some("CmdOrCtrl+O"),
            )?)?;
            project.append(&tauri::menu::MenuItem::with_id(
                app,
                "desktop-settings",
                "Settings…",
                true,
                Some("CmdOrCtrl+,"),
            )?)?;
            menu.append(&project)?;
            let view = tauri::menu::Submenu::new(app, "View", true)?;
            for (id, label, accelerator) in [
                ("zoom-in", "Zoom In", "CmdOrCtrl+="),
                ("zoom-out", "Zoom Out", "CmdOrCtrl+-"),
                ("zoom-reset", "Actual Size", "CmdOrCtrl+0"),
            ] {
                view.append(&tauri::menu::MenuItem::with_id(app, id, label, true, Some(accelerator))?)?;
            }
            menu.append(&view)?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            match event.id().as_ref() {
                "zoom-in" => return apply_zoom(app, 1),
                "zoom-out" => return apply_zoom(app, -1),
                "zoom-reset" => return apply_zoom(app, 0),
                _ => {}
            }
            let action = match event.id().as_ref() {
                "open-project" => Some("open-project"),
                "desktop-settings" => Some("settings"),
                _ => None,
            };
            if let Some(action) = action {
                let _ = app.emit_to("main", "demesne:desktop-action", json!({"action":action}));
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                // macOS keeps an app running when its window closes: hide it,
                // and a Dock click brings it back. Elsewhere closing quits.
                if cfg!(target_os = "macos") {
                    let _ = window.hide();
                } else {
                    request_exit(window.app_handle(), "window closed");
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Could not initialize Demesne desktop");
    app.run(|app, event| match event {
        tauri::RunEvent::ExitRequested { api, code, .. } => {
            if app.state::<Arc<Bridge>>().exit_phase.load(Ordering::SeqCst) != 2 {
                api.prevent_exit();
                request_exit(app, &format!("exit requested by the system or app menu (code {code:?})"));
            }
        }
        // Every way out ends here, including a system Quit that skips
        // ExitRequested; log it unless request_exit already did.
        tauri::RunEvent::Exit => {
            if app.state::<Arc<Bridge>>().exit_phase.load(Ordering::SeqCst) == 0 {
                log_event(app, "exit: application terminated (system Quit or app menu)");
            }
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        _ => {}
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn zoom_steps_through_levels_and_stops_at_the_ends() {
        assert_eq!(next_zoom(1.0, 1), 1.1);
        assert_eq!(next_zoom(1.0, -1), 0.9);
        assert_eq!(next_zoom(1.25, 0), 1.0);
        assert_eq!(next_zoom(3.0, 1), 3.0);
        assert_eq!(next_zoom(0.67, -1), 0.67);
        // An unknown saved level steps to its nearest neighbor.
        assert_eq!(next_zoom(1.05, 1), 1.1);
    }
    #[test]
    fn only_authored_application_origins_can_access_the_bridge() {
        assert!(allowed_app_url(
            &url::Url::parse("tauri://localhost/").unwrap(),
            false
        ));
        for value in [
            "http://tauri.localhost/",
            "https://tauri.localhost/index.html",
        ] {
            let url = url::Url::parse(value).unwrap();
            assert!(allowed_app_url(&url, true));
            assert!(!allowed_app_url(&url, false));
        }
        for value in [
            "https://example.com/",
            "http://localhost/",
            "file:///tmp/app.html",
            "tauri://user@localhost/",
            "http://tauri.localhost:8080/",
        ] {
            let url = url::Url::parse(value).unwrap();
            assert!(!allowed_app_url(&url, false));
            assert!(!allowed_app_url(&url, true));
        }
    }
    #[test]
    fn requests_require_named_methods_and_object_arguments() {
        assert!(validate_request("submit", &json!({"text":"Hello"})).is_ok());
        assert!(validate_request("", &json!({})).is_err());
        assert!(validate_request(&"x".repeat(81), &json!({})).is_err());
        assert!(validate_request("submit", &json!([])).is_err());
        assert!(validate_request("submit", &json!({"text":"x".repeat(260_000)})).is_err());
    }
}
