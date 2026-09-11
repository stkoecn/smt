//! 纯浏览器 / 局域网 Web 访问桥接层。
//!
//! 用 axum 起 HTTP + WebSocket 服务（默认 `0.0.0.0:3088`，可经 smt.yaml
//! settings 的 webEnabled / webPort / webBind / webPassword 调整）：
//! - 静态资源：release 走 tauri 内嵌资产（便携 exe 单文件即可），dev 回退磁盘 dist/
//! - `POST /api/invoke`：把 Tauri 命令协议转发到 lib.rs 里的同名命令函数
//! - `GET /ws`：把 EventSink 事件通道（终端字节流 / 状态 / 端口）广播给浏览器
//! - `POST /api/login` + `GET /api/auth/state`：访问密码认证（webPassword 存
//!   SHA-256 hex；未设密码 = 免认证；设置后所有接口需带 token）
//!
//! 前端零修改：静态服务会在 index.html 里注入 tauri_shim.js，用 HTTP+WS
//! 模拟 `window.__TAURI_INTERNALS__`，`@tauri-apps/api` 感知不到差异。
//! 日志写 `logs/web.log`（无控制台窗口）。

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::Query;
use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::async_runtime::JoinHandle;
use tokio::sync::broadcast;

const SHIM_JS: &str = include_str!("tauri_shim.js");
const DEFAULT_PORT: u16 = 3088;
const DEFAULT_BIND: &str = "0.0.0.0";
const EVENT_CHANNEL_CAP: usize = 1024;

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
static EVENT_TX: OnceLock<broadcast::Sender<String>> = OnceLock::new();
static SERVE_TASK: Mutex<Option<JoinHandle<()>>> = Mutex::new(None);
static RUNNING: AtomicBool = AtomicBool::new(false);
static BOUND_ADDR: Mutex<Option<String>> = Mutex::new(None);
static TOKENS: Mutex<Option<HashSet<String>>> = Mutex::new(None);
static TOKEN_COUNTER: AtomicU64 = AtomicU64::new(0);

// ────────────────────────────────────────────────────────────────
// 生命周期：启动 / 停止 / 重启（设置面板可操作）
// ────────────────────────────────────────────────────────────────

/// 事件双通道：桌面窗口 emit 的同时推给所有 Web 客户端。
/// 由 `impl EventSink for AppHandle`（process.rs）与 lib.rs 的直接 emit 调用。
pub fn broadcast_event(event: &str, payload: &Value) {
    if let Some(tx) = EVENT_TX.get() {
        let frame = serde_json::json!({ "type": "event", "event": event, "payload": payload });
        if let Ok(s) = serde_json::to_string(&frame) {
            let _ = tx.send(s);
        }
    }
}

/// 应用 setup 时调用：记录 AppHandle 并按 settings 启动。
pub fn start(app: tauri::AppHandle) {
    let _ = APP.set(app);
    let _ = EVENT_TX.set(broadcast::channel(EVENT_CHANNEL_CAP).0);
    start_service();
}

/// 按 smt.yaml settings 启动 Web 服务（已运行则忽略）。
pub fn start_service() {
    if RUNNING.load(Ordering::SeqCst) {
        return;
    }
    let settings = crate::store::store().settings();
    let enabled = settings.get("webEnabled").map(|v| v != "false").unwrap_or(true);
    if !enabled {
        web_log("Web 服务未启用（webEnabled=false），跳过启动");
        return;
    }
    let port: u16 = settings
        .get("webPort")
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_PORT);
    let bind = settings
        .get("webBind")
        .cloned()
        .unwrap_or_else(|| DEFAULT_BIND.to_string());

    let task = tauri::async_runtime::spawn(async move {
        serve(bind, port).await;
    });
    *SERVE_TASK.lock().unwrap() = Some(task);
}

/// 停止 Web 服务（断开所有浏览器连接、清空会话 token）。
pub fn stop_service() {
    if let Some(task) = SERVE_TASK.lock().unwrap().take() {
        task.abort();
    }
    RUNNING.store(false, Ordering::SeqCst);
    *BOUND_ADDR.lock().unwrap() = None;
    *TOKENS.lock().unwrap() = None;
    web_log("Web 服务已停止");
}

/// 重启（重新读取 settings 的端口/绑定/密码）。
pub fn restart_service() {
    stop_service();
    start_service();
}

/// 当前运行状态（设置面板展示）。
pub fn status() -> (bool, Option<String>, bool) {
    (
        RUNNING.load(Ordering::SeqCst),
        BOUND_ADDR.lock().unwrap().clone(),
        auth_required(),
    )
}

async fn serve(bind: String, port: u16) {
    // 端口被占（如本机其他服务占了 3088）时自动向后顺延，最多试 10 个。
    // Windows 允许 0.0.0.0 与 127.0.0.1 并存绑定，但回环连接优先命中具体地址，
    // 所以绑 0.0.0.0 前还要探测 127.0.0.1 同端口是否空闲，否则 localhost 访问会打到别人。
    let mut addr = format!("{bind}:{port}");
    let mut listener = None;
    for extra in 0..10u16 {
        let probe_port = port + extra;
        // 回环探测：127.0.0.1 同端口被占则 localhost 访问会打到别人，直接换端口
        let loopback_ok = tokio::net::TcpListener::bind(("127.0.0.1", probe_port))
            .await
            .is_ok();
        if !loopback_ok {
            web_log(&format!("回环 127.0.0.1:{probe_port} 被占，换下一端口"));
            addr = format!("{bind}:{}", probe_port + 1);
            continue;
        }
        match tokio::net::TcpListener::bind(&addr).await {
            Ok(l) => {
                listener = Some(l);
                break;
            }
            Err(e) => web_log(&format!("[web] {addr} 绑定失败: {e}")),
        }
        addr = format!("{bind}:{}", probe_port + 1);
    }
    if let Some(l) = listener {
        RUNNING.store(true, Ordering::SeqCst);
        *BOUND_ADDR.lock().unwrap() = Some(addr.clone());
        web_log(&format!(
            "浏览器访问入口已就绪: http://{addr}/（认证: {}）",
            if auth_required() { "已开启" } else { "未设密码" }
        ));
        let _ = axum::serve(l, router()).await;
    } else {
        web_log("连续 10 个端口均绑定失败，Web 服务未启动");
    }
}

fn router() -> Router {
    Router::new()
        .route("/ws", get(ws_handler))
        .route("/api/invoke", post(api_invoke))
        .route("/api/login", post(api_login))
        .route("/api/auth/state", get(api_auth_state))
        .route("/tauri-shim.js", get(shim_js))
        .fallback(serve_static)
}

// ────────────────────────────────────────────────────────────────
// 认证：webPassword 存 SHA-256 hex（设置面板经 Web Crypto 写入）；
// 登录换 token，之后所有 invoke 带 Authorization: Bearer，WS 带 ?token=
// ────────────────────────────────────────────────────────────────

fn sha256_hex(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn password_hash_hex() -> Option<String> {
    let v = crate::store::store()
        .settings()
        .get("webPassword")?
        .trim()
        .to_lowercase();
    (!v.is_empty()).then_some(v)
}

fn auth_required() -> bool {
    password_hash_hex().is_some()
}

fn token_from_headers(headers: &HeaderMap) -> Option<String> {
    let v = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    v.strip_prefix("Bearer ").map(|s| s.trim().to_string())
}

fn token_valid(token: &str) -> bool {
    TOKENS.lock().unwrap().as_ref().is_some_and(|set| set.contains(token))
}

fn request_authed(headers: &HeaderMap) -> bool {
    !auth_required() || token_from_headers(headers).is_some_and(|t| token_valid(&t))
}

fn new_token() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = TOKEN_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    // 时间 + 计数 + 栈地址（ASLR 熵）+ 进程 id 混合后哈希
    let material = format!("{nanos}-{n}-{:x}-{}", &nanos as *const u128 as u64, std::process::id());
    sha256_hex(material.as_bytes())
}

async fn api_auth_state(headers: HeaderMap) -> Response {
    let (running, addr, required) = status();
    let authed = !required || token_from_headers(&headers).is_some_and(|t| token_valid(&t));
    Json(serde_json::json!({ "required": required, "authed": authed, "running": running, "addr": addr }))
        .into_response()
}

async fn api_login(Json(body): Json<Value>) -> Response {
    let Some(stored) = password_hash_hex() else {
        // 未设密码：直接放行
        return Json(serde_json::json!({ "ok": true, "token": null, "required": false }))
            .into_response();
    };
    let password = body.get("password").and_then(|v| v.as_str()).unwrap_or("");
    if sha256_hex(password.as_bytes()) == stored {
        let token = new_token();
        TOKENS.lock().unwrap().get_or_insert_with(HashSet::new).insert(token.clone());
        web_log("浏览器登录成功");
        Json(serde_json::json!({ "ok": true, "token": token, "required": true })).into_response()
    } else {
        web_log("浏览器登录失败：密码错误");
        (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "ok": false, "error": "密码错误" })),
        )
            .into_response()
    }
}

// ────────────────────────────────────────────────────────────────
// WebSocket：事件广播（带 token 校验）
// ────────────────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
struct WsQuery {
    token: Option<String>,
}

async fn ws_handler(Query(q): Query<WsQuery>, upgrade: WebSocketUpgrade) -> Response {
    if auth_required() && !q.token.as_deref().is_some_and(|t| token_valid(t)) {
        return (StatusCode::UNAUTHORIZED, "未认证").into_response();
    }
    upgrade.on_upgrade(ws_loop)
}

async fn ws_loop(mut socket: WebSocket) {
    let Some(tx) = EVENT_TX.get() else {
        return;
    };
    let mut rx = tx.subscribe();
    loop {
        tokio::select! {
            frame = rx.recv() => match frame {
                Ok(msg) => {
                    if socket.send(Message::Text(msg.into())).await.is_err() {
                        break;
                    }
                }
                // 慢客户端：丢掉积压的旧事件即可，终端是视觉追加流，可容忍
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            },
            incoming = socket.recv() => match incoming {
                // 只关心客户端断开/关闭；浏览器 shim 不需要上行数据
                None | Some(Err(_)) => break,
                Some(Ok(Message::Close(_))) => break,
                Some(Ok(_)) => {}
            },
        }
    }
}

// ────────────────────────────────────────────────────────────────
// 命令桥接：POST /api/invoke { cmd, args }（带 Bearer token 校验）
// ────────────────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
struct InvokeReq {
    cmd: String,
    #[serde(default)]
    args: Value,
}

async fn api_invoke(headers: HeaderMap, Json(req): Json<InvokeReq>) -> Response {
    if !request_authed(&headers) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "ok": false, "error": "未认证或会话已过期" })),
        )
            .into_response();
    }
    let result = dispatch(&req.cmd, &req.args).await;
    let body = match result {
        Ok(v) => serde_json::json!({ "ok": true, "value": v }),
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
    };
    Json(body).into_response()
}

pub(crate) fn arg<T: serde::de::DeserializeOwned>(args: &Value, key: &str) -> Result<T, String> {
    match args.get(key) {
        Some(v) if !v.is_null() => serde_json::from_value(v.clone())
            .map_err(|e| format!("参数 {key} 解析失败: {e}")),
        _ => Err(format!("缺少参数: {key}")),
    }
}

pub(crate) fn opt_arg<T: serde::de::DeserializeOwned>(args: &Value, key: &str) -> Result<Option<T>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => serde_json::from_value(v.clone())
            .map(Some)
            .map_err(|e| format!("参数 {key} 解析失败: {e}")),
    }
}

pub(crate) fn ok<T: serde::Serialize>(r: Result<T, String>) -> Result<Value, String> {
    r.and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

async fn dispatch(cmd: &str, args: &Value) -> Result<Value, String> {
    let app = APP.get().ok_or_else(|| "Web 服务尚未就绪".to_string())?;
    if cmd == "plugin:dialog|open" {
        // tauri-plugin-dialog 的 JS 协议：选择工作目录（服务端同机弹原生对话框）
        return dialog_open(app, args).await;
    }
    // 命令分发在 lib.rs 里与桌面命令同模块（命令 fn 是私有的，宏限制不能改 pub）
    crate::web_dispatch(app, cmd, args).await
}

async fn dialog_open(app: &tauri::AppHandle, args: &Value) -> Result<Value, String> {
    let options = args.get("options").cloned().unwrap_or(Value::Null);
    if !options
        .get("directory")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return Err("Web 模式仅支持目录选择".to_string());
    }
    let app = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let (tx, rx) = std::sync::mpsc::channel::<Option<String>>();
        let mut builder = app.dialog().file();
        if let Some(title) = options.get("title").and_then(|v| v.as_str()) {
            builder = builder.set_title(title.to_string());
        }
        builder.pick_folder(move |fp| {
            let path = fp.and_then(|f| f.as_path().map(|p| p.display().to_string()));
            let _ = tx.send(path);
        });
        rx.recv().unwrap_or(None)
    })
    .await
    .map_err(|e| format!("对话框任务失败: {e}"))?;
    Ok(serde_json::to_value(picked).unwrap_or(Value::Null))
}

// ────────────────────────────────────────────────────────────────
// 静态资源：内嵌资产优先，磁盘 dist/ 兜底；index.html 注入 shim
// ────────────────────────────────────────────────────────────────

const SHIM_TAG: &str = "<head><script src=\"/tauri-shim.js\"></script>";

async fn shim_js() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "application/javascript; charset=utf-8")],
        SHIM_JS,
    )
}

async fn serve_static(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    if path.contains("..") {
        return (StatusCode::FORBIDDEN, "拒绝访问").into_response();
    }

    let bytes = embedded_asset(path).or_else(|| disk_asset(path));
    match bytes {
        Some(bytes) => {
            if path == "index.html" {
                let html = String::from_utf8_lossy(&bytes).into_owned();
                // 真 Tauri 窗口不经过这里；浏览器拿到的版本带 shim
                let injected = html.replacen("<head>", SHIM_TAG, 1);
                return Html(injected).into_response();
            }
            let mime = mime_of(path);
            ([(header::CONTENT_TYPE, mime)], bytes).into_response()
        }
        None => (StatusCode::NOT_FOUND, "资源不存在").into_response(),
    }
}

/// release（custom-protocol feature）下 tauri 把 dist 全量编进了 exe，便携单文件可用；
/// dev 下按 frontendDist 磁盘回退（见 AssetResolver::get_for_scheme）
fn embedded_asset(path: &str) -> Option<Vec<u8>> {
    let app = APP.get()?;
    app.asset_resolver().get(path.to_string()).map(|a| a.bytes)
}

/// exe 被单独拷走的兜底：向上找两级目录里的 dist/
fn disk_asset(path: &str) -> Option<Vec<u8>> {
    let exe = std::env::current_exe().ok()?;
    let mut dir = exe.parent()?.to_path_buf();
    for _ in 0..4 {
        let cand = dir.join("dist").join(path);
        if cand.is_file() {
            return std::fs::read(cand).ok();
        }
        dir = dir.parent()?.to_path_buf();
    }
    None
}

fn mime_of(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        _ => "application/octet-stream",
    }
}

/// 运行日志写 logs/web.log（无控制台窗口；日志目录未设置时静默丢弃）。
fn web_log(msg: &str) {
    use std::io::Write;
    let Some(dir) = crate::process::log_dir() else {
        return;
    };
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("web.log"))
    {
        let _ = writeln!(
            f,
            "[{}] {}",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
            msg
        );
    }
}

// ────────────────────────────────────────────────────────────────
// 测试：认证与参数提取
// ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arg_extracts_required_value() {
        let args = serde_json::json!({ "taskId": "t1", "rows": 30 });
        let id: String = arg(&args, "taskId").unwrap();
        assert_eq!(id, "t1");
        let rows: u16 = arg(&args, "rows").unwrap();
        assert_eq!(rows, 30);
        assert!(arg::<String>(&args, "missing").is_err());
    }

    #[test]
    fn opt_arg_handles_missing_and_null() {
        let args = serde_json::json!({ "parentId": null, "toIndex": 2 });
        let p: Option<String> = opt_arg(&args, "parentId").unwrap();
        assert_eq!(p, None);
        let idx: Option<usize> = opt_arg(&args, "toIndex").unwrap();
        assert_eq!(idx, Some(2));
        let none: Option<String> = opt_arg(&args, "absent").unwrap();
        assert_eq!(none, None);
    }

    #[test]
    fn sha256_hex_matches_known_vector() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn new_token_is_unique_and_hex() {
        let t1 = new_token();
        let t2 = new_token();
        assert_ne!(t1, t2);
        assert_eq!(t1.len(), 64);
        assert!(t1.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
