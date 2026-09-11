# AGENTS.md — SMT Task Manager

进程（服务）管理器桌面应用：左侧任务树管理后台进程（启动/停止/重启），右侧多标签是每个任务的实时终端（xterm.js），双击节点可在独立 CMD 黑窗挂接进程输出，关闭黑窗不影响后台进程。技术栈：Rust + Tauri 2（后端）+ React 18 + TS + Vite + Tailwind + zustand（前端）。样式参考 `stkoe_portal` 项目的组件与配色。

## 架构速览

- `src-tauri/src/process.rs` — **核心**：进程启停（`cmd /C` 执行任务 command）、ConPTY（portable-pty）、原始字节流输出（base64 编码经事件推送，非文本行）、日志落盘 + tail、脚本文件生成、中文 GBK/UTF-8 自动识别、提权启动（UAC）
- `src-tauri/src/lib.rs` — 命令注册层（22 个 tauri 命令）、`web_dispatch`（Web 桥命令分发）、系统托盘与关闭到托盘、端口监控、自动启动
- `src-tauri/src/webserver.rs` — 纯浏览器/局域网访问桥（axum，默认 `0.0.0.0:3088`，settings 可配 `webEnabled/webPort/webBind/webPassword`）：静态服务（内嵌资产优先、磁盘 dist 兜底、index.html 注入 shim）+ `POST /api/invoke` 命令桥 + `GET /ws` 事件广播；端口被占自动顺延（Windows 下 0.0.0.0 与 127.0.0.1 可并存绑定但回环优先命中具体地址，故绑前探测回环）；设置密码后强制认证（`/api/login` 换 token，invoke 带 `Authorization: Bearer`、WS 带 `?token=`，webPassword 存 SHA-256 hex）；启停/重启走 `web_service_*` 命令（设置面板可操作）；日志写 `logs/web.log`（无控制台输出）
- `src-tauri/src/tauri_shim.js` — 浏览器端 Tauri IPC shim：模拟 `__TAURI_INTERNALS__`（invoke→HTTP、事件→WS、dialog→服务端原生对话框），带全屏登录门（401 自动重弹），前端零修改跑在浏览器里
- `src/components/SettingsModal.tsx` — 终端样式 + 窗口行为 + Web 服务管理（状态/启停/重启/改端口/设密码）
- `src-tauri/src/store.rs` — 配置持久化 `smt.yaml`（`SmtConfig { tasks, settings }`），旧版 `tasks.json` 自动迁移，内置 `python -m http.server 8000` 示例任务
- `src-tauri/src/config.rs` — 便携目录解析：exe 同目录可写则用 exe 目录，否则回退应用数据目录
- `src-tauri/core/` — 纯逻辑核心库：`tree.rs`（任务树增删改查/重名校验）、`state.rs`（ProcessStatus）、`ring.rs`（环形缓冲）
- `src/stores/uiStore.ts` — UI 状态（主题、过滤、弹窗信号），持久化到 localStorage（key `smt-ui-v2`）
- `src/stores/taskStore.ts` — 任务数据状态与命令调用
- `src/components/` — TaskTreePanel（左树+筛选）、ConsoleTab（xterm 终端）、TaskFormModal、SettingsModal、Workspace（flexlayout 多标签）、TopNav、ContextMenu、Modal、InteractiveButton、ScriptEditor、StatusBar

## 构建与验证（每次改动后必须执行）

```bash
npm run build                                    # 前端：tsc -b && vite build -> dist/
cargo test --manifest-path src-tauri/Cargo.toml  # Rust 测试（23 个，含 smt.yaml 迁移用例）
npx tsc --noEmit && npx eslint .                 # 前端静态检查
cargo build --release --manifest-path src-tauri/Cargo.toml  # 便携 exe（内嵌前端资源）
```

发布：推送 `v*` tag 触发 `.github/workflows/release.yaml` 自动构建 + 创建 GitHub Release（含 `pre` 的 tag 标记为 Prerelease）。

## 关键约定 / 踩坑记录（勿破坏）

1. **`custom-protocol` 必须保留为默认 feature**（`Cargo.toml` `default = ["custom-protocol"]`）。tauri 用它区分 dev/prod 上下文（tauri `build.rs`: `dev = !custom_protocol`）；去掉后裸 `cargo build --release` 的 exe 会走 devUrl 导致前端空白。开发热更新走 `npm run tauri:dev`（即 `scripts/dev-hmr.mjs`）：临时以 `--no-default-features` 编译让窗口连 vite devUrl(3001) 实现 HMR；`tauri build` / 裸 `cargo build --release` 仍走默认 feature 内嵌 dist。注意：HMR 模式无 Rust watch（改 Rust 需重跑 `npm run tauri:dev`），且 dev/release 因 feature 不同会各自全量重编一次。
2. **托盘 `TrayIcon` 句柄必须保活**：`TrayIcon` 是引用计数资源，最后一个句柄 drop 时图标即从系统托盘移除（表现为右键无菜单——用户右键的是残留幽灵图标）。当前用全局 `static TRAY: OnceLock<TrayIcon>` 持有。
3. **uiStore 持久化必须 `partialize`**：`newTaskSignal`/`newFolderSignal` 等瞬态信号禁止写入 localStorage（曾导致：启动时自动弹「新建任务」弹窗，且弹窗遮罩使左侧按钮点不动）。
4. **发布版体积压到极致**：release profile 为 `lto="fat" + codegen-units=1 + opt-level="z" + panic="abort" + strip`（约 3.5MB）。改 profile 前确认体积不反弹。前端已移除 Monaco，用 textarea 编辑脚本。
5. **终端协议是字节流**：输出以 base64 字节块经 `console-raw` 事件推送（xterm 需 `raw` 解码），不是按行文本；行号/缓冲逻辑在 `process.rs` 的 `append_raw/push_line`。
6. **进程清理**：窗口关闭默认最小化到托盘（设置 `closeToTray`，默认开启），仅「退出」时 `kill_all` 全部后台进程树。
7. **改前端后必须重新构建**：`npm run build`（vite 产物被编译期嵌入 exe），再跑 `cargo build --release`，否则 exe 内是旧资源。
8. **全局单实例**：`tauri-plugin-single-instance` 保证第二次启动直接唤起已有实例（`show_main_window`），不会再开新窗口。
9. **事件双通道**：所有事件必须走 `EventSink::emit_json`（AppHandle 实现 = Tauri emit + `webserver::broadcast_event`），直接调 `app.emit()` 会漏掉浏览器端；命令分发新命令时记得在 `lib.rs::web_dispatch` 加分支。
10. **Web 认证默认关闭**：`webPassword` 为空 = 免认证；设置后所有 `/api/invoke` 与 `/ws` 都要 token（内存 HashSet，应用重启即失效重登）。设置面板保存密码是 SHA-256 hex（前端 Web Crypto 计算），登录校验实时读 settings，改密码无需重启服务。

## 版本与发布

- 版本号三处需保持一致：`package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml`（当前 `1.0.0-pre`）。
- 打 tag：`git tag v1.0.0-pre && git push origin v1.0.0-pre` 即触发 CI 发布。
- 发布产物：NSIS 安装包（`bundle/nsis/*-setup.exe`）+ 便携 exe（`target/release/smt-task-manager.exe`）。
