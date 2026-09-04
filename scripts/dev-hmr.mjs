/**
 * HMR 开发启动器（npm run tauri:dev）
 *
 * 项目默认开启 custom-protocol feature（内嵌 dist，保证 release exe 独立运行），
 * 代价是 tauri dev 不连 vite dev server、无热更新。本脚本在开发时临时以
 * `--no-default-features` 编译启动，让窗口走 devUrl(http://localhost:3001)，
 * 前端保存即热更新（vite HMR）。
 *
 * release 构建（npm run tauri:build / 裸 cargo build --release）不经过本脚本，
 * 仍使用默认 feature 内嵌 dist，不受影响。
 *
 * 已知差异：
 * - 无 tauri CLI 的 Rust 文件 watch：改 Rust 需手动重新运行本命令
 * - feature 切换会导致 target 下 dev/release 产物各自全量重编一次
 */
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

// vite 包的 exports 未导出 bin 子路径，require.resolve 会失败，直接按脚本相对位置定位
const VITE_BIN = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));

const DEV_HOSTS = ['http://localhost:3001', 'http://127.0.0.1:3001'];
const READY_TIMEOUT = 20_000;
const isWin = process.platform === 'win32';

/** 探测单个 URL 是否可访问 */
function probe(url) {
  return new Promise((resolve) => {
    try {
      const req = http.get(url, (res) => {
        res.resume();
        resolve(true);
      });
      req.setTimeout(800, () => req.destroy(new Error('timeout')));
      req.on('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

/** 轮询等待 vite dev server 就绪（localhost 可能只绑 IPv6，故两个地址都试） */
async function waitForDevServer(urls, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const u of urls) {
      if (await probe(u)) return u;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/** 终止进程（Windows 用 taskkill 连进程树一起杀，避免残留窗口） */
function killTree(child) {
  if (!child || child.killed) return;
  if (isWin) {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* 已退出则忽略 */
    }
  } else {
    child.kill('SIGTERM');
  }
}

// ── 1. 启动 vite dev server（相当于 tauri CLI 的 beforeDevCommand）──
// 直接用 node 跑 vite 入口，避免 npx + shell（触发 DEP0190 且不安全）
const vite = spawn(process.execPath, [VITE_BIN], { stdio: 'inherit' });
vite.on('error', (err) => {
  console.error('[dev-hmr] 启动 vite 失败:', err.message);
  process.exit(1);
});

const readyUrl = await waitForDevServer(DEV_HOSTS, READY_TIMEOUT);
if (!readyUrl) {
  console.error(`[dev-hmr] ${READY_TIMEOUT / 1000}s 内未等到 vite 就绪，请检查 3001 端口是否被占用`);
  killTree(vite);
  process.exit(1);
}
console.log(`[dev-hmr] vite 就绪（${readyUrl}），开始编译并启动应用（首次会因 feature 切换全量重编，请耐心等待）…`);

// ── 2. 以 no-default-features 编译启动：窗口走 devUrl，vite HMR 生效 ──
const cargo = spawn(
  'cargo',
  ['run', '--manifest-path', 'src-tauri/Cargo.toml', '--no-default-features'],
  { stdio: 'inherit' },
);
cargo.on('error', (err) => {
  console.error('[dev-hmr] 启动 cargo 失败:', err.message);
  killTree(vite);
  process.exit(1);
});
cargo.on('exit', (code) => {
  killTree(vite);
  process.exit(code ?? 0);
});

// Ctrl+C：先杀应用进程树，再清理 vite
const shutdown = () => {
  killTree(cargo);
  killTree(vite);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
