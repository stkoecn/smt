import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { Play, Square, RotateCw, Trash2 } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { AttachResult, RawOutputEvent } from '@/types';
import { useTaskStore, STATE_LABEL, STARTABLE_STATES } from '@/stores/taskStore';
import { useUIStore } from '@/stores/uiStore';
import { InteractiveButton } from '@/components/InteractiveButton';

interface Props {
  taskId: string;
}

/** base64 → Uint8Array（与 Rust base64_encode 一致的标准 base64） */
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 终端配色（与设置面板联动，默认深色黑窗） */
const TTY_THEME = {
  dark: { background: '#0c0c0c', foreground: '#c8d6c8' },
  light: { background: '#f7f7f8', foreground: '#24292e' },
} as const;

/**
 * 附加的终端黑窗（xterm.js 渲染真实终端）。
 *
 * 数据流（原始字节流协议）：
 * 1. invoke attach_console 读当前运行期的原始终端字节（base64，ANSI 保真）
 *    作为基线，xterm.write(Uint8Array) 一次性重建真实终端画面
 * 2. 订阅 process-output-raw 增量字节事件，直接 write —— 光标、颜色、
 *    进度条、清屏等 ANSI 转义序列全部保真，这就是真实终端
 * 3. 进程（重新）启动时（pid 变化）重新读基线
 * 4. 输入：xterm onData → send_input 命令 → ConPTY
 */
export function ConsoleTab({ taskId }: Props) {
  const holderRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const disposedRef = useRef(false);
  const baselineReadyRef = useRef(false);
  const pendingQueueRef = useRef<Uint8Array[]>([]);
  const [logPath, setLogPath] = useState<string | null>(null);
  const status = useTaskStore((s) => s.statuses[taskId]);
  const ports = useTaskStore((s) => s.ports[taskId]);
  const openBrowser = useTaskStore((s) => s.openBrowser);
  const openLogFolder = useTaskStore((s) => s.openLogFolder);
  const start = useTaskStore((s) => s.start);
  const stop = useTaskStore((s) => s.stop);
  const restart = useTaskStore((s) => s.restart);
  const sendInput = useTaskStore((s) => s.sendInput);
  const termFontSize = useUIStore((s) => s.terminalFontSize);
  const termFontFamily = useUIStore((s) => s.terminalFontFamily);
  const termTheme = useUIStore((s) => s.terminalTheme);
  const fitRef = useRef<FitAddon | null>(null);

  const statusText = status
    ? `${STATE_LABEL[status.state]}${status.pid != null ? ` · PID ${status.pid}` : ''}${
        status.exitCode != null ? ` · 退出码 ${status.exitCode}` : ''
      }${status.error ? ` · ${status.error}` : ''}`
    : '未知状态';

  useEffect(() => {
    const holder = holderRef.current;
    if (!holder) return;
    const ui = useUIStore.getState();
    const ttyTheme = TTY_THEME[ui.terminalTheme];
    holder.style.setProperty('--xterm-bg', ttyTheme.background);
    const term = new Terminal({
      cursorBlink: true,
      fontSize: ui.terminalFontSize,
      fontFamily: ui.terminalFontFamily,
      theme: ttyTheme,
      scrollback: 5000,
      convertEol: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(holder);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    term.focus();

    term.attachCustomKeyEventHandler((event) => {
      // 检查 Ctrl+C / Cmd+C
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
        // 如果当前选中了文本，优先复制选中文本到系统剪贴板
        if (term.hasSelection()) {
          if (event.type === 'keydown') {
            const selection = term.getSelection();
            if (selection) {
              void navigator.clipboard.writeText(selection);
            }
          }
          return false; // 拦截此按键，不将 \x03 (SIGINT) 发送给后台进程
        }
      }
      // 检查 Ctrl+V / Cmd+V 粘贴
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') {
        if (event.type === 'keydown') {
          void navigator.clipboard.readText().then((clipText) => {
            if (clipText) {
              void sendInput(taskId, clipText);
            }
          });
        }
        return false;
      }
      return true;
    });

    const syncSize = () => {
      if (!holder || holder.clientWidth < 10 || holder.clientHeight < 10) return;
      fit.fit();
      const term2 = termRef.current;
      if (term2 && term2.rows > 0 && term2.cols > 0) {
        void invoke('resize_pty', {
          taskId,
          rows: term2.rows,
          cols: term2.cols,
        }).catch(() => {});
      }
    };
    // 延时一帧再 fit 一次，确保 flex 容器尺寸计算稳定
    requestAnimationFrame(() => syncSize());
    // 字体加载完成后再次重新 fit，防止字体异步加载后字符度量变动引发错位
    if (typeof document !== 'undefined' && 'fonts' in document) {
      void document.fonts.ready.then(() => syncSize());
    }
    const onResize = syncSize;
    window.addEventListener('resize', onResize);
    const ro = new ResizeObserver(syncSize);
    ro.observe(holder);

    const unsubData = term.onData((data) => {
      void sendInput(taskId, data);
    });

    return () => {
      unsubData.dispose();
      window.removeEventListener('resize', onResize);
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [taskId, sendInput]);

  // 设置变更 → 即时应用到已打开的终端
  useEffect(() => {
    const holder = holderRef.current;
    const ttyTheme = TTY_THEME[termTheme];
    if (holder) holder.style.setProperty('--xterm-bg', ttyTheme.background);
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = termFontSize;
    term.options.fontFamily = termFontFamily;
    term.options.theme = { ...ttyTheme };
    fitRef.current?.fit();
    void invoke('resize_pty', {
      taskId,
      rows: term.rows,
      cols: term.cols,
    }).catch(() => {});
  }, [termFontSize, termFontFamily, termTheme, taskId]);

  // 订阅原始字节事件 + 基线
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let disposed = false;
    disposedRef.current = false;
    baselineReadyRef.current = false;
    pendingQueueRef.current = [];

    (async () => {
      const un = await listen<RawOutputEvent>('process-output-raw', (e) => {
        if (e.payload.taskId !== taskId) return;
        const bytes = b64ToBytes(e.payload.data);
        if (!baselineReadyRef.current) {
          // 基线未就绪期间暂存增量，防止时序空窗丢字
          pendingQueueRef.current.push(bytes);
          return;
        }
        const term = termRef.current;
        if (!term) return;
        term.write(bytes);
      });
      if (disposed) {
        un();
        return;
      }
      unlisten = un;
      const snap = await invoke<AttachResult>('attach_console', { taskId });
      if (disposed) {
        un();
        return;
      }
      const term = termRef.current;
      if (term && snap.text) {
        // 普通任务：text 是原始终端字节（base64）→ 直接写字节重建终端；
        // 提权任务：text 是日志文本（raw=false），按 UTF-8 文本写。
        if (snap.raw) {
          term.write(b64ToBytes(snap.text));
        } else {
          term.write(snap.text);
        }
      }
      // 回放基线读取期间暂存的增量输出
      if (term && pendingQueueRef.current.length > 0) {
        for (const chunk of pendingQueueRef.current) {
          term.write(chunk);
        }
        pendingQueueRef.current = [];
      }
      setLogPath(snap.logPath);
      baselineReadyRef.current = true;
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [taskId]);

  // 进程（重新）启动 → 全新过程，重读基线
  const prevPid = useRef(status?.pid);
  useEffect(() => {
    if (status?.pid && status.pid !== prevPid.current && status.state === 'starting') {
      baselineReadyRef.current = false;
      pendingQueueRef.current = [];
      const term = termRef.current;
      if (term) term.clear();
      void invoke<AttachResult>('attach_console', { taskId }).then((snap) => {
        const t = termRef.current;
        if (t && snap.text) {
          if (snap.raw) t.write(b64ToBytes(snap.text));
          else t.write(snap.text);
        }
        if (t && pendingQueueRef.current.length > 0) {
          for (const chunk of pendingQueueRef.current) {
            t.write(chunk);
          }
          pendingQueueRef.current = [];
        }
        setLogPath(snap.logPath);
        baselineReadyRef.current = true;
      });
    }
    prevPid.current = status?.pid;
  }, [status?.pid, status?.state, taskId]);

  const canStart = !status || STARTABLE_STATES.includes(status.state);
  const canStop = !!status && ['running', 'starting'].includes(status.state);
  const canRestart = !!status && ['running', 'exited', 'failed', 'error'].includes(status.state);

  return (
    <div className="absolute inset-0 flex flex-col bg-surface">
      <div ref={holderRef} className="flex-1 min-h-0 overflow-hidden" />
      <div className="flex items-center gap-1 sm:gap-1.5 h-8 sm:h-7 px-2 border-t border-border-default shrink-0 bg-nav overflow-x-auto no-scrollbar">
        <InteractiveButton
          title="启动"
          variant="success"
          onClick={() => void start(taskId)}
          disabled={!canStart}
        >
          <Play size={12} className="sm:mr-1" />
          <span className="hidden sm:inline">启动</span>
        </InteractiveButton>
        <InteractiveButton
          title="停止"
          variant="danger"
          onClick={() => void stop(taskId)}
          disabled={!canStop}
        >
          <Square size={12} className="sm:mr-1" />
          <span className="hidden sm:inline">停止</span>
        </InteractiveButton>
        <InteractiveButton
          title="重启"
          variant="accent"
          onClick={() => void restart(taskId)}
          disabled={!canRestart}
        >
          <RotateCw size={12} className="sm:mr-1" />
          <span className="hidden sm:inline">重启</span>
        </InteractiveButton>
        <div className="flex-1 min-w-2" />
        <span className="px-1.5 h-[20px] sm:h-[18px] flex items-center gap-1.5 rounded-sm bg-nav-hover border border-border-default text-[10px] font-mono text-txt-muted shrink-0">
          <span className={`status-dot ${status?.state === 'running' ? 'status-dot-running' : status?.state === 'failed' || status?.state === 'error' ? 'status-dot-error' : 'status-dot-stopped'}`} />
          <span className="truncate max-w-[120px] sm:max-w-[200px]">{statusText || '未知状态'}</span>
        </span>
        {ports?.length ? (
          <span className="flex items-center gap-1 shrink-0">
            {ports.map((url) => (
              <button
                key={url}
                className="px-1.5 py-0.5 text-[11px] rounded-sm text-accent bg-accent/10 hover:bg-accent/20 font-mono transition-colors"
                title={`用浏览器打开 ${url}`}
                onClick={() => void openBrowser(url)}
              >
                {url}
              </button>
            ))}
          </span>
        ) : null}
        <InteractiveButton title="清屏（仅清显示）" onClick={() => termRef.current?.clear()}>
          <Trash2 size={12} />
        </InteractiveButton>
        {logPath && (
          <button
            className="hidden md:inline text-xs text-txt-subtle font-mono truncate max-w-44 lg:max-w-56 hover:text-accent transition-colors"
            title={`打开所在文件夹: ${logPath}`}
            onClick={() => void openLogFolder(logPath)}
          >
            日志: {logPath}
          </button>
        )}
      </div>
    </div>
  );
}