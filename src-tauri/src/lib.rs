//! SMT Task Manager — IPC commands and lifecycle.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, RunEvent, WindowEvent,
};

use smt_core::{ProcessState, ProcessStatus, TaskInput, TaskTree};
use process::{EventSink, ProcessManager, STATUS_EVENT};

mod config;
mod process;
mod store;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskTreePayload {
    folders: Vec<smt_core::FolderDef>,
    tasks: Vec<smt_core::TaskDef>,
    statuses: HashMap<String, ProcessStatus>,
}

impl TaskTreePayload {
    fn build() -> Self {
        let tree = store::store().tree();
        let statuses = process_manager().statuses(&tree.tasks.iter().map(|t| t.id.clone()).collect::<Vec<_>>());
        Self {
            folders: tree.folders,
            tasks: tree.tasks,
            statuses,
        }
    }
}

fn process_manager() -> &'static ProcessManager {
    static PM: OnceLock<ProcessManager> = OnceLock::new();
    PM.get_or_init(ProcessManager::default)
}

// ────────────────────────────────────────────────────────────────
// Task tree CRUD
// ────────────────────────────────────────────────────────────────

#[tauri::command]
fn list_tasks() -> Result<TaskTreePayload, String> {
    Ok(TaskTreePayload::build())
}

#[tauri::command]
fn create_folder(name: String, parent_id: Option<String>) -> Result<TaskTreePayload, String> {
    let id = gen_id("folder");
    store::store().mutate(|tree| tree.create_folder(id, name, parent_id))?;
    Ok(TaskTreePayload::build())
}

#[tauri::command]
fn rename_folder(id: String, name: String) -> Result<TaskTreePayload, String> {
    store::store().mutate(|tree| tree.rename_folder(&id, &name))?;
    Ok(TaskTreePayload::build())
}

#[tauri::command]
fn move_folder(id: String, parent_id: Option<String>, to_index: Option<usize>) -> Result<TaskTreePayload, String> {
    store::store().mutate(|tree| tree.move_folder(&id, parent_id, to_index))?;
    Ok(TaskTreePayload::build())
}

#[tauri::command]
fn delete_folder(app: AppHandle, id: String) -> Result<TaskTreePayload, String> {
    let before = store::store().tree();
    let removed = store::store().mutate(|tree| tree.delete_folder(&id))?;
    let removed_set: std::collections::HashSet<&str> = removed.iter().map(String::as_str).collect();
    // 删除后停掉原属于这些文件夹（含子文件夹）的任务进程，避免幽灵进程残留
    let sink = Arc::new(app.clone()) as Arc<dyn EventSink>;
    for t in &before.tasks {
        let in_removed = t
            .folder_id
            .as_deref()
            .map(|f| removed_set.contains(f))
            .unwrap_or(false);
        if in_removed {
            let _ = process_manager().stop(sink.clone(), &t.id);
        }
    }
    Ok(TaskTreePayload::build())
}

#[tauri::command]
fn create_task(input: TaskInput) -> Result<TaskTreePayload, String> {
    let id = gen_id("task");
    store::store().mutate(|tree| tree.create_task(id, input))?;
    Ok(TaskTreePayload::build())
}

#[tauri::command]
fn update_task(id: String, input: TaskInput) -> Result<TaskTreePayload, String> {
    store::store().mutate(|tree| tree.update_task(&id, input))?;
    Ok(TaskTreePayload::build())
}

#[tauri::command]
fn delete_task(app: AppHandle, id: String) -> Result<TaskTreePayload, String> {
    // 先停掉进程，避免删除后残留幽灵进程
    let _ = process_manager().stop(Arc::new(app.clone()) as Arc<dyn EventSink>, &id);
    store::store().mutate(|tree| tree.delete_task(&id))?;
    Ok(TaskTreePayload::build())
}

#[tauri::command]
fn move_task(id: String, folder_id: Option<String>, to_index: Option<usize>) -> Result<TaskTreePayload, String> {
    store::store().mutate(|tree| tree.move_task(&id, folder_id, to_index))?;
    Ok(TaskTreePayload::build())
}

// ────────────────────────────────────────────────────────────────
// Process lifecycle
// ────────────────────────────────────────────────────────────────

#[tauri::command]
fn start_process(app: AppHandle, task_id: String) -> Result<ProcessStatus, String> {
    let tree = store::store().tree();
    let task = tree
        .task(&task_id)
        .cloned()
        .ok_or_else(|| format!("任务不存在: {task_id}"))?;
    let sink = Arc::new(app.clone()) as Arc<dyn EventSink>;
    if !task.dependencies.is_empty() {
        // 有依赖：后台编排启动，进度经状态事件推送（同步返回当前状态）
        let sink2 = sink.clone();
        let t2 = tree.clone();
        let tid = task_id.clone();
        std::thread::spawn(move || orchestrate_start(sink2, t2, tid, false, false));
        return Ok(process_manager()
            .statuses(std::slice::from_ref(&task_id))
            .get(&task_id)
            .cloned()
            .unwrap_or_default());
    }
    process_manager().start(sink, task, false)
}

/// 右键「以管理员身份运行」：无视任务配置强制提权启动（会弹 UAC 授权）。
#[tauri::command]
fn start_process_elevated(app: AppHandle, task_id: String) -> Result<ProcessStatus, String> {
    let tree = store::store().tree();
    let task = tree
        .task(&task_id)
        .cloned()
        .ok_or_else(|| format!("任务不存在: {task_id}"))?;
    let sink = Arc::new(app.clone()) as Arc<dyn EventSink>;
    if !task.dependencies.is_empty() {
        let sink2 = sink.clone();
        let t2 = tree.clone();
        let tid = task_id.clone();
        std::thread::spawn(move || orchestrate_start(sink2, t2, tid, true, false));
        return Ok(process_manager()
            .statuses(std::slice::from_ref(&task_id))
            .get(&task_id)
            .cloned()
            .unwrap_or_default());
    }
    process_manager().start(sink, task, true)
}

/// 判断任务是否已处于"已启动"状态（running / starting / restarting）。
fn dep_running(task_id: &str) -> bool {
    process_manager()
        .statuses(&[task_id.to_string()])
        .get(task_id)
        .map(|s| {
            matches!(
                s.state,
                ProcessState::Running | ProcessState::Starting | ProcessState::Restarting
            )
        })
        .unwrap_or(false)
}

/// 给任务发一个失败/未启动的状态事件。
fn emit_dep_failure(sink: &Arc<dyn EventSink>, task_id: &str, why: &str) {
    let mut st = ProcessStatus::default();
    st.error(format!("{why}，任务未启动"));
    sink.emit_json(
        STATUS_EVENT,
        serde_json::json!({ "taskId": task_id, "status": &st }),
    );
    let _ = sink;
}

/// 按依赖关系编排启动本任务（在后台线程执行，避免阻塞命令响应）：
/// - wait_for_deps = true：先自动拉起未运行的依赖，等待全部就绪后再延时，才启动本任务
/// - wait_for_deps = false：依赖必须已在运行，否则本任务启动失败
/// `elevated` = 本任务是否强制提权；`want_restart` = 走重启而非重新启动（仅本任务）
fn orchestrate_start(
    sink: Arc<dyn EventSink>,
    tree: TaskTree,
    task_id: String,
    elevated: bool,
    want_restart: bool,
) {
    let Some(task) = tree.task(&task_id).cloned() else {
        return;
    };
    if !task.dependencies.is_empty() {
        if task.wait_for_deps {
            // 自动拉起依赖任务
            for d in &task.dependencies {
                if !dep_running(d) {
                    if let Some(dep) = tree.task(d).cloned() {
                        let run_as = dep.run_as_admin;
                        let _ = process_manager().start(sink.clone(), dep, run_as);
                    }
                }
            }
            // 等待全部依赖 running（超时 30s，防止死锁）
            let deadline = Instant::now() + Duration::from_secs(30);
            while !task.dependencies.iter().all(|d| dep_running(d)) {
                if Instant::now() >= deadline {
                    emit_dep_failure(&sink, &task_id, "依赖任务启动超时");
                    return;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            // 依赖全部就绪后延时
            std::thread::sleep(Duration::from_secs(task.dep_delay_secs as u64));
        } else if !task.dependencies.iter().all(|d| dep_running(d)) {
            // 不自动拉起：依赖必须已在运行，否则本任务不启动
            let name = task.dependencies
                .iter()
                .find(|d| !dep_running(d))
                .cloned()
                .unwrap_or_default();
            emit_dep_failure(&sink, &task_id, &format!("依赖任务未启动（{name}）"));
            return;
        }
    }
    let _ = process_manager().start(sink, task, elevated);
    let _ = want_restart;
}

#[tauri::command]
fn stop_process(app: AppHandle, task_id: String) -> Result<ProcessStatus, String> {
    process_manager().stop(Arc::new(app.clone()) as Arc<dyn EventSink>, &task_id)
}

#[tauri::command]
fn restart_process(app: AppHandle, task_id: String) -> Result<ProcessStatus, String> {
    let task = store::store()
        .tree()
        .task(&task_id)
        .cloned()
        .ok_or_else(|| format!("任务不存在: {task_id}"))?;
    process_manager().restart(Arc::new(app.clone()) as Arc<dyn EventSink>, task)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AttachResult {
    task_id: String,
    task_name: String,
    status: ProcessStatus,
    /// 终端基线：普通任务为原始字节流（base64，ANSI 保真，xterm 直接 write）；
    /// 提权任务为日志文件文本（raw=false 时按 UTF-8 文本写）。
    text: String,
    /// 日志文件路径（未开启日志保存则为 null）
    log_path: Option<String>,
    /// text 是否为原始终端字节流（base64）
    raw: bool,
}

#[tauri::command]
fn attach_console(task_id: String) -> Result<AttachResult, String> {
    let tree = store::store().tree();
    let task_name = tree
        .task(&task_id)
        .map(|t| t.name.clone())
        .unwrap_or_else(|| task_id.clone());
    let (status, text, log_path, raw) = process_manager()
        .attach_console_b64(&task_id)
        .unwrap_or((ProcessStatus::default(), String::new(), None, false));
    Ok(AttachResult {
        task_id,
        task_name,
        status,
        text,
        log_path,
        raw,
    })
}

/// 向附加的 ConPTY 黑窗发送键盘输入（仅普通模式任务，提权任务不支持）。
#[tauri::command]
fn send_input(task_id: String, data: String) -> Result<(), String> {
    process_manager().send_input(&task_id, data)
}

/// xterm 窗口尺寸变化时同步 ConPTY 行列。
#[tauri::command]
fn resize_pty(task_id: String, rows: u16, cols: u16) -> Result<(), String> {
    process_manager().resize_pty(&task_id, rows, cols)
}

// ────────────────────────────────────────────────────────────────
// Settings（与任务树一起存进 smt.yaml）
// ────────────────────────────────────────────────────────────────

#[tauri::command]
fn load_settings() -> HashMap<String, String> {
    store::store().settings()
}

#[tauri::command]
fn save_settings(settings: HashMap<String, String>) -> Result<(), String> {
    store::store().save_settings(settings)
}

/// 当前配置文件（smt.yaml）的完整路径，设置面板里展示。
#[tauri::command]
fn config_path() -> String {
    store::store().path().display().to_string()
}

#[tauri::command]
fn list_shells() -> Vec<process::ShellOption> {
    process::list_shells()
}

/// 用系统默认浏览器打开地址（仅允许 http/https，防注入）。
#[tauri::command]
fn open_in_browser(url: String) -> Result<(), String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("仅支持 http/https 地址".to_string());
    }
    #[cfg(windows)]
    {
        #[cfg(windows)]
        fn hide(c: &mut std::process::Command) {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", "", &url]);
        #[cfg(windows)]
        hide(&mut c);
        c.spawn().map_err(|e| format!("打开浏览器失败: {e}"))?;
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("打开浏览器失败: {e}"))?;
    }
    Ok(())
}

/// 在系统文件管理器中定位到该文件（Windows 用 explorer /select）。
#[tauri::command]
fn open_in_folder(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.is_file() {
        return Err("文件不存在".to_string());
    }
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", p.display()))
            .spawn()
            .map_err(|e| format!("打开文件夹失败: {e}"))?;
    }
    #[cfg(not(windows))]
    {
        if let Some(dir) = p.parent() {
            std::process::Command::new("xdg-open")
                .arg(dir)
                .spawn()
                .map_err(|e| format!("打开文件夹失败: {e}"))?;
        }
    }
    Ok(())
}

/// 端口监视器：周期扫描监听端口，发 process-ports 事件（无进程时发空 map，
/// 让前端清掉过期的端口显示）。
fn start_ports_monitor(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(3));
        let ports = process_manager().listening_ports();
        let _ = app.emit(process::PORT_EVENT, serde_json::json!({ "ports": ports }));
    });
}

// ────────────────────────────────────────────────────────────────
// Lifecycle: seed autoStart tasks on launch, kill all on exit
// ────────────────────────────────────────────────────────────────

fn start_auto_start(app: &AppHandle) {
    let tree = store::store().tree();
    for task in tree.tasks.iter().filter(|t| t.auto_start) {
        if let Err(err) = process_manager()
            .start(Arc::new(app.clone()) as Arc<dyn EventSink>, task.clone(), false)
        {
            let _ = app.emit(
                process::STATUS_EVENT,
                serde_json::json!({
                    "taskId": task.id,
                    "status": { "state": "error", "pid": null, "exitCode": null,
                                "startedAt": null, "error": err }
                }),
            );
        }
    }
}

fn gen_id(prefix: &str) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{prefix}-{ms}-{:06}", rand_tail())
}

fn rand_tail() -> u32 {
    use std::sync::atomic::{AtomicU32, Ordering};
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let c = COUNTER.fetch_add(1, Ordering::Relaxed);
    (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0))
        ^ c
}

// ────────────────────────────────────────────────────────────────
// 托盘 & 关闭行为（关闭自动最小化到托盘，可设置关闭）
// ────────────────────────────────────────────────────────────────

/// 设置「关闭窗口时最小化到托盘」当前是否开启（默认开启）。
fn close_to_tray_enabled() -> bool {
    store::store()
        .settings()
        .get("closeToTray")
        .map(|v| v != "false")
        .unwrap_or(true)
}

fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// 持有托盘句柄防止被回收：TrayIcon 是引用计数资源，
/// 最后一个实例被 drop 时图标会从系统托盘移除（右键菜单自然就没了）。
static TRAY: std::sync::OnceLock<tauri::tray::TrayIcon> = std::sync::OnceLock::new();

/// 系统托盘：显示主窗口 / 退出；左键点击图标显示主窗口，右键弹出菜单。
fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    // 复用窗口默认图标（已编译进 PE 资源），不引入 png 解码依赖
    let icon = app.default_window_icon().map(|i| i.clone());
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut builder = TrayIconBuilder::new()
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show_main_window(tray.app_handle());
            }
        });
    // 兜底：窗口图标缺失时用 16x16 不透明占位，避免 Windows 托盘图标异常
    if let Some(icon) = icon {
        builder = builder.icon(icon);
    } else {
        builder = builder.icon(tauri::image::Image::new_owned(
            vec![86, 86, 86, 255].repeat(16 * 16),
            16,
            16,
        ));
    }
    let _ = TRAY.set(builder.build(app)?);
    Ok(())
}

// ────────────────────────────────────────────────────────────────
// 窗口几何持久化：移动/缩放时写入 smt.yaml，下次启动恢复位置与大小。
// 用「静态几何 + 常驻落盘线程」做节流，防止拖拽窗口时高频写文件。
// ────────────────────────────────────────────────────────────────
const GEOM_KEY_X: &str = "windowX";
const GEOM_KEY_Y: &str = "windowY";
const GEOM_KEY_W: &str = "windowWidth";
const GEOM_KEY_H: &str = "windowHeight";

static LAST_GEOM: Mutex<Option<(i32, i32, u32, u32)>> = Mutex::new(None);
static GEOM_DIRTY: AtomicBool = AtomicBool::new(false);

/// 记录并标记当前窗口几何（在 Moved / Resized 事件里调用）。
fn track_geometry(win: &tauri::WebviewWindow) {
    let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) else {
        return;
    };
    *LAST_GEOM.lock().unwrap() = Some((pos.x, pos.y, size.width, size.height));
    GEOM_DIRTY.store(true, Ordering::Relaxed);
}

/// 已记录的几何写入 smt.yaml（合并现有 settings，不覆盖主题等其它键）。
fn flush_geometry() {
    if !GEOM_DIRTY.swap(false, Ordering::Relaxed) {
        return;
    }
    let Some((x, y, w, h)) = *LAST_GEOM.lock().unwrap() else {
        return;
    };
    let mut s = store::store().settings();
    s.insert(GEOM_KEY_X.to_string(), x.to_string());
    s.insert(GEOM_KEY_Y.to_string(), y.to_string());
    s.insert(GEOM_KEY_W.to_string(), w.to_string());
    s.insert(GEOM_KEY_H.to_string(), h.to_string());
    let _ = store::store().save_settings(s);
}

/// 启动常驻节流线程：每 500ms 若几何有变化则落盘一次。
fn start_geometry_persister() {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(500));
        flush_geometry();
    });
}

/// 启动时从 smt.yaml 读取窗口几何并应用到主窗口（无记录则跳过）。
fn apply_geometry(win: &tauri::WebviewWindow) {
    let s = store::store().settings();
    let get = |k: &str| s.get(k).and_then(|v| v.parse::<f64>().ok());
    let (Some(x), Some(y)) = (get(GEOM_KEY_X), get(GEOM_KEY_Y)) else {
        return;
    };
    let _ = win.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
        x: x as i32,
        y: y as i32,
    }));
    if let (Some(w), Some(h)) = (get(GEOM_KEY_W), get(GEOM_KEY_H)) {
        let _ = win.set_size(tauri::Size::Physical(tauri::PhysicalSize {
            width: w as u32,
            height: h as u32,
        }));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_tasks,
            create_folder,
            rename_folder,
            move_folder,
            delete_folder,
            create_task,
            update_task,
            delete_task,
            move_task,
            start_process,
            start_process_elevated,
            stop_process,
            restart_process,
            attach_console,
            send_input,
            resize_pty,
            open_in_browser,
            open_in_folder,
            list_shells,
            load_settings,
            save_settings,
            config_path,
        ])
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            // 优先与可执行文件同层级（smt.yaml 便携模式），不可写再回退应用数据目录
            let base_dir = config::resolve_base_dir(app_data_dir);
            store::init_store(base_dir.clone());
            process::set_log_dir(base_dir.join("logs"));
            process::set_script_dir(base_dir.join("scripts"));
            let _ = setup_tray(&app.handle());
            // 恢复窗口大小/位置（在显示前应用）
            if let Some(win) = app.get_webview_window("main") {
                apply_geometry(&win);
            }
            start_geometry_persister();
            start_auto_start(&app.handle());
            start_ports_monitor(&app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            // 主窗口移动/缩放：记录几何（节流落盘到 smt.yaml）
            RunEvent::WindowEvent {
                label,
                event: WindowEvent::Moved(_) | WindowEvent::Resized(_),
                ..
            } => {
                if label == "main" {
                    if let Some(win) = app.get_webview_window(&label) {
                        track_geometry(&win);
                    }
                }
            }
            // 关闭窗口：开启「最小化到托盘」时拦截关闭 → 隐藏窗口，进程继续跑
            RunEvent::WindowEvent {
                label,
                event: WindowEvent::CloseRequested { api, .. },
                ..
            } => {
                if let Some(win) = app.get_webview_window(&label) {
                    track_geometry(&win);
                }
                flush_geometry();
                if close_to_tray_enabled() {
                    api.prevent_close();
                    if let Some(win) = app.get_webview_window(&label) {
                        let _ = win.hide();
                    }
                }
            }
            // 真正退出（托盘"退出" / 设置关闭了托盘时点 X）→ 清理所有子进程
            RunEvent::ExitRequested { .. } => {
                flush_geometry();
                process_manager().kill_all();
            }
            _ => {
                let _ = app;
            }
        });
}
