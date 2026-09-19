# SMT Task Manager

轻量进程（服务）管理器桌面与局域网管理应用：把后台服务的启停从黑黑的命令行里解放出来，用一棵任务树 + 多标签实时终端 + Web/PWA 随时随地管理所有进程。

- 技术栈：**Rust + Tauri 2**（后端）+ **React + TypeScript + Vite + Tailwind**（前端）+ **Axum**（Web 桥接）
- 体积：便携独立运行 exe 仅约 **4 ~ 5 MB**（前端资源与静态资产全量内嵌）
- 平台：Windows 桌面客户端（WebView2）+ 全平台现代浏览器 / 局域网访问（Web & PWA）

---

## ✨ 核心特性

- 🌲 **左侧任务树**：文件夹与任务节点树状结构，支持新建、重命名、级联删除与原生指针拖拽排序。
- ⚙️ **灵活的进程宿主**：
  - 自由配置 Shell：支持 CMD、PowerShell、pwsh、Git Bash（自动探测环境变量及常规路径），以及自定义可执行文件路径；
  - 提权执行：支持右键「以管理员身份运行」（触发 Windows UAC 授权）；
  - 依赖关系编排：支持前置依赖任务、自动级联拉起与等待延时。
- 💻 **真实终端体验（xterm.js）**：
  - 基于 ConPTY 原始字节流与 ANSI 序列保真渲染，支持全彩、光标、进度条与交互式键盘输入；
  - 毫秒级防抖刷新，高吞吐并发日志流畅不卡顿；
  - 支持多标签分屏（FlexLayout），双击任务即可弹出独立控制台，关闭黑窗不影响后台进程。
- 🌐 **局域网 Web 访问与 PWA 支持**：
  - 内置 Axum 高性能 Web 桥接服务，浏览器直接访问（默认端口 `3088`，支持密码认证）；
  - 支持作为 **PWA 原生应用** 安装到桌面或手机主屏幕，带全套深色终端霓虹图标与 Maskable 自适应安全区裁切保护；
  - 移动端响应式自适应：抽屉式任务列表，新建文件夹即时唤起侧栏，顶部过滤器自动折叠为纯图标。
- 🔌 **端口智能检测与状态栏**：
  - 自动扫描并识别后台进程监听的网络端口，生成快捷访问链接；
  - 网页端点击端口时在当前浏览器新标签页打开，局域网环境下智能替换为实际访问主机 IP；
  - 底部状态栏实时显示 Web 服务运行端口，支持一键直达。
- 📦 **便携配置与轻量常驻**：
  - 配置集中持久化到 `smt.yaml`，优先读写 exe 同级目录；
  - 系统托盘常驻，支持最小化到托盘；退出时优雅清理所有后台进程树。

---

## 📁 目录结构

```
├── public/                   # Web / PWA 静态资源（manifest.json, sw.js, 图标等）
├── src/                      # 前端源码（React + TS + Vite + Tailwind）
│   ├── app/                  #   应用主入口、主布局与顶层事件绑定
│   ├── components/           #   UI 组件（TaskTreePanel / ConsoleTab / SettingsModal / StatusBar …）
│   ├── stores/               #   zustand 状态管理（taskStore, uiStore）
│   ├── styles/globals.css    #   主题设计与 xterm/FlexLayout 全局样式
│   └── types.ts              #   前后端数据契约类型定义
├── src-tauri/
│   ├── core/                 #   纯 Rust 核心库（任务树 CRUD、状态定义、环形缓冲）
│   ├── icons/                #   桌面端原生多尺寸图标包（.ico, .icns, PNG）
│   ├── src/
│   │   ├── lib.rs            #   Tauri 入口、命令分发、Web 桥接调度、系统托盘
│   │   ├── process.rs        #   ConPTY 终端底层、进程生命周期、Shell 探测、端口监控
│   │   ├── webserver.rs      #   Axum HTTP + WebSocket 纯 Web 服务与会话认证
│   │   ├── store.rs          #   smt.yaml 持久化与数据热迁移
│   │   ├── config.rs         #   便携目录路径计算
│   │   └── tauri_shim.js     #   浏览器端的 Tauri IPC 垫片
│   ├── tauri.conf.json       #   Tauri 2 客户端与安装包配置
│   └── Cargo.toml            #   Rust 依赖与极限 release 编译优化配置
└── scripts/
```

---

## 🛠️ 本地构建与打包（Windows）

### 前置环境
- Node.js 20+
- Rust stable（推荐 `x86_64-pc-windows-msvc`）
- WebView2 运行时（Windows 10/11 通常已自带）

### 1. 前端构建与测试
```bash
# 安装依赖
npm install

# 静态类型检查与代码风格检查
npx tsc --noEmit
npx eslint .

# 前端资源打包构建（输出至 dist/，供内嵌到 exe）
npm run build
```

### 2. 后端单元测试
```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

### 3. 生成便携版 Release 可执行文件（最小体积）
应用在 `src-tauri/Cargo.toml` 中已启用极限体积压缩：
- `opt-level = "z"`（以最小二进制体积为目标优化）
- `lto = "fat"`（跨 Crate 全程序链接时优化）
- `codegen-units = 1`（合并单编译单元，最大化内联与死代码消除）
- `panic = "abort"`（移除栈回溯展开开销）
- `strip = true`（剥离所有调试符号和符号表）

```bash
# 编译便携 release 单文件（产物自动内嵌前端全部 dist 资产）
cargo build --release --manifest-path src-tauri/Cargo.toml

# 产物路径：src-tauri/target/release/smt-task-manager.exe
```

### 4. 生成 NSIS 安装包
```bash
npm run tauri:build -- --bundles nsis
# 产物路径：src-tauri/target/release/bundle/nsis/*-setup.exe
```

---

## 🚀 运行与配置

1. **便携模式**：直接双击运行 `smt-task-manager.exe`。程序会在同目录下生成 `smt.yaml`（若同目录无写权限，则安全回退到 `%AppData%/smt-task-manager`）。
2. **Web 与手机访问**：
   - 打开右上角「设置（齿轮）」面板即可查看当前 Web 服务状态与端口；
   - 可以在局域网设备（如手机、平板）的浏览器直接输入 `http://<电脑IP>:3088` 访问；
   - 手机或电脑浏览器点击地址栏的“安装”按钮，即可作为独立 PWA 原生窗口安装到桌面。
3. **Debug 调试共存**：开发调试模式（Debug）已与 Release 单实例互斥锁解耦，支持开发调试环境与已安装的 Release 服务同时并行运行。

---

## 🏷️ 版本发布

推送 `v*` 格式的 tag 会自动触发 GitHub Actions CI 工作流：
```bash
git tag v1.0.0
git push origin v1.0.0
```
CI 会自动跨阶段完成前端静态检查、Rust 单元测试、便携单可执行文件与 NSIS 安装包的打包，并自动发布到 GitHub Release。

---

> **真诚、友善、团结、专业** —— [LINUX DO](https://linux.do/)