import { useEffect, useState, useCallback } from 'react';
import { Minus, Square, Copy, X } from 'lucide-react';

/**
 * 判断当前是否运行在原生桌面端（Tauri），在网页端 / PWA / 局域网访问时返回 false
 */
export function isDesktopApp(): boolean {
  if (typeof window === 'undefined') return false;
  if ((window as unknown as { __SMT_WEB__?: boolean }).__SMT_WEB__) return false;
  return Boolean(
    (window as unknown as { isTauri?: boolean }).isTauri ||
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ ||
    (window as unknown as { __TAURI__?: unknown }).__TAURI__
  );
}

export function WindowControls() {
  const [runningInTauri] = useState(() => isDesktopApp());
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (!runningInTauri) return;

    let isMounted = true;
    let cleanup: (() => void) | undefined;

    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const appWindow = getCurrentWindow();
        const max = await appWindow.isMaximized();
        if (isMounted) setIsMaximized(max);

        // 监听窗口缩放或还原事件，实时更新最大化图标状态
        const unlisten = await appWindow.onResized(async () => {
          if (!isMounted) return;
          try {
            const currentMax = await appWindow.isMaximized();
            if (isMounted) setIsMaximized(currentMax);
          } catch {
            /* ignore */
          }
        });

        cleanup = unlisten;
      } catch {
        /* ignore */
      }
    })();

    return () => {
      isMounted = false;
      if (cleanup) cleanup();
    };
  }, [runningInTauri]);

  const handleMinimize = useCallback(async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().minimize();
    } catch {
      /* ignore */
    }
  }, []);

  const handleToggleMaximize = useCallback(async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const win = getCurrentWindow();
      await win.toggleMaximize();
      const currentMax = await win.isMaximized();
      setIsMaximized(currentMax);
    } catch {
      /* ignore */
    }
  }, []);

  const handleClose = useCallback(async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().close();
    } catch {
      /* ignore */
    }
  }, []);

  // 纯网页端、局域网访问、PWA 安装端不渲染窗口控制按钮
  if (!runningInTauri) {
    return null;
  }

  return (
    <div className="flex items-center h-full -mr-2.5 sm:-mr-2 ml-1 shrink-0 select-none">
      {/* 最小化 */}
      <button
        type="button"
        tabIndex={-1}
        className="w-11 sm:w-11 h-full flex items-center justify-center text-txt-muted hover:text-txt-primary hover:bg-nav-hover active:bg-nav-active transition-colors cursor-pointer"
        title="最小化"
        onClick={handleMinimize}
      >
        <Minus size={13} strokeWidth={2} />
      </button>

      {/* 最大化 / 向下还原 */}
      <button
        type="button"
        tabIndex={-1}
        className="w-11 sm:w-11 h-full flex items-center justify-center text-txt-muted hover:text-txt-primary hover:bg-nav-hover active:bg-nav-active transition-colors cursor-pointer"
        title={isMaximized ? '向下还原' : '最大化'}
        onClick={handleToggleMaximize}
      >
        {isMaximized ? (
          <Copy size={11} strokeWidth={2} className="rotate-180" />
        ) : (
          <Square size={11} strokeWidth={2} />
        )}
      </button>

      {/* 关闭（悬停为 Windows 原生标准醒目红底） */}
      <button
        type="button"
        tabIndex={-1}
        className="w-11 sm:w-12 h-full flex items-center justify-center text-txt-muted hover:text-white hover:bg-[#e81123] active:bg-[#c4101e] transition-colors cursor-pointer"
        title="关闭"
        onClick={handleClose}
      >
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  );
}
