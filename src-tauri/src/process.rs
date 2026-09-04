//! Managed subprocess framework.
//!
//! Every task definition maps to at most one managed child process:
//!
//! - Windows 上经 `cmd.exe /C <command>` 启动（PATH 解析 + BAT 脚本支持；
//!   所有 stdio 重定向，无控制台闪烁）
//! - stdin 置空（黑窗是只读输出视图）
//! - stdout/stderr 由独立 reader 线程读取
//! - 行按 ~50ms 批量 flush 到前端（避免逐行 IPC）
//! - 任务开启「保存日志」时，每次启动都会在 `<data>/logs/` 生成一个新的
//!   带时间戳的日志文件，从启动到退出全量落盘 —— 无内存缓存，每次重启
//!   都是全新的过程
//! - 停止用 `taskkill /PID <pid> /T /F` 杀整个进程树
//! - reaper 线程只负责等待退出并更新最终状态，绝不主动杀进程
//!   （长运行的后台服务不能被超时误杀）

use std::collections::{BTreeSet, HashMap};
use std::fs::{self, File};
use std::io::{BufWriter, Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use smt_core::{ConsoleLine, ConsoleStream, ProcessStatus, TaskDef};
use tauri::Emitter;

use crate::store;

/// GUI 主进程没有控制台。std `Command` 拉起 netstat/powershell/taskkill 等
/// console 子进程时，Windows 会给每个子进程新建一个可见控制台窗口（黑框闪现）。
/// 所有这类辅助子进程统一加 CREATE_NO_WINDOW；它们走管道通信，不需要控制台。
#[cfg(windows)]
fn hide_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
}

/// Windows 非提权任务用 ConPTY（伪终端）启动：子进程把输出写到控制台，
/// Windows 的 pseudoconsole 会在终端层把宽字符统一转成 UTF-8 字节流，
/// 与 Windows Terminal 行为一致 —— 不需要再关心 wsl.exe 输出 UTF-16LE 之类的细节。
#[allow(unused_imports)]
use portable_pty::{
    native_pty_system, Child as PtyChild, CommandBuilder, MasterPty, PtySize,
};

/// 保留 ConPTY master 直到孩子退出。ConPtyMasterPty 内部是 Arc<Mutex<..>>，
/// 本身就是 Send+Sync，只是 trait object 丢掉了标记；用 newtype 恢复。
#[allow(dead_code)] // 字段仅用于持有 master（drop 时关闭 ConPTY）
struct PtyMaster(Box<dyn MasterPty>);
// SAFETY: portable-pty 各平台 Mmaster（Windows ConPTY / Unix）内部都是
// 可跨线程的句柄封装（Arc<Mutex<..>> / FileDescriptor）。
unsafe impl Send for PtyMaster {}
unsafe impl Sync for PtyMaster {}

/// 进程句柄抽象：普通任务用 ConPTY 子进程（Pty），提权任务仍用 std child（Std，helper）。
enum ChildHandle {
    Std(Child),
    Pty(Box<dyn PtyChild + Send + Sync>),
}

impl ChildHandle {
    /// 查询是否已退出。返回 `Some` 表示已结束（Some(code) / Some(None)），
    /// `None` 表示仍在运行。
    fn exited(&mut self) -> Option<Option<i32>> {
        match self {
            ChildHandle::Std(c) => c.try_wait().ok().flatten().map(|s| s.code()),
            ChildHandle::Pty(c) => c
                .try_wait()
                .ok()
                .flatten()
                .map(|s| Some(s.exit_code() as i32)),
        }
    }

    /// 当前子进程 PID（提权 helper 或 ConPTY 子进程）。
    fn pid(&self) -> Option<u32> {
        match self {
            ChildHandle::Std(c) => Some(c.id()),
            ChildHandle::Pty(c) => c.process_id(),
        }
    }

    fn take_stdout(&mut self) -> Option<std::process::ChildStdout> {
        match self {
            ChildHandle::Std(c) => c.stdout.take(),
            ChildHandle::Pty(_) => None,
        }
    }

    fn take_stderr(&mut self) -> Option<std::process::ChildStderr> {
        match self {
            ChildHandle::Std(c) => c.stderr.take(),
            ChildHandle::Pty(_) => None,
        }
    }
}

/// Abstraction over where process events go. Tauri emits to the frontend;
/// tests use an in-memory sink (no WebView/DLL dependencies).
pub trait EventSink: Send + Sync {
    fn emit_json(&self, event: &str, payload: serde_json::Value);
}

impl EventSink for tauri::AppHandle {
    fn emit_json(&self, event: &str, payload: serde_json::Value) {
        let _ = self.emit(event, payload);
    }
}

pub const OUTPUT_EVENT: &str = "process-output";
pub const STATUS_EVENT: &str = "process-status";
pub const PORT_EVENT: &str = "process-ports";
/// 原始终端字节流（含 ANSI 转义，base64 编码的 UTF-8 字节）：xterm 直接 write。
/// 行式 OUTPUT_EVENT 保留给日志/旧视图，终端显示一律走本事件。
pub const OUTPUT_RAW_EVENT: &str = "process-output-raw";

const FLUSH_INTERVAL: Duration = Duration::from_millis(50);
const STOP_WAIT_TIMEOUT: Duration = Duration::from_secs(5);
const STOP_POLL: Duration = Duration::from_millis(50);
const READ_BUFFER_SIZE: usize = 8192;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 日志文件目录（setup 时设置）。未设置时即使任务开启 save_log 也不落盘。
static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn set_log_dir(dir: PathBuf) {
    let _ = fs::create_dir_all(&dir);
    let _ = LOG_DIR.set(dir);
}

/// 多行命令的临时脚本目录（setup 时设置）。cmd /C 不支持内嵌换行，
/// 多行命令必须写成临时脚本文件再执行。
static SCRIPT_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn set_script_dir(dir: PathBuf) {
    let _ = fs::create_dir_all(&dir);
    let _ = SCRIPT_DIR.set(dir);
}

struct ManagedProc {
    child: Mutex<Option<ChildHandle>>,
    status: Mutex<ProcessStatus>,
    /// desired == Stopped means a user requested stop (→ Stopped status);
    /// otherwise a natural exit is reported as Exited(code).
    desired_stop: Mutex<bool>,
    /// fed by reader threads, drained by the flush thread
    tx: Mutex<Option<Sender<ConsoleLine>>>,
    /// 当前运行期的日志文件（task.save_log 开启时才有）
    log: Mutex<Option<LogFile>>,
    /// 当前运行期的临时脚本文件（多行命令），进程退出后删除
    script: Mutex<Option<PathBuf>>,
    /// 提权启动的入口脚本（admin.vbs，UAC 拉起 wscript.exe 执行），进程退出后删除
    wrapper: Mutex<Option<PathBuf>>,
    /// 是否为提权启动（经 UAC；stdout/stderr 走日志文件回读）
    elevated: Mutex<bool>,
    /// 提权进程的真实 PID（由 PowerShell -PassThru 写入 pid 文件获得）
    real_pid: Mutex<Option<u32>>,
    /// 提权启动的日志文件路径（由提权进程自身写，我们只读尾随）
    tail_log: Mutex<Option<PathBuf>>,
    /// 普通任务经 ConPTY 启动时保留 master（关闭 reader 后 keep pty alive）
    pty_master: Mutex<Option<PtyMaster>>,
    /// ConPTY 输入写端：send_input 往这里写，相当于向终端输入键盘
    pty_writer: Mutex<Option<Box<dyn Write + Send>>>,
    /// 原始终端字节流缓冲（普通模式；供 xterm 附加时重建真实终端画面，
    /// ConPTY 输出是 UTF-8，直接 append 进这里原样保留 ANSI）
    raw: Mutex<Vec<u8>>,
    /// 原始终端字节流发送端（reader 线程 → flush 线程 → `process-output-raw` 事件，
    /// base64 载荷原样保留 ANSI 转义序列，xterm 直接 write 还原真实终端）
    raw_tx: Mutex<Option<Sender<Vec<u8>>>>,
}

/// 原始缓冲上限（约 1 MB）
const RAW_CAP: usize = 1 << 20;

struct LogFile {
    path: PathBuf,
    writer: BufWriter<File>,
}

impl LogFile {
    fn write_line(&mut self, line: &ConsoleLine) {
        let stamp = fmt_hms_ms(line.at);
        let stream = match line.stream {
            ConsoleStream::Stdout => "stdout",
            ConsoleStream::Stderr => "stderr",
        };
        let _ = writeln!(self.writer, "[{stamp}] [{stream}] {}", line.text);
        let _ = self.writer.flush();
    }
}

impl ManagedProc {
    fn new() -> Self {
        Self {
            child: Mutex::new(None),
            status: Mutex::new(ProcessStatus::default()),
            desired_stop: Mutex::new(false),
            tx: Mutex::new(None),
            log: Mutex::new(None),
            script: Mutex::new(None),
            wrapper: Mutex::new(None),
            elevated: Mutex::new(false),
            real_pid: Mutex::new(None),
            tail_log: Mutex::new(None),
            pty_master: Mutex::new(None),
            pty_writer: Mutex::new(None),
            raw: Mutex::new(Vec::new()),
            raw_tx: Mutex::new(None),
        }
    }
}

/// Global registry of managed processes (one per task id).
#[derive(Default)]
pub struct ProcessManager {
    procs: Mutex<HashMap<String, Arc<ManagedProc>>>,
}

type Pid = u32;

impl ProcessManager {
    fn proc(&self, task_id: &str) -> Option<Arc<ManagedProc>> {
        self.procs.lock().unwrap().get(task_id).cloned()
    }

    fn ensure(&self, task_id: String) -> Arc<ManagedProc> {
        let mut map = self.procs.lock().unwrap();
        map.entry(task_id.clone())
            .or_insert_with(|| Arc::new(ManagedProc::new()))
            .clone()
    }

    fn is_live(p: &ManagedProc) -> bool {
        p.child
            .lock()
            .unwrap()
            .as_mut()
            .map(|c| c.exited().is_none())
            .unwrap_or(false)
    }

    /// Current status of every known task (stopped default for unknown ids).
    pub fn statuses(&self, task_ids: &[String]) -> HashMap<String, ProcessStatus> {
        let map = self.procs.lock().unwrap();
        task_ids
            .iter()
            .map(|id| {
                let status = map
                    .get(id)
                    .map(|p| p.status.lock().unwrap().clone())
                    .unwrap_or_default();
                (id.clone(), status)
            })
            .collect()
    }

    /// 控制台附加：状态 + 当前运行期日志文件的全部内容（未开日志则为空串）。
    /// 保留解码文本语义（供旧文本视图与测试断言使用），原始终端字节基线请看
    /// [`attach_console_b64`](Self::attach_console_b64)。
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn attach_console(
        &self,
        task_id: &str,
    ) -> Option<(ProcessStatus, String, Option<String>)> {
        let p = self.proc(task_id)?;
        let status = p.status.lock().unwrap().clone();
        // 普通模式任务：优先返回原始字节流缓冲 —— xterm 可直接重建真实终端
        // 画面（ANSI 保留）；提权任务没有 ConPTY，回退日志文件文本。
        if !*p.elevated.lock().unwrap() {
            let raw = p.raw.lock().unwrap().clone();
            if !raw.is_empty() {
                let text = decode_line(&raw);
                return Some((status, text, None));
            }
        }
        let log_path = p
            .tail_log
            .lock()
            .unwrap()
            .clone()
            .or_else(|| p.log.lock().unwrap().as_ref().map(|l| l.path.clone()));
        match log_path {
            Some(path) => {
                let mut coder = LineCoder::new();
                let mut out = Vec::new();
                if let Ok(bytes) = fs::read(&path) {
                    coder.feed(&bytes, &mut out);
                    coder.finish(&mut out);
                }
                let text = out.join("\n");
                Some((status, text, Some(path.to_string_lossy().into_owned())))
            }
            None => Some((status, String::new(), None)),
        }
    }

    /// 控制台基线（终端视图专用）：普通任务返回原始终端字节流（base64，ANSI
    /// 保真），xterm 直接 `write` 重建真实终端画面；提权任务无 ConPTY，回退日志
    /// 文件文本。第四个字段标记 `text` 是否为 base64 原始字节。
    pub fn attach_console_b64(
        &self,
        task_id: &str,
    ) -> Option<(ProcessStatus, String, Option<String>, bool)> {
        let p = self.proc(task_id)?;
        let status = p.status.lock().unwrap().clone();
        let log_path = p
            .tail_log
            .lock()
            .unwrap()
            .clone()
            .or_else(|| p.log.lock().unwrap().as_ref().map(|l| l.path.clone()));
        // 普通模式任务：raw 缓冲就是原始终端字节流（ANSI 保留）。
        // 缓冲为空（进程刚启动尚无输出）则回退日志文本。
        if !*p.elevated.lock().unwrap() {
            let raw = p.raw.lock().unwrap().clone();
            if !raw.is_empty() {
                let path = log_path.map(|p| p.to_string_lossy().into_owned());
                return Some((status, base64_encode(&raw), path, true));
            }
        }
        // 提权任务 / 普通任务尚无输出：回退日志文件文本
        match log_path {
            Some(path) => {
                let mut coder = LineCoder::new();
                let mut out = Vec::new();
                if let Ok(bytes) = fs::read(&path) {
                    coder.feed(&bytes, &mut out);
                    coder.finish(&mut out);
                }
                let text = out.join("\n");
                Some((status, text, Some(path.to_string_lossy().into_owned()), false))
            }
            None => Some((status, String::new(), None, false)),
        }
    }

    /// Kill every live child (called on app exit).
    pub fn kill_all(&self) {
        let procs: Vec<Arc<ManagedProc>> = self
            .procs
            .lock()
            .unwrap()
            .values()
            .filter(|p| Self::is_live(p))
            .cloned()
            .collect();
        for p in procs {
            let elevated = *p.elevated.lock().unwrap();
            let pid = if elevated {
                *p.real_pid.lock().unwrap()
            } else {
                p.child
                    .lock()
                    .unwrap()
                    .as_ref()
                    .and_then(|c| c.pid())
            };
            if let Some(pid) = pid {
                kill_tree(pid);
            }
        }
    }

    /// 扫描每个存活任务的监听端口，返回 task_id → 可访问 URL 列表。
    ///
    /// 任务经 `cmd /C` 启动，真正监听端口的往往是子进程（如 python），
    /// 所以要先枚举整棵进程树再与 netstat 的 PID 比对。
    pub fn listening_ports(&self) -> HashMap<String, Vec<String>> {
        let mut roots: HashMap<u32, String> = HashMap::new();
        {
            let map = self.procs.lock().unwrap();
            for (id, p) in map.iter() {
                let elevated = *p.elevated.lock().unwrap();
                let pid = if elevated {
                    *p.real_pid.lock().unwrap()
                } else {
                    p.child.lock().unwrap().as_ref().and_then(|c| c.pid())
                };
                if let Some(pid) = pid {
                    roots.insert(pid, id.clone());
                }
            }
        }
        if roots.is_empty() {
            return HashMap::new();
        }
        let root_pids: Vec<u32> = roots.keys().cloned().collect();
        let pid_to_root = process_tree(&root_pids);

        let mut result: HashMap<String, BTreeSet<String>> = HashMap::new();
        #[cfg(windows)]
        {
            let mut cmd = Command::new("netstat");
            cmd.args(["-ano"]);
            hide_window(&mut cmd);
            if let Ok(out) = cmd.output() {
                let text = String::from_utf8_lossy(&out.stdout);
                for line in text.lines() {
                    let cols: Vec<&str> = line.split_whitespace().collect();
                    if cols.len() >= 5
                        && (cols[0] == "TCP" || cols[0] == "TCP6")
                        && cols[3] == "LISTENING"
                    {
                        let Ok(pid) = cols[4].parse::<u32>() else {
                            continue;
                        };
                        let Some(root) = pid_to_root.get(&pid) else {
                            continue;
                        };
                        let Some(task_id) = roots.get(root) else {
                            continue;
                        };
                        let Some(url) = url_for_local(cols[1]) else {
                            continue;
                        };
                        result.entry(task_id.clone()).or_default().insert(url);
                    }
                }
            }
        }
        result
            .into_iter()
            .map(|(k, v)| (k, v.into_iter().collect()))
            .collect()
    }

    pub fn start(
        &self,
        sink: Arc<dyn EventSink>,
        task: TaskDef,
        force_elevated: bool,
    ) -> Result<ProcessStatus, String> {
        let p = self.ensure(task.id.clone());
        Self::start_inner(p, sink, task, force_elevated)
    }

    fn start_inner(
        p: Arc<ManagedProc>,
        sink: Arc<dyn EventSink>,
        task: TaskDef,
        force_elevated: bool,
    ) -> Result<ProcessStatus, String> {
        {
            let mut guard = p.child.lock().unwrap();
            if let Some(c) = guard.as_mut() {
                if c.exited().is_none() {
                    return Err("进程已在运行中".to_string());
                }
            }
        }

        let elevated = force_elevated || task.run_as_admin;
        #[cfg(not(windows))]
        if elevated {
            return Err("以管理员身份运行仅支持 Windows".to_string());
        }
        // 新一轮运行：清掉上一轮的原始缓冲，避免新旧画面混叠
        p.raw.lock().unwrap().clear();

        let mut elevated_launch: Option<ElevatedLaunch> = None;
        let (mut cmd, script) = if elevated {
            let mut el = elevated_launch_command(&task)?;
            let script = el.script.clone();
            let cmd = el.cmd.take().unwrap();
            elevated_launch = Some(el);
            (cmd, script)
        } else {
            shell_command(&task)?
        };
        *p.script.lock().unwrap() = script;
        *p.elevated.lock().unwrap() = elevated;
        if let Some(el) = &elevated_launch {
            *p.wrapper.lock().unwrap() = el.wrapper.clone();
        }
        cmd.env("PYTHONIOENCODING", "utf-8")
            .env("PYTHONUNBUFFERED", "1")
            .stdin(Stdio::null());
        // ConPTY 下 stdout/stderr 都进伪终端，无需设置；提权 helper 的 stdio 也无意义
        for (k, v) in &task.env {
            cmd.env(k, v);
        }
        if let Some(dir) = &task.workdir {
            if std::path::Path::new(dir).is_dir() {
                cmd.current_dir(dir);
            }
        }

        let (child, pid, pty_reader): (ChildHandle, u32, Option<Box<dyn Read + Send>>) =
            if elevated {
                #[cfg(windows)]
                hide_window(&mut cmd);
                let child = match cmd.spawn() {
                    Ok(c) => c,
                    Err(err) => {
                        p.status.lock().unwrap().error(format!("启动失败: {err}"));
                        let status = p.status.lock().unwrap().clone();
                        emit_status(&sink, &task.id, &status);
                        return Err(format!("启动失败: {err}"));
                    }
                };
                let pid = child.id();
                (ChildHandle::Std(child), pid, None)
            } else {
                // 普通任务挂 ConPTY：子进程输出（stdout+stderr 合并）在终端层
                // 统一转成 UTF-8，wsl 之类程序不会再输出 UTF-16LE 造成乱码。
                let size = PtySize {
                    rows: 40,
                    cols: 160,
                    pixel_width: 0,
                    pixel_height: 0,
                };
                let pair = native_pty_system().openpty(size).map_err(|e| {
                    let msg = format!("创建伪终端失败: {e}");
                    p.status.lock().unwrap().error(msg.clone());
                    emit_status(&sink, &task.id, &p.status.lock().unwrap());
                    msg
                })?;
                let builder = std_command_to_pty_builder(&cmd);
                let child = pair.slave.spawn_command(builder).map_err(|e| {
                    let msg = format!("启动失败: {e}");
                    p.status.lock().unwrap().error(msg.clone());
                    emit_status(&sink, &task.id, &p.status.lock().unwrap());
                    msg
                })?;
                let pid = child.process_id().unwrap_or(0);
                // 写端（向 ConPTY 输入）与读端分开保存：读端交给 reader 线程，
                // 写端（take_writer）挂在 pty_writer 供 send_input 使用。
                let writer = pair.master.take_writer().ok();
                let reader = pair
                    .master
                    .try_clone_reader()
                    .map_err(|e| format!("打开伪终端输出失败: {e}"))?;
                *p.pty_writer.lock().unwrap() = writer;
                *p.pty_master.lock().unwrap() = Some(PtyMaster(pair.master));
                (ChildHandle::Pty(child), pid, Some(reader))
            };

        *p.desired_stop.lock().unwrap() = false;
        *p.status.lock().unwrap() = ProcessStatus::starting(Some(pid), now_ms());
        *p.child.lock().unwrap() = Some(child);
        // 每次启动都是全新过程：开启保存日志则新建一个带时间戳的日志文件；
        // 提权任务总是落盘日志（stdout/stderr 无法跨 UAC 管道，必须经文件回读）
        *p.log.lock().unwrap() = if elevated {
            None
        } else if task.save_log {
            LOG_DIR.get().and_then(|dir| {
                let path = dir.join(format!(
                    "{}-{}.log",
                    fmt_file_stamp(now_ms()),
                    sanitize(&task.id)
                ));
                File::create(&path)
                    .ok()
                    .map(|f| LogFile {
                        path,
                        writer: BufWriter::new(f),
                    })
            })
        } else {
            None
        };
        if let Some(el) = &elevated_launch {
            *p.tail_log.lock().unwrap() = Some(el.log.clone());
            spawn_pid_watcher(p.clone(), el.pidfile.clone(), sink.clone(), task.id.clone());
            spawn_log_tailer(p.clone(), el.log.clone());
        }
        emit_status(&sink, &task.id, &p.status.lock().unwrap());
        p.status.lock().unwrap().running();
        emit_status(&sink, &task.id, &p.status.lock().unwrap());

        let (tx, rx) = mpsc::channel::<ConsoleLine>();
        *p.tx.lock().unwrap() = Some(tx);
        let sink2 = sink.clone();
        let task_id2 = task.id.clone();
        std::thread::spawn(move || run_flush(sink2, task_id2, rx));

        // 原始终端字节流通道：reader 攒字节 → run_raw_flush 批量 base64 推前端。
        // 普通任务：ConPTY 合并流直接当原始字节发；提权任务：由 spawn_log_tailer
        // 读日志文件得到原始字节。
        let (raw_tx, raw_rx) = mpsc::channel::<Vec<u8>>();
        *p.raw_tx.lock().unwrap() = Some(raw_tx);
        let sink2b = sink.clone();
        let task_id2b = task.id.clone();
        std::thread::spawn(move || run_raw_flush(sink2b, task_id2b, raw_rx));

        // 普通任务：ConPTY 合并流（stdout+stderr）；提权任务：helper 的 stdio（基本无输出）
        if let Some(reader) = pty_reader {
            spawn_reader(reader, ConsoleStream::Stdout, p.clone());
        } else {
            if let Some(stream) = p.child.lock().unwrap().as_mut().unwrap().take_stdout() {
                spawn_reader(stream, ConsoleStream::Stdout, p.clone());
            }
            if let Some(stream) = p.child.lock().unwrap().as_mut().unwrap().take_stderr() {
                spawn_reader(stream, ConsoleStream::Stderr, p.clone());
            }
        }

        let p2 = p.clone();
        let sink3 = sink.clone();
        std::thread::spawn(move || {
            // 等待进程自然退出或被 stop()/kill_tree 杀掉后，回收并更新最终状态。
            // 注意：绝不在这里做超时强杀 —— 长时间运行的后台服务会被误杀。
            // 退出码只在第一次 try_wait 成功时读取（Std 子进程第二次查询会返回
            // None），之后不再重复查询。
            let code = loop {
                let exited = {
                    let mut guard = p2.child.lock().unwrap();
                    guard.as_mut().and_then(|c| c.exited())
                };
                match exited {
                    Some(code) => break code,
                    None => std::thread::sleep(Duration::from_millis(100)),
                }
            };
            {
                let mut guard = p2.child.lock().unwrap();
                *guard = None;
                *p2.pty_master.lock().unwrap() = None;
                *p2.pty_writer.lock().unwrap() = None;
                *p2.raw_tx.lock().unwrap() = None; // 断开 → raw flush 收尾
            }
            let desired = *p2.desired_stop.lock().unwrap();
            let mut status = p2.status.lock().unwrap();
            if desired {
                status.stopped();
            } else if *p2.elevated.lock().unwrap() && p2.real_pid.lock().unwrap().is_none() {
                // 提权进程从未成功起来（UAC 被取消等），如实报错而不是 Exited(1)
                status.error("以管理员身份启动失败（可能已取消授权）");
            } else {
                // 退出码 0（或未知）→ 正常结束；非 0 → 运行失败。
                // ping / ls 等命令跑完即退出、退出码为 0，不应被当成失败。
                match code {
                    Some(0) | None => status.exited(code),
                    Some(_) => status.failed(code),
                }
            }
            drop(status);
            emit_status(&sink3, &task.id, &p2.status.lock().unwrap());
            // 多行命令的临时脚本文件随进程退出清理
            if let Some(sp) = p2.script.lock().unwrap().take() {
                let _ = fs::remove_file(sp);
            }
            if let Some(sp) = p2.wrapper.lock().unwrap().take() {
                let _ = fs::remove_file(sp);
            }
        });

        let status = p.status.lock().unwrap().clone();
        Ok(status)
    }

    pub fn stop(&self, sink: Arc<dyn EventSink>, task_id: &str) -> Result<ProcessStatus, String> {
        let p = self
            .proc(task_id)
            .ok_or_else(|| "任务进程不存在".to_string())?;
        let pid = {
            let mut guard = p.child.lock().unwrap();
            match guard.as_mut() {
                Some(c) => {
                    if c.exited().is_none() {
                        *p.desired_stop.lock().unwrap() = true;
                        p.status.lock().unwrap().stopping();
                        c.pid()
                    } else {
                        None
                    }
                }
                None => None,
            }
        };
    let Some(pid) = pid else {
        *p.desired_stop.lock().unwrap() = true;
        p.status.lock().unwrap().stopped();
        let status = p.status.lock().unwrap().clone();
        emit_status(&sink, task_id, &status);
        return Ok(status);
    };
        if *p.elevated.lock().unwrap() {
            let real = *p.real_pid.lock().unwrap();
            match real {
                Some(real_pid) => {
                    // 提权进程只能由提权 taskkill 杀（会再弹一次 UAC 确认）；
                    // 用 wscript + vbs 无窗口执行，避免 UAC 拉起 taskkill 时闪现黑框
                    if let Some(dir) = SCRIPT_DIR.get() {
                        let kill_vbs = dir.join(format!(
                            "{}-{}.kill.vbs",
                            fmt_file_stamp(now_ms()),
                            sanitize(task_id)
                        ));
                        let vbs = format!(
                            "Set sh = CreateObject(\"WScript.Shell\")\r\n\
                             cmdLine = sh.ExpandEnvironmentStrings(\"%COMSPEC%\") & \" /C taskkill /PID {pid} /T /F\"\r\n\
                             sh.Run cmdLine, 0, True\r\n",
                            pid = real_pid
                        );
                        if fs::write(&kill_vbs, vbs).is_ok() {
                            let ps = format!(
                                "Start-Process -Verb RunAs -FilePath 'wscript.exe' -ArgumentList @('\"{v}\"')",
                                v = ps_escape(&kill_vbs.to_string_lossy())
                            );
                            let mut c = Command::new("powershell");
                            c.args(["-NoProfile", "-Command", &ps]);
                            hide_window(&mut c);
                            let _ = c.spawn();
                            let vbs_path = kill_vbs.clone();
                            std::thread::spawn(move || {
                                std::thread::sleep(Duration::from_secs(5));
                                let _ = fs::remove_file(vbs_path);
                            });
                        }
                    }
                    // 不能杀 helper：helper 在等提权进程退出；若用户取消 UAC 授权，
                    // 8 秒后兜底杀 helper 以免状态卡在「停止中」
                    let p2 = p.clone();
                    std::thread::spawn(move || {
                        let deadline = Instant::now() + Duration::from_secs(8);
                        while Instant::now() < deadline {
                            let exited = {
                                let mut guard = p2.child.lock().unwrap();
                                guard.as_mut().and_then(|c| c.exited()).is_some()
                            };
                            if exited {
                                return;
                            }
                            std::thread::sleep(STOP_POLL);
                        }
                        let hp = p2.child.lock().unwrap().as_ref().and_then(|c| c.pid());
                        if let Some(hp) = hp {
                            kill_tree(hp);
                        }
                    });
                }
                None => {
                    // 还没拿到真实 PID（启动中/UAC 弹窗期间）：直接杀 helper 兜底
                    kill_tree(pid);
                }
            }
        } else {
            kill_tree(pid);
        }
        emit_status(&sink, task_id, &p.status.lock().unwrap());
        // 不再阻塞等待：reaper 线程会在退出后设置最终状态
        let status = p.status.lock().unwrap().clone();
        Ok(status)
    }

    /// 写入 ConPTY 输入（相当于向附加的终端黑窗发键盘输入）。
    /// 仅普通模式任务可用（有 pty_writer）；提权/已退出任务返回错误。
    pub fn send_input(&self, task_id: &str, data: String) -> Result<(), String> {
        let p = self
            .proc(task_id)
            .ok_or_else(|| format!("任务不存在: {task_id}"))?;
        let mut guard = p.pty_writer.lock().unwrap();
        let w = guard
            .as_mut()
            .ok_or_else(|| "该任务不支持终端输入（提权任务或未在运行）".to_string())?;
        w.write_all(data.as_bytes())
            .map_err(|e| format!("写入终端输入失败: {e}"))?;
        w.flush().map_err(|e| format!("写入终端输入失败: {e}"))
    }

    /// 调整 ConPTY 行列（xterm 窗口尺寸变化时同步）。
    pub fn resize_pty(
        &self,
        task_id: &str,
        rows: u16,
        cols: u16,
    ) -> Result<(), String> {
        let p = self
            .proc(task_id)
            .ok_or_else(|| format!("任务不存在: {task_id}"))?;
        let size = PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        };
        let mut guard = p.pty_master.lock().unwrap();
        let master = guard
            .as_mut()
            .ok_or_else(|| "该任务没有可调整的伪终端".to_string())?;
        master
            .0
            .resize(size)
            .map_err(|e| format!("调整终端尺寸失败: {e}"))
    }

    pub fn restart(&self, sink: Arc<dyn EventSink>, task: TaskDef) -> Result<ProcessStatus, String> {
        let p = self.ensure(task.id.clone());
        p.status.lock().unwrap().restarting();
        emit_status(&sink, &task.id, &p.status.lock().unwrap());
        let _ = self.stop(sink.clone(), &task.id);
        // 等待 reaper 收尾 + 重新启动，放到后台线程避免阻塞 UI
        let p2 = p.clone();
        let sink2 = sink.clone();
        let task_id = task.id.clone();
        std::thread::spawn(move || {
            let deadline = Instant::now() + STOP_WAIT_TIMEOUT;
            loop {
                if p2.child.lock().unwrap().is_none() {
                    break;
                }
                if Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(STOP_POLL);
            }
            let Some(task) = store::store().tree().task(&task_id).cloned() else {
                return;
            };
            let _ = Self::start_inner(p2, sink2, task, false);
        });
        let status = p.status.lock().unwrap().clone();
        Ok(status)
    }
}

fn run_flush(sink: Arc<dyn EventSink>, task_id: String, rx: Receiver<ConsoleLine>) {
    let mut pending: Vec<ConsoleLine> = Vec::new();
    let mut deadline = Instant::now() + FLUSH_INTERVAL;
    loop {
        let wait = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(wait) {
            Ok(line) => pending.push(line),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                if !pending.is_empty() {
                    sink.emit_json(
                        OUTPUT_EVENT,
                        serde_json::json!({ "taskId": task_id, "lines": pending }),
                    );
                }
                break;
            }
        }
        if Instant::now() >= deadline && !pending.is_empty() {
            let batch = std::mem::take(&mut pending);
            sink.emit_json(
                OUTPUT_EVENT,
                serde_json::json!({ "taskId": task_id, "lines": batch }),
            );
            deadline = Instant::now() + FLUSH_INTERVAL;
        }
    }
}

/// 原始终端字节流 flush 线程：把 reader 攒下的字节批按 base64 推给前端
/// （xterm 直接 write 还原，ANSI 转义序列原样保留）。
fn run_raw_flush(sink: Arc<dyn EventSink>, task_id: String, rx: Receiver<Vec<u8>>) {
    let mut pending: Vec<u8> = Vec::new();
    let mut deadline = Instant::now() + FLUSH_INTERVAL;
    loop {
        let wait = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(wait) {
            Ok(chunk) => pending.extend(chunk),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                if !pending.is_empty() {
                    sink.emit_json(
                        OUTPUT_RAW_EVENT,
                        serde_json::json!({ "taskId": task_id, "data": base64_encode(&pending) }),
                    );
                }
                break;
            }
        }
        if Instant::now() >= deadline && !pending.is_empty() {
            let batch = std::mem::take(&mut pending);
            sink.emit_json(
                OUTPUT_RAW_EVENT,
                serde_json::json!({ "taskId": task_id, "data": base64_encode(&batch) }),
            );
            deadline = Instant::now() + FLUSH_INTERVAL;
        }
    }
}

/// 标准 base64 编码（无依赖）。
fn base64_encode(bytes: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = chunk.get(1).copied().unwrap_or(0);
        let b2 = chunk.get(2).copied().unwrap_or(0);
        let n = (u32::from(b0) << 16) | (u32::from(b1) << 8) | u32::from(b2);
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { T[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

fn emit_status(sink: &Arc<dyn EventSink>, task_id: &str, status: &ProcessStatus) {
    sink.emit_json(
        STATUS_EVENT,
        serde_json::json!({ "taskId": task_id, "status": status }),
    );
}

/// Kill the whole process tree on Windows. Tolerant of dead/missing pids.
fn kill_tree(pid: Pid) {
    #[cfg(windows)]
    {
        let mut c = Command::new("taskkill");
        c.args(["/PID", &pid.to_string(), "/T", "/F"]);
        hide_window(&mut c);
        let _ = c.output();
    }
    #[cfg(not(windows))]
    {
        let _ = pid; // POSIX: std::process handles the direct child only
    }
}

/// 枚举进程树：输入根 PID，返回 pid → 所属根 pid 的映射（含根自身）。
/// Windows 下用 PowerShell 一次性取全量 pid/parent 映射后本地构建。
fn process_tree(roots: &[u32]) -> HashMap<u32, u32> {
    let mut out: HashMap<u32, u32> = HashMap::new();
    let mut parent_of: HashMap<u32, u32> = HashMap::new();
    #[cfg(windows)]
    {
        let mut pw = Command::new("powershell");
        pw.args([
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId),$($_.ParentProcessId)\" }",
        ]);
        hide_window(&mut pw);
        if let Ok(pw) = pw.output() {
            for line in String::from_utf8_lossy(&pw.stdout).lines() {
                let mut it = line.trim().splitn(2, ',');
                let (Some(pid), Some(parent)) = (it.next(), it.next()) else {
                    continue;
                };
                if let (Ok(pid), Ok(parent)) = (pid.parse::<u32>(), parent.parse::<u32>()) {
                    parent_of.insert(pid, parent);
                }
            }
        }
    }
    for &root in roots {
        out.insert(root, root);
    }
    // 同一 pid 归到它所属的根；进程可能已退出，容忍缺失
    let mut queue: std::collections::VecDeque<u32> = roots.to_vec().into();
    while let Some(pid) = queue.pop_front() {
        let root = out[&pid];
        let children: Vec<u32> = parent_of
            .iter()
            .filter(|(_, &p)| p == pid)
            .map(|(&c, _)| c)
            .collect();
        for child in children {
            out.insert(child, root);
            queue.push_back(child);
        }
    }
    out
}

/// netstat 本地地址 → 可访问 URL（任意地址绑定映射到 127.0.0.1）。
fn url_for_local(local: &str) -> Option<String> {
    let (addr, port) = local.rsplit_once(':')?;
    if !port.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let host = match addr {
        "0.0.0.0" | "[::]" | "::" => "127.0.0.1".to_string(),
        a => a.to_string(), // 已含 IPv6 方括号则原样保留
    };
    Some(format!("http://{host}:{port}"))
}

/// 在 PATH 中查找可执行文件（Windows 用 `where`，其余用 `which`）。
fn find_on_path(name: &str) -> Option<String> {
    #[cfg(windows)]
    {
        let mut c = Command::new("where.exe");
        c.arg(name);
        hide_window(&mut c);
        let out = c.output().ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        text.lines()
            .map(str::trim)
            .find(|l| !l.is_empty() && !l.starts_with("INFO:"))
            .map(|l| l.to_string())
    }
    #[cfg(not(windows))]
    {
        let out = Command::new("which").arg(name).output().ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        text.lines().map(str::trim).find(|l| !l.is_empty()).map(|l| l.to_string())
    }
}

/// 查找 bash：先 PATH，再兜底 Git for Windows 常见安装路径（不一定在 PATH 上）。
fn find_bash() -> Option<String> {
    if let Some(p) = find_on_path("bash") {
        return Some(p);
    }
    for p in [
        r"C:\Program Files\Git\usr\bin\bash.exe",
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files (x86)\Git\usr\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
    ] {
        if std::path::Path::new(p).is_file() {
            return Some(p.to_string());
        }
    }
    None
}

/// 探测系统可用终端，供新建任务时选择。
pub fn list_shells() -> Vec<ShellOption> {
    let mut out: Vec<ShellOption> = Vec::new();
    #[cfg(windows)]
    {
        out.push(ShellOption {
            id: "cmd".into(),
            name: "CMD".into(),
            exe: find_on_path("cmd").unwrap_or_else(|| "cmd.exe".into()),
            args: "/C <命令>".into(),
        });
        if let Some(p) = find_on_path("powershell") {
            out.push(ShellOption {
                id: "powershell".into(),
                name: "Windows PowerShell".into(),
                exe: p,
                args: "-NoProfile -Command <命令>".into(),
            });
        }
        if let Some(p) = find_on_path("pwsh") {
            out.push(ShellOption {
                id: "pwsh".into(),
                name: "PowerShell 7 (pwsh)".into(),
                exe: p,
                args: "-NoProfile -Command <命令>".into(),
            });
        }
    }
    if let Some(p) = find_bash() {
        out.push(ShellOption {
            id: "bash".into(),
            name: "Bash (Git Bash)".into(),
            exe: p,
            args: "-c <命令> / <脚本>.sh".into(),
        });
    }
    if let Some(p) = find_on_path("python").or_else(|| find_on_path("python3")) {
        out.push(ShellOption {
            id: "python".into(),
            name: "Python".into(),
            exe: p,
            args: "-c <命令> / <脚本>.py".into(),
        });
    }
    if let Some(p) = find_on_path("q") {
        out.push(ShellOption {
            id: "q".into(),
            name: "KDB+ Q".into(),
            exe: p,
            args: "-e <命令> / <脚本>.q".into(),
        });
    }
    out
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellOption {
    pub id: String,
    pub name: String,
    pub exe: String,
    pub args: String,
}

/// 提权启动的完整构造（Windows / UAC）：
/// 1. 始终把命令写成脚本文件（单行也写，避免 cmd 内层引号地狱）
/// 2. 生成 `admin.bat` 包装脚本：`cd` 到任务工作目录后，以 `> log 2>&1` 重定向执行 payload 脚本
///    —— 重定向发生在提权上下文内部，日志文件由提权进程自己写
/// 3. 生成 `admin.vbs`：UAC 拉起的必须是 GUI 子系统进程（wscript.exe），否则会闪黑框；
///    VBS 内用 `WScript.Shell.Exec`（隐藏控制台）跑 cmd.exe，把真实 PID 写入 pid 文件，
///    等进程退出后用其退出码退出（供停止 / 端口扫描 / 退出检测用）
struct ElevatedLaunch {
    cmd: Option<Command>,
    script: Option<PathBuf>,
    wrapper: Option<PathBuf>,
    pidfile: PathBuf,
    log: PathBuf,
}

fn elevated_launch_command(task: &TaskDef) -> Result<ElevatedLaunch, String> {
    #[cfg(not(windows))]
    {
        let _ = task;
        return Err("以管理员身份运行仅支持 Windows".to_string());
    }
    #[cfg(windows)]
    {
        let dir = SCRIPT_DIR.get().ok_or("脚本目录未初始化")?;
        let stamp = fmt_file_stamp(now_ms());
        let tag = sanitize(&task.id);

        let ext = match task.shell.as_deref() {
            Some("powershell" | "pwsh") => "ps1",
            Some("bash") => "sh",
            Some("python") => "py",
            Some("q") => "q",
            _ => "bat",
        };
        let payload = write_script_file(task, ext)?;

        let log = LOG_DIR
            .get()
            .ok_or("日志目录未初始化")?
            .join(format!("{stamp}-{tag}.log"));

        let invoke = match task.shell.as_deref() {
            Some("powershell") => format!(
                r#""{}" -NoProfile -ExecutionPolicy Bypass -File "{}""#,
                find_on_path("powershell").unwrap_or_else(|| "powershell.exe".into()),
                payload.display()
            ),
            Some("pwsh") => format!(
                r#""{}" -NoProfile -ExecutionPolicy Bypass -File "{}""#,
                find_on_path("pwsh").ok_or("未找到 PowerShell 7 (pwsh)，请先安装")?,
                payload.display()
            ),
            Some("bash") => format!(
                r#""{}" "{}""#,
                find_bash().ok_or("未找到 bash（可安装 Git for Windows）")?,
                payload.to_string_lossy().replace('\\', "/")
            ),
            Some("python") => format!(
                r#""{}" "{}""#,
                find_on_path("python")
                    .or_else(|| find_on_path("python3"))
                    .ok_or("未找到 python，请先安装并加入 PATH")?,
                payload.display()
            ),
            Some("q") => format!(
                r#""{}" "{}""#,
                find_on_path("q").ok_or("未找到 q (KDB+)，请先安装并加入 PATH")?,
                payload.display()
            ),
            _ => format!(r#"call "{}""#, payload.display()),
        };
        let wrapper = dir.join(format!("{stamp}-{tag}.admin.bat"));
        let cd_line = match &task.workdir {
            Some(d) if !d.trim().is_empty() && Path::new(d).is_dir() => {
                format!("cd /d \"{}\"\r\n", d)
            }
            _ => String::new(),
        };
        // 提权进程不继承启动方环境变量（连 PYTHONUNBUFFERED 都会丢），
        // 在 wrapper 里显式补齐，否则 python 之类会因 stdout 缓冲导致日志迟迟不落盘。
        // wrapper 以 `> log 2>&1` 重定向执行 payload：重定向发生在提权上下文内部。
        let pidfile = dir.join(format!("{stamp}-{tag}.pid"));
        let env_lines = task
            .env
            .iter()
            .map(|(k, v)| format!("set \"{k}={v}\"\r\n"))
            .collect::<String>();
        let content = format!(
            "@echo off\r\n\
             chcp 65001 >nul\r\n\
             set \"PYTHONUNBUFFERED=1\"\r\n\
             set \"PYTHONIOENCODING=utf-8\"\r\n\
             set \"WSL_UTF8=1\"\r\n\
             {env_lines}{cd_line}{invoke} > \"{log}\" 2>&1\r\n\
             exit /b %errorlevel%\r\n",
            log = log.display(),
        );
        fs::write(&wrapper, content).map_err(|e| format!("写入提权包装脚本失败: {e}"))?;

        // 提权入口必须是 GUI 子系统进程（wscript.exe）——它永远不会创建控制台窗口；
        // VBS 再用 Run(…,0,True)（SW_HIDE）拉起一个隐藏的 PowerShell 执行 payload，
        // 隐藏的 PowerShell 内用 .NET ProcessStartInfo.CreateNoWindow（CREATE_NO_WINDOW，
        // 彻底无控制台窗口）拉起 cmd /C wrapper，并直接拿到 payload 进程的 PID 与退出码。
        let comspec = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into());
        let inner_ps = format!(
            "$w=\"{w}\";$pf=\"{pf}\";\
             $psi=New-Object System.Diagnostics.ProcessStartInfo;\
             $psi.FileName=\"{comspec}\";\
             $q=[char]34;\
             $psi.Arguments=\"/c \"+$q+$q+$w+$q+$q;\
             $psi.UseShellExecute=$false;\
             $psi.CreateNoWindow=$true;\
             try {{$pr=[System.Diagnostics.Process]::Start($psi)}} catch {{[IO.File]::WriteAllText($pf,\"0\");exit 1}};\
             [IO.File]::WriteAllText($pf,[string]$pr.Id);\
             $pr.WaitForExit();\
             exit $pr.ExitCode",
            w = wrapper.to_string_lossy(),
            pf = pidfile.to_string_lossy(),
        );
        let encoded = base64_utf16le(&inner_ps);
        let windir = std::env::var("WINDIR").unwrap_or_else(|_| r"C:\Windows".into());
        let ps_exe = format!(r"{windir}\System32\WindowsPowerShell\v1.0\powershell.exe");
        let vbs = dir.join(format!("{stamp}-{tag}.admin.vbs"));
        let vbs_content = format!(
            "Set sh = CreateObject(\"WScript.Shell\")\r\n\
             Set fso = CreateObject(\"Scripting.FileSystemObject\")\r\n\
             psExe = \"{ps_exe}\"\r\n\
             code = sh.Run(psExe & \" -NoProfile -WindowStyle Hidden -EncodedCommand {enc}\", 0, True)\r\n\
             On Error Resume Next\r\n\
             fso.DeleteFile \"{b}\"\r\n\
             fso.DeleteFile WScript.ScriptFullName\r\n\
             WScript.Quit code\r\n",
            ps_exe = ps_exe,
            enc = encoded,
            b = wrapper.to_string_lossy(),
        );
        fs::write(&vbs, vbs_content).map_err(|e| format!("写入提权启动脚本失败: {e}"))?;

        // PowerShell helper：触发 UAC → 等提权 wscript 退出（它内部经隐藏 PS 等真实进程）
        let ps = format!(
            "try {{ $p = Start-Process -Verb RunAs -PassThru -FilePath 'wscript.exe' -ArgumentList @('\"{v}\"'); if ($p) {{ $p.WaitForExit(); exit ([int]$p.ExitCode) }} else {{ '0' | Out-File -Encoding ascii -FilePath '{pf}' -Force; exit 1 }} }} catch {{ try {{ '0' | Out-File -Encoding ascii -FilePath '{pf}' -Force }} catch {{}}; Write-Output $_; exit 1 }}",
            v = ps_escape(&vbs.to_string_lossy()),
            pf = ps_escape(&pidfile.to_string_lossy()),
        );
        let exe = find_on_path("powershell").unwrap_or_else(|| "powershell.exe".into());
        let mut cmd = Command::new(exe);
        cmd.args([
            "-NoProfile".to_string(),
            "-ExecutionPolicy".to_string(),
            "Bypass".to_string(),
            "-Command".to_string(),
            ps,
        ]);
        Ok(ElevatedLaunch {
            cmd: Some(cmd),
            script: Some(payload),
            wrapper: Some(vbs),
            pidfile,
            log,
        })
    }
}

/// PowerShell 单引号字符串转义（路径含 `'` 时翻倍）。
fn ps_escape(s: &str) -> String {
    s.replace('\'', "''")
}

/// 以 -EncodedCommand 需要的格式（UTF-16LE + Base64）包装 PowerShell 脚本，
/// 避免跨进外层 -Command 字符串时的引号地狱。
fn base64_utf16le(s: &str) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut bytes: Vec<u8> = Vec::with_capacity(s.len() * 2);
    for u in s.encode_utf16() {
        bytes.push((u & 0xff) as u8);
        bytes.push((u >> 8) as u8);
    }
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = chunk.get(1).copied().unwrap_or(0);
        let b2 = chunk.get(2).copied().unwrap_or(0);
        let n = (u32::from(b0) << 16) | (u32::from(b1) << 8) | u32::from(b2);
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { T[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

/// 轮询 pid 文件拿到提权进程真实 PID：成功后更新状态显示并清理 pid 文件。
fn spawn_pid_watcher(
    p: Arc<ManagedProc>,
    pidfile: PathBuf,
    sink: Arc<dyn EventSink>,
    task_id: String,
) {
    std::thread::spawn(move || {
        for _ in 0..600 {
            if let Ok(content) = fs::read_to_string(&pidfile) {
                let trimmed = content.trim();
                if let Ok(pid) = trimmed.parse::<u32>() {
                    if pid > 0 {
                        *p.real_pid.lock().unwrap() = Some(pid);
                        let mut st = p.status.lock().unwrap();
                        st.pid = Some(pid);
                        drop(st);
                        emit_status(&sink, &task_id, &p.status.lock().unwrap());
                    } else {
                        p.status.lock().unwrap().error("以管理员身份启动失败（可能已取消授权）");
                        emit_status(&sink, &task_id, &p.status.lock().unwrap());
                    }
                    let _ = fs::remove_file(&pidfile);
                    return;
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    });
}

/// 尾随提权进程的日志文件，把新增行推入 flush 管线（100ms 轮询）。
fn spawn_log_tailer(p: Arc<ManagedProc>, log_path: PathBuf) {
    std::thread::spawn(move || {
        let mut offset: u64 = 0;
        let mut coder = LineCoder::new();
        let mut lines = Vec::new();
        loop {
            let child_gone = {
                let mut guard = p.child.lock().unwrap();
                guard.as_mut().and_then(|c| c.exited()).is_some()
            };
            if child_gone {
                break;
            }
            if let Ok(mut f) = File::open(&log_path) {
                if let Ok(meta) = f.metadata() {
                    let len = meta.len();
                    if len > offset {
                        let _ = f.seek(std::io::SeekFrom::Start(offset));
                        let mut buf = Vec::with_capacity((len - offset) as usize);
                        let _ = f.read_to_end(&mut buf);
                        offset = len;
                        // 提权日志文件由提权进程以 `> log 2>&1` 写入，已是原始字节 →
                        // 原样进终端流（无 ANSI，主要是 UTF-8/GBK 文本）
                        append_raw(&p, &buf);
                        if let Some(tx) = p.raw_tx.lock().unwrap().as_ref() {
                            let _ = tx.send(buf.clone());
                        }
                        coder.feed(&buf, &mut lines);
                        for ln in &lines {
                            push_line(ConsoleStream::Stdout, ln.as_bytes(), true, &p);
                        }
                        lines.clear();
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        // 进程结束后把日志剩余行补完
        if let Ok(mut f) = File::open(&log_path) {
            if let Ok(meta) = f.metadata() {
                let len = meta.len();
                if len > offset {
                    let _ = f.seek(std::io::SeekFrom::Start(offset));
                    let mut buf = Vec::with_capacity((len - offset) as usize);
                    let _ = f.read_to_end(&mut buf);
                    let mut lines = Vec::new();
                    coder.feed(&buf, &mut lines);
                    coder.finish(&mut lines);
                    // 进程已退：日志剩余字节也补进终端流
                    append_raw(&p, &buf);
                    if let Some(tx) = p.raw_tx.lock().unwrap().as_ref() {
                        let _ = tx.send(buf);
                    }
                    for ln in lines {
                        push_line(ConsoleStream::Stdout, ln.as_bytes(), true, &p);
                    }
                }
            }
        }
    });
}

/// 按任务的终端类型构造启动命令（参数数组直传，无 shell 二次解析，安全）。
///
/// 多行命令写入临时脚本文件再执行：
/// - CMD → .bat（CRLF 行尾，必要时补 `@echo off`）
/// - PowerShell → .ps1（UTF-8 BOM，`-File` 执行）
/// - Bash → .sh（UTF-8，直接交给 bash）
/// 返回的 `Option<PathBuf>` 是脚本文件路径（多行时才有），进程退出后删除。
fn shell_command(task: &TaskDef) -> Result<(Command, Option<PathBuf>), String> {
    let multi = task.command.contains('\n');
    let (exe, args, script): (String, Vec<String>, Option<PathBuf>) =
        match task.shell.as_deref() {
            Some("powershell") => {
                let exe = find_on_path("powershell").unwrap_or_else(|| "powershell.exe".into());
                if multi {
                    let p = write_script_file(task, "ps1")?;
                    (
                        exe,
                        vec![
                            "-NoProfile".into(),
                            "-ExecutionPolicy".into(),
                            "Bypass".into(),
                            "-File".into(),
                            p.to_string_lossy().into_owned(),
                        ],
                        Some(p),
                    )
                } else {
                    (
                        exe,
                        vec!["-NoProfile".into(), "-Command".into(), task.command.clone()],
                        None,
                    )
                }
            }
            Some("pwsh") => {
                let exe = find_on_path("pwsh").ok_or("未找到 PowerShell 7 (pwsh)，请先安装")?;
                if multi {
                    let p = write_script_file(task, "ps1")?;
                    (
                        exe,
                        vec![
                            "-NoProfile".into(),
                            "-ExecutionPolicy".into(),
                            "Bypass".into(),
                            "-File".into(),
                            p.to_string_lossy().into_owned(),
                        ],
                        Some(p),
                    )
                } else {
                    (
                        exe,
                        vec!["-NoProfile".into(), "-Command".into(), task.command.clone()],
                        None,
                    )
                }
            }
            Some("bash") => {
                let exe = find_bash().ok_or("未找到 bash（可安装 Git for Windows）")?;
                if multi {
                    // msys bash 不能直接吃反斜杠路径，转成正斜杠
                    let p = write_script_file(task, "sh")?;
                    let arg = p.to_string_lossy().replace('\\', "/");
                    (exe, vec![arg], Some(p))
                } else {
                    (
                        exe,
                        vec!["-c".into(), task.command.clone()],
                        None,
                    )
                }
            }
            Some("python") => {
                let exe =
                    find_on_path("python").or_else(|| find_on_path("python3")).ok_or("未找到 python，请先安装并加入 PATH")?;
                if multi {
                    let p = write_script_file(task, "py")?;
                    (exe, vec![p.to_string_lossy().into_owned()], Some(p))
                } else {
                    (exe, vec!["-c".into(), task.command.clone()], None)
                }
            }
            Some("q") => {
                let exe = find_on_path("q").ok_or("未找到 q (KDB+)，请先安装并加入 PATH")?;
                if multi {
                    let p = write_script_file(task, "q")?;
                    (exe, vec![p.to_string_lossy().into_owned()], Some(p))
                } else {
                    (exe, vec!["-e".into(), task.command.clone()], None)
                }
            }
            _ => {
                #[cfg(windows)]
                {
                    let exe = find_on_path("cmd").unwrap_or_else(|| "cmd.exe".into());
                    if multi {
                        let p = write_script_file(task, "bat")?;
                        (
                            exe,
                            vec!["/C".into(), p.to_string_lossy().into_owned()],
                            Some(p),
                        )
                    } else {
                        (
                            exe,
                            vec!["/C".into(), task.command.clone()],
                            None,
                        )
                    }
                }
                #[cfg(not(windows))]
                {
                    if multi {
                        let p = write_script_file(task, "sh")?;
                        (
                            "/bin/sh".to_string(),
                            vec![p.to_string_lossy().into_owned()],
                            Some(p),
                        )
                    } else {
                        (
                            "/bin/sh".to_string(),
                            vec!["-c".into(), task.command.clone()],
                            None,
                        )
                    }
                }
            }
        };
    let mut c = Command::new(exe);
    c.args(&args);
    Ok((c, script))
}

/// 把已经配置好的 std `Command`（program/args/env/cwd）转成 portable-pty 的
/// `CommandBuilder`。提权任务不用（走 wrapper 脚本）。
fn std_command_to_pty_builder(cmd: &Command) -> CommandBuilder {
    let mut b = CommandBuilder::new(cmd.get_program());
    b.args(cmd.get_args());
    for (k, v) in cmd.get_envs() {
        if let Some(v) = v {
            b.env(k, v);
        } else {
            b.env_remove(k);
        }
    }
    if let Some(dir) = cmd.get_current_dir() {
        b.cwd(dir);
    }
    b
}

/// 把多行命令写成临时脚本文件并返回路径。
fn write_script_file(task: &TaskDef, ext: &str) -> Result<PathBuf, String> {
    let dir = SCRIPT_DIR.get().ok_or("脚本目录未初始化")?;
    let path = dir.join(format!(
        "{}-{}.{ext}",
        fmt_file_stamp(now_ms()),
        sanitize(&task.id)
    ));
    let mut content = task.command.clone();
    if ext == "bat" {
        content = content.replace('\n', "\r\n");
        // cmd 用系统 ANSI 代码页（中文系统=GBK）解析 .bat，而脚本是 UTF-8，
        // 顶部切到 65001 让中文注释/echo 不乱码，与控制台 UTF-8 解码对齐
        if !content.trim_start().starts_with("@echo off") {
            content = format!("@echo off\r\nchcp 65001 >nul\r\n{content}");
        }
    }
    let mut bytes = content.into_bytes();
    if ext == "ps1" {
        bytes.splice(0..0, [0xEF, 0xBB, 0xBF]); // UTF-8 BOM
    }
    fs::write(&path, bytes).map_err(|e| format!("写入脚本文件失败: {e}"))?;
    Ok(path)
}

/// ConPTY 合并流的部分行 flush 周期：交互式程序（Python REPL、y/n 确认等）
/// 的提示符不带结尾换行，行缓冲会一直攒着。每 PARTIAL_FLUSH_MS 把已收到、
/// 尚未以换行结束的「尾部增量」（相对上次 flush）推给前端，模拟终端实时回显。
const PARTIAL_FLUSH_MS: Duration = Duration::from_millis(80);

/// Reader thread: drain a pipe into the log file (if enabled) + IPC channel.
/// Bytes are split on `\n` and decoded with UTF-8 lossy fallback (GBK output
/// from user scripts degrades to replacement chars instead of crashing).
///
/// 交互式程序（Python 的 `>>>`、`y/n` 确认等）提示符没有结尾换行，read 会一直
/// 阻塞没有新数据，行缓冲会攒住不显示。因此 reader 线程旁起一个定时 flush
/// 线程：每 80ms 把「尚未以换行结束的行」里相对上次已推送的 delta 增量推给
/// 前端，等换行到来时再由 reader 补齐该行余下部分 —— 行为接近真终端。
///
/// 两条输出通道：
/// - raw_tx（原始终端字节流）：每次 read 到的字节原样发给 flush 线程，
///   最终以 base64 事件送到前端 xterm —— ANSI 转义、光标定位、进度条通通保真。
/// - 行式管线（LineCoder → push_line）：供日志落盘与旧「文本视图」使用，
///   ConPTY 输出是 UTF-8，这里也同时给 raw 环形缓冲累积字节。
fn spawn_reader(
    mut stream: impl Read + Send + 'static,
    kind: ConsoleStream,
    proc: Arc<ManagedProc>,
) {
    let coder = Arc::new(Mutex::new(LineCoder::new()));
    // 读线程：喂字节 → 原始字节走 raw；同时切行供日志
    let coder_r = coder.clone();
    let proc_r = proc.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; READ_BUFFER_SIZE];
        loop {
            let n = match stream.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(_) => break,
            };
            // 原始终端流：直接原样转发（ANSI 保真）
            append_raw(&proc_r, &buf[..n]);
            if let Some(tx) = proc_r.raw_tx.lock().unwrap().as_ref() {
                let _ = tx.send(buf[..n].to_vec());
            }
            // 行式日志：仅 push_line 负责切行/剥离 ANSI 落盘
            let mut out = Vec::new();
            coder_r.lock().unwrap().feed(&buf[..n], &mut out);
            for line in out {
                push_line(kind, line.as_bytes(), true, &proc_r);
            }
        }
        let mut lines = Vec::new();
        coder_r.lock().unwrap().finish(&mut lines);
        for ln in lines {
            push_line(kind, ln.as_bytes(), false, &proc_r);
        }
        proc_r.raw_tx.lock().unwrap().take(); // 断开 → raw flush 线程收尾
    });

    // 定时 flush 线程：把未以换行收尾的「部分行」增量推送（日志视图用）。
    let coder_f = coder.clone();
    let proc_f = proc.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(PARTIAL_FLUSH_MS);
        let delta = coder_f.lock().unwrap().flush_partial();
        if let Some(delta) = delta {
            push_line(kind, delta.as_bytes(), false, &proc_f);
        }
    });
}

/// 行解码器：自动识别 UTF-16LE（`wsl.exe` 经管道/重定向输出的是 UTF-16LE，
/// 直接按 UTF-8/GBK 解码必然乱码），其余走 UTF-8 → GBK 回退。
///
/// 支持「部分行」：`feed` 只切出以换行结尾的完整行；留在缓冲里没有换行的
/// 尾部，由 `flush_partial` 按需增量取走（内部记录 `emitted` 位置，保证同一
/// 内容只推一次）。
struct LineCoder {
    utf16: bool,
    pending: Vec<u8>,
    text: String,
    /// 已作为「部分行」推送给前端的字节数（UTF-8 路径，相对 pending 起点 0）
    emitted: usize,
}

impl LineCoder {
    fn new() -> Self {
        Self {
            utf16: false,
            pending: Vec::new(),
            text: String::new(),
            emitted: 0,
        }
    }

    fn feed(&mut self, bytes: &[u8], out: &mut Vec<String>) {
        if !self.utf16 {
            let mut probe = bytes;
            if probe.len() >= 2 && probe.starts_with(&[0xFF, 0xFE]) {
                self.utf16 = true;
                probe = &probe[2..];
            }
            let probe_len = (self.pending.len() + probe.len()).min(512);
            let probe = probe.get(..probe_len).unwrap_or(probe);
            if probe.len() >= 8 {
                let nul = probe.iter().filter(|&&b| b == 0).count();
                // UTF-16LE 文本的 NUL 比例通常在 1/3 以上，UTF-8 输出几乎不含 NUL
                if nul * 3 >= probe.len() {
                    self.utf16 = true;
                }
            }
            if self.utf16 {
                // 跳过数据流开头的 BOM，避免 U+FEFF 混入正文
                if self.pending.is_empty() && bytes.len() >= 2 && bytes.starts_with(&[0xFF, 0xFE]) {
                    self.pending.extend_from_slice(&bytes[2..]);
                    return;
                }
            }
        }
        self.pending.extend_from_slice(bytes);
        if self.utf16 {
            let n = self.pending.len() & !1;
            for pair in self.pending[..n].chunks_exact(2) {
                let u = u16::from_le_bytes([pair[0], pair[1]]);
                self.text
                    .push(char::from_u32(u32::from(u)).unwrap_or('\u{FFFD}'));
            }
            self.pending.drain(..n);
            self.drain_text(out);
        } else {
            self.drain_bytes(out);
        }
    }

    fn finish(&mut self, out: &mut Vec<String>) {
        if self.utf16 {
            if self.pending.len() == 1 {
                self.text.push('\u{FFFD}');
                self.pending.clear();
            }
            if !self.text.is_empty() {
                out.push(self.text.trim_end_matches('\r').to_string());
                self.text.clear();
            }
        } else if self.pending.len() > self.emitted {
            out.push(decode_line(&self.pending[self.emitted..]));
            self.pending.clear();
            self.emitted = 0;
        }
    }

    /// 取「尚未以换行结尾」的部分行增量（以字节计，相对上次已推送处），
    /// 供定时 flush 将交互式提示符实时推给前端。返回 None 表示没有可推内容。
    fn flush_partial(&mut self) -> Option<String> {
        if self.utf16 {
            // UTF-16 路径（ConPTY 已是 UTF-8，此分支基本不可达）：不支持增量部分行
            if !self.text.is_empty() && !self.text.contains('\n') {
                let s = self.text.trim_end_matches('\r').to_string();
                self.text.clear();
                return if s.is_empty() { None } else { Some(s) };
            }
            return None;
        }
        if self.emitted >= self.pending.len() {
            return None;
        }
        let data = &self.pending[self.emitted..];
        if data.contains(&b'\n') {
            // 尾巴里已出现换行：说明这是可切齐的完整行，等 feed/drain 处理，
            // 提前推会与后续整行重复
            return None;
        }
        if data.iter().all(|&b| b == b'\r') {
            self.emitted = self.pending.len();
            return None;
        }
        let s = decode_line(data).trim_end_matches('\r').to_string();
        self.emitted = self.pending.len();
        if s.is_empty() { None } else { Some(s) }
    }

    fn drain_bytes(&mut self, out: &mut Vec<String>) {
        // emitted 由 flush 线程维护；防止高负载交错时越界（此时边界处无新数据）
        let mut start = self.emitted.min(self.pending.len());
        while let Some(rel) = self.pending[start..].iter().position(|&b| b == b'\n') {
            // 换行在 pending 中的绝对下标
            let end = start + rel;
            // 这一行的开头（pending[..emitted]）可能已作为部分行推过，
            // 这里只需补齐 rest，避免和增量冲突
            let tail = &self.pending[self.emitted..end];
            if !tail.is_empty() && !tail.iter().all(|&b| b == b'\r') {
                out.push(decode_line(tail));
            }
            start = end + 1;
            self.emitted = 0;
            self.pending.drain(..start);
            start = 0;
        }
        self.pending.drain(..start);
        if self.pending.len() > READ_BUFFER_SIZE * 4 {
            // pathological single "line" (binary output): force flush
            let from = self.emitted.min(self.pending.len());
            out.push(decode_line(&self.pending[from..]));
            self.pending.clear();
            self.emitted = 0;
        }
    }

    fn drain_text(&mut self, out: &mut Vec<String>) {
        let mut start = 0usize;
        while let Some(rel) = self.text[start..].find('\n') {
            out.push(self.text[start..start + rel].trim_end_matches('\r').to_string());
            start += rel + 1;
        }
        self.text.drain(..start);
        if self.text.len() > READ_BUFFER_SIZE * 8 {
            out.push(self.text.clone());
            self.text.clear();
        }
    }
}

/// 解码一行输出：优先 UTF-8（Python 等按 PYTHONIOENCODING=utf-8 输出）；
/// 失败时回退到 GBK —— Windows 系统程序（ping/ipconfig 等）的中文本地化
/// 输出是 GBK/GB2312 编码。
fn decode_line(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => {
            #[cfg(windows)]
            {
                let (cow, _, _) = encoding_rs::GBK.decode(bytes);
                cow.into_owned()
            }
            #[cfg(not(windows))]
            {
                String::from_utf8_lossy(bytes).into_owned()
            }
        }
    }
}

/// 把原始字节追加进 raw 环形缓冲：超出上限时丢弃最旧的数据。
fn append_raw(proc: &ManagedProc, bytes: &[u8]) {
    let mut raw = proc.raw.lock().unwrap();
    if raw.len() + bytes.len() > RAW_CAP {
        let drop = raw.len() + bytes.len() - RAW_CAP;
        raw.drain(..drop);
    }
    raw.extend_from_slice(bytes);
}

/// eol=true：完整行（以换行收尾）；eol=false：部分行（提示符等，尚未换行）。
/// 仅负责行式日志与旧「文本视图」事件；终端显示走 raw 字节流（由
/// spawn_reader / spawn_log_tailer 直接发 raw_tx），这里不做原始缓冲累积。
fn push_line(kind: ConsoleStream, bytes: &[u8], eol: bool, proc: &ManagedProc) {
    let raw = decode_line(bytes)
        .trim_end_matches(['\r', '\n'])
        .to_string();
    if raw.is_empty() {
        return;
    }
    let line = ConsoleLine {
        at: now_ms(),
        stream: kind,
        text: raw,
        eol,
    };
    if let Some(log) = proc.log.lock().unwrap().as_mut() {
        let plain = ConsoleLine {
            at: line.at,
            stream: line.stream,
            text: decode_line(&strip_ansi_escapes::strip(bytes))
                .trim_end_matches(['\r', '\n'])
                .to_string(),
            eol: true, // 日志落盘总是成行
        };
        log.write_line(&plain);
    }
    if let Some(tx) = proc.tx.lock().unwrap().as_ref() {
        let _ = tx.send(line);
    }
}

/// `HH:MM:SS.mmm`（本地时间，日志行前缀）
fn fmt_hms_ms(ms: u64) -> String {
    use chrono::{TimeZone, Timelike};
    let t = chrono::Local.timestamp_millis_opt(ms as i64).unwrap();
    format!("{:02}:{:02}:{:02}.{:03}", t.hour(), t.minute(), t.second(), t.nanosecond() / 1_000_000)
}

/// `yyyyMMdd-HHmmss-mmm`（本地时间，日志文件名时间戳）
fn fmt_file_stamp(ms: u64) -> String {
    use chrono::{TimeZone, Timelike};
    let t = chrono::Local.timestamp_millis_opt(ms as i64).unwrap();
    format!("{}-{:02}{:02}{:02}-{:03}", t.format("%Y%m%d"), t.hour(), t.minute(), t.second(), t.nanosecond() / 1_000_000)
}

fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use smt_core::ProcessState;

    fn task(command: &str, auto_start: bool) -> TaskDef {
        TaskDef {
            id: "t1".to_string(),
            name: "probe".to_string(),
            folder_id: None,
            command: command.to_string(),
            workdir: None,
            env: Default::default(),
            auto_start,
            auto_attach: false,
            save_log: true,
            shell: None,
            run_as_admin: false,
            dependencies: vec![],
            wait_for_deps: false,
            dep_delay_secs: 5,
            order: 0,
        }
    }

    #[derive(Default)]
    struct TestSink {
        events: std::sync::Mutex<Vec<(String, serde_json::Value)>>,
    }

    impl EventSink for TestSink {
        fn emit_json(&self, event: &str, payload: serde_json::Value) {
            self.events.lock().unwrap().push((event.to_string(), payload));
        }
    }

    fn sink() -> Arc<dyn EventSink> {
        Arc::new(TestSink::default())
    }

    fn wait_until(ms: u64, mut f: impl FnMut() -> bool) -> bool {
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(ms);
        while std::time::Instant::now() < deadline {
            if f() {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        f()
    }

    /// 标准 base64 解码（与 base64_encode 对应，供断言 raw 载荷字节内容）。
    fn b64_decode(b64: &str) -> Vec<u8> {
        const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut rev = [255u8; 256];
        for (i, &c) in T.iter().enumerate() {
            rev[c as usize] = i as u8;
        }
        let mut out = Vec::with_capacity(b64.len() / 4 * 3);
        let b: Vec<u8> = b64
            .bytes()
            .filter(|&c| c != b'=' && !c.is_ascii_whitespace())
            .collect();
        for chunk in b.chunks(4) {
            let n = chunk.len();
            if n == 0 {
                break;
            }
            let mut acc: u32 = 0;
            for &c in chunk.iter().chain(std::iter::repeat(&b'A')).take(4) {
                acc = (acc << 6) | rev[c as usize] as u32;
            }
            let bytes = [((acc >> 16) & 0xFF) as u8, ((acc >> 8) & 0xFF) as u8, (acc & 0xFF) as u8];
            let nout = if n == 4 { 3 } else { n - 1 };
            out.extend_from_slice(&bytes[..nout.min(3)]);
        }
        out
    }

    #[test]
    fn line_coder_decodes_utf16le() {
        // `wsl.exe` 经管道输出 UTF-16LE（含 BOM）模拟
        let text = "Serving HTTP on 0.0.0.0\n已拒绝访问 (E_ACCESSDENIED)\r\n";
        let wide: Vec<u8> = text
            .encode_utf16()
            .flat_map(|u| u.to_le_bytes())
            .collect();
        let mut bytes = vec![0xFFu8, 0xFEu8];
        bytes.extend_from_slice(&wide);

        let mut coder = LineCoder::new();
        let mut out = Vec::new();
        coder.feed(&bytes[..17], &mut out);
        coder.feed(&bytes[17..], &mut out);
        coder.finish(&mut out);
        assert_eq!(
            out,
            vec![
                "Serving HTTP on 0.0.0.0".to_string(),
                "已拒绝访问 (E_ACCESSDENIED)".to_string()
            ]
        );
    }

    #[test]
    fn line_coder_keeps_utf8_path() {
        let mut coder = LineCoder::new();
        let mut out = Vec::new();
        coder.feed(b"hello\xe4\xb8\xad\xe6\x96\x87\nworld", &mut out);
        coder.finish(&mut out);
        assert_eq!(
            out,
            vec!["hello中文".to_string(), "world".to_string()]
        );
    }

    #[test]
    fn utf8_mojibake_falls_back_to_gbk() {
        // 中文 Windows 下 cmd 输出的 GBK 字节（"启动成功"），UTF-8 解码失败应回退
        let gbk = [0xC6, 0xF4, 0xB6, 0xAF, 0xB3, 0xC9, 0xB9, 0xA6, b'\n'];
        let mut coder = LineCoder::new();
        let mut out = Vec::new();
        coder.feed(&gbk, &mut out);
        coder.finish(&mut out);
        assert_eq!(out, vec!["启动成功".to_string()]);
    }

    #[test]
    fn start_captures_output_and_runs() {
        set_log_dir(std::env::temp_dir().join("smt-test-logs"));
        let pm = ProcessManager::default();
        let status = pm.start(sink(), task("echo smt-probe-123", false), false).unwrap();
        assert!(status.pid.is_some());

        let got = wait_until(3000, || {
            pm.attach_console("t1")
                .map(|(_, text, _)| text.contains("smt-probe-123"))
                .unwrap_or(false)
        });
        assert!(got, "output line should reach the log file");

        let _ = pm.stop(sink(), "t1");
        let stopped = wait_until(5000, || {
            pm.statuses(&["t1".to_string()])["t1"].state == ProcessState::Stopped
        });
        assert!(stopped, "stop should end in Stopped state");
    }

    #[test]
    fn no_log_flag_means_no_file() {
        let pm = ProcessManager::default();
        let mut t = task("echo smt-nolog-456", false);
        t.save_log = false;
        pm.start(sink(), t, false).unwrap();
        let got = wait_until(3000, || {
            pm.attach_console("t1")
                .map(|(_, text, path)| text.is_empty() && path.is_none())
                .unwrap_or(false)
        });
        assert!(got, "save_log=false should produce no log file");
        let _ = pm.stop(sink(), "t1");
    }

    #[test]
    fn log_file_is_timestamped_and_per_run() {
        set_log_dir(std::env::temp_dir().join("smt-test-logs"));
        let pm = ProcessManager::default();
        pm.start(sink(), task("echo run-one", false), false).unwrap();
        let got1 = wait_until(3000, || {
            pm.attach_console("t1")
                .and_then(|(_, _, path)| path)
                .is_some()
        });
        assert!(got1, "first run should create a log file");
        let path1 = pm.attach_console("t1").and_then(|(_, _, p)| p).unwrap();
        assert!(path1.contains(".log"), "log path: {path1}");
        let _ = pm.stop(sink(), "t1");
        let stopped = wait_until(5000, || {
            pm.statuses(&["t1".to_string()])["t1"].state == ProcessState::Stopped
        });
        assert!(stopped);

        pm.start(sink(), task("echo run-two", false), false).unwrap();
        let got2 = wait_until(3000, || {
            pm.attach_console("t1")
                .and_then(|(_, _, path)| path)
                .is_some()
        });
        assert!(got2, "second run should create a new log file");
        let path2 = pm.attach_console("t1").and_then(|(_, _, p)| p).unwrap();
        assert_ne!(path1, path2, "each run gets its own file");
        let text2 = wait_until(3000, || {
            pm.attach_console("t1")
                .map(|(_, text, _)| text.contains("run-two"))
                .unwrap_or(false)
        });
        assert!(text2, "second run file should contain new output only");
        let _ = pm.stop(sink(), "t1");
    }

    #[test]
    fn start_twice_rejects() {
        let pm = ProcessManager::default();
        pm.start(sink(), task("ping -n 30 127.0.0.1", false), false).unwrap();
        let err = pm.start(sink(), task("ping -n 30 127.0.0.1", false), false);
        assert!(err.is_err());
        let _ = pm.stop(sink(), "t1");
    }

    #[test]
    fn partial_line_flush_emits_delta() {
        // 交互提示符（如 Python `>>>`）无结尾换行：flush_partial 应增量推送
        let mut coder = LineCoder::new();
        let mut out = Vec::new();
        coder.feed(b">>> ", &mut out);
        assert!(out.is_empty(), "无换行不切行");

        let d1 = coder.flush_partial();
        assert_eq!(d1.as_deref(), Some(">>> "));
        assert!(coder.flush_partial().is_none(), "增量已取走，重复取应为 None");

        // 用户输入 `1+1`，补全部分行 → 只推 delta，不重复
        let mut out2 = Vec::new();
        coder.feed(b"1+1\n", &mut out2);
        assert_eq!(out2, vec!["1+1".to_string()]);
        assert!(coder.flush_partial().is_none(), "行已切齐");

        // 完整行直接切出，不经过 partial
        let mut coder2 = LineCoder::new();
        let mut out3 = Vec::new();
        coder2.feed(b"ok\n", &mut out3);
        assert_eq!(out3, vec!["ok".to_string()]);
    }

    #[test]
    fn send_input_reaches_interactive_pty() {
        #[cfg(windows)]
        {
            set_log_dir(std::env::temp_dir().join("smt-test-logs"));
            let pm = ProcessManager::default();
            let mut t = task("cmd", false); // 无参数 cmd：等输入不退出
            t.shell = Some("cmd".into());
            t.command = "cmd".into();
            pm.start(sink(), t, false).unwrap();

            // cmd 启动后应输出提示（部分行/完整行都可，不阻塞）
            let started = wait_until(5000, || {
                pm.attach_console("t1").is_some()
            });
            assert!(started, "conpty cmd should be attachable");
            // 并行测试负载高时 cmd 提示符初始化慢，多等一会再发输入
            std::thread::sleep(Duration::from_millis(800));

            // 发一条命令并回车
            let input = "echo smt-input-ok-42\r\n";
            pm.send_input("t1", input.to_string()).unwrap();

            let echoed = wait_until(10000, || {
                pm.attach_console("t1")
                    .map(|(_, text, _)| text.contains("smt-input-ok-42"))
                    .unwrap_or(false)
            });
            assert!(echoed, "typed command should be echoed back via conpty");
            let _ = pm.stop(sink(), "t1");
            let _ = wait_until(5000, || {
                pm.statuses(&["t1".to_string()])["t1"].state == ProcessState::Stopped
            });
        }
    }

    /// 行事件协议要区分「完整行」(eol=true) 与「部分行/提示符」(eol=false)：
    /// 交互提示符没有换行，若被当作完整行补上换行，光标会被顶到下一行行首。
    #[test]
    fn line_events_distinguish_prompt_partial_from_complete() {
        #[cfg(windows)]
        {
            let pm = ProcessManager::default();
            let sink = Arc::new(TestSink::default());
            let mut t = task("cmd", false);
            t.shell = Some("cmd".into());
            t.command = "cmd".into();
            pm.start(sink.clone(), t, false).unwrap();

            let started = wait_until(5000, || pm.attach_console("t1").is_some());
            assert!(started, "conpty cmd should be attachable");

            let got = wait_until(5000, || {
                let events = sink.events.lock().unwrap();
                events.iter().any(|(ev, payload)| {
                    if ev != OUTPUT_EVENT {
                        return false;
                    }
                    payload
                        .get("lines")
                        .and_then(|l| l.as_array())
                        .is_some_and(|lines| {
                            lines.iter().any(|ln| {
                                // 完整行：echo 输出以换行收尾，eol 必须为 true
                                ln.get("text")
                                    .and_then(|t| t.as_str())
                                    .is_some_and(|t| t.contains("smt-probe"))
                                    && ln.get("eol").and_then(|e| e.as_bool()) == Some(true)
                            }) || lines.iter().any(|ln| {
                                // 部分行：提示符（如 `C:\...>` 或 `>>> `）无换行，eol 为 false
                                ln.get("eol").and_then(|e| e.as_bool()) == Some(false)
                            })
                        })
                })
            });
            assert!(got, "should observe both eol=true (complete) and eol=false (prompt) lines");

            pm.send_input("t1", "echo smt-probe-eol\r\n".to_string()).unwrap();
            let _ = pm.stop(sink.clone(), "t1");
            let _ = wait_until(5000, || {
                pm.statuses(&["t1".to_string()])["t1"].state == ProcessState::Stopped
            });
        }
    }

    #[test]
    fn zero_exit_natural_exit_reports_exited() {
        let pm = ProcessManager::default();
        pm.start(sink(), task("exit 0", false), false).unwrap();
        let exited = wait_until(5000, || {
            let s = &pm.statuses(&["t1".to_string()])["t1"];
            s.state == ProcessState::Exited && s.exit_code == Some(0)
        });
        assert!(exited, "exit 0 natural exit should end in Exited(code=0)");
    }

    #[test]
    fn nonzero_exit_reports_failed() {
        let pm = ProcessManager::default();
        pm.start(sink(), task("exit 7", false), false).unwrap();
        let failed = wait_until(5000, || {
            let s = &pm.statuses(&["t1".to_string()])["t1"];
            s.state == ProcessState::Failed && s.exit_code == Some(7)
        });
        assert!(failed, "exit 7 should end in Failed(code=7), not Exited");
    }

    #[test]
    fn multiline_command_runs_via_temp_bat() {
        set_log_dir(std::env::temp_dir().join("smt-test-logs"));
        set_script_dir(std::env::temp_dir().join("smt-test-scripts"));
        let pm = ProcessManager::default();
        pm.start(sink(), task("echo multi-a\necho multi-b\necho multi-c", false), false)
            .unwrap();
        let got = wait_until(5000, || {
            pm.attach_console("t1")
                .map(|(_, text, _)| {
                    text.contains("multi-a") && text.contains("multi-b") && text.contains("multi-c")
                })
                .unwrap_or(false)
        });
        assert!(got, "multi-line CMD command should run via temp .bat file");
        let _ = pm.stop(sink(), "t1");
        // 只断言本测试自己的 .bat 脚本被清理：多个测试共享同一个静态 SCRIPT_DIR，
        // 并行运行时其他测试（如 python .py）的临时文件可能仍在，不能断言目录为空
        let cleaned = wait_until(5000, || {
            let dir = SCRIPT_DIR.get().cloned().unwrap_or_default();
            fs::read_dir(&dir)
                .map(|it| {
                    it.flatten()
                        .all(|e| !e.file_name().to_string_lossy().ends_with(".bat"))
                })
                .unwrap_or(true)
        });
        assert!(cleaned, "temp script file should be removed after exit");
    }

    #[test]
    fn python_multiline_runs_via_temp_py() {
        if find_on_path("python").is_none() {
            eprintln!("skipping: python not on PATH");
            return;
        }
        set_log_dir(std::env::temp_dir().join("smt-test-logs"));
        set_script_dir(std::env::temp_dir().join("smt-test-scripts"));
        let pm = ProcessManager::default();
        let mut t = task("x = 21\nprint(f\"py-multiline {x * 2}\")", false);
        t.shell = Some("python".into());
        pm.start(sink(), t, false).unwrap();
        let got = wait_until(5000, || {
            pm.attach_console("t1")
                .map(|(_, text, _)| text.contains("py-multiline 42"))
                .unwrap_or(false)
        });
        assert!(got, "multi-line python command should run via temp .py file");
        let _ = pm.stop(sink(), "t1");
    }

    #[test]
    fn kill_all_clears_live_processes() {
        let pm = ProcessManager::default();
        pm.start(sink(), task("ping -n 30 127.0.0.1", false), false).unwrap();
        pm.kill_all();
        let gone = wait_until(5000, || {
            pm.statuses(&["t1".to_string()])["t1"].state != ProcessState::Running
        });
        assert!(gone);
    }

    #[test]
    fn base64_round_trips_all_padding_cases() {
        // 0/1/2/3 长度补位 + 中文多字节 + 含 ANSI 序列
        let cases: Vec<&[u8]> = vec![
            b"",
            b"a",
            b"ab",
            b"abc",
            b"abcdef",
            "你好".as_bytes(),
            "\x1b[2J\x1b[H\x1b[36mserver on :8000\x1b[0m\r\n".as_bytes(),
        ];
        for c in cases {
            assert_eq!(b64_decode(&base64_encode(c)), c, "roundtrip {c:?}");
        }
        // 标准向量：纯 ASCII "Hello world" 的 base64
        assert_eq!(base64_encode(b"Hello world"), "SGVsbG8gd29ybGQ=");
    }

    #[test]
    fn raw_events_carry_original_ansi_bytes() {
        // raw 事件载荷里必须是 ConPTY 原始字节（ANSI 保真），而不是行式切分文本
        set_log_dir(std::env::temp_dir().join("smt-test-logs"));
        let pm = ProcessManager::default();
        let concrete = Arc::new(TestSink::default());
        let s: Arc<dyn EventSink> = concrete.clone();
        pm.start(s, task("echo smt-raw-probe-789", false), false).unwrap();
        let got = wait_until(3000, || {
            let ev = concrete.events.lock().unwrap();
            ev.iter()
                .any(|(name, payload)| {
                    name == "process-output-raw"
                        && b64_decode(&payload["data"].as_str().unwrap_or(""))
                            .windows(b"smt-raw-probe-789".len())
                            .any(|w| w == b"smt-raw-probe-789")
                })
        });
        assert!(got, "raw byte events should carry the original token bytes");
        let _ = pm.stop(sink(), "t1");
    }
}
