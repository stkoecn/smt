import { useEffect, useState, useCallback } from 'react';
import { Minus, Square, Copy, X } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';

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

    let mounted = true;
    const syncMaximized = () => {
      void invoke<boolean>('window_is_maximized')
        .then((max) => {
          if (mounted) setIsMaximized(max);
        })
        .catch(() => {});
    };

    syncMaximized();
    window.addEventListener('resize', syncMaximized);

    return () => {
      mounted = false;
      window.removeEventListener('resize', syncMaximized);
    };
  }, [runningInTauri]);

  const handleMinimize = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await invoke('window_minimize');
    } catch {
      /* ignore */
    }
  }, []);

  const handleToggleMaximize = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const max = await invoke<boolean>('window_toggle_maximize');
      setIsMaximized(max);
    } catch {
      /* ignore */
    }
  }, []);

  const handleClose = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await invoke('window_close');
    } catch {
      /* ignore */
    }
  }, []);

  // 纯网页端、局域网访问、PWA 安装端不渲染窗口控制按钮
  if (!runningInTauri) {
    return null;
  }

  return (
    <>
      {/* 最小化按钮：与顶栏图标按钮风格、尺寸完全一致 */}
      <button
        type="button"
        tabIndex={-1}
        className="icon-btn w-7 h-7 hover:bg-nav-hover rounded-md text-txt-muted hover:text-txt-primary flex items-center justify-center transition-colors cursor-pointer"
        title="最小化"
        onClick={handleMinimize}
      >
        <Minus size={13} strokeWidth={2} />
      </button>

      {/* 最大化 / 向下还原按钮 */}
      <button
        type="button"
        tabIndex={-1}
        className="icon-btn w-7 h-7 hover:bg-nav-hover rounded-md text-txt-muted hover:text-txt-primary flex items-center justify-center transition-colors cursor-pointer"
        title={isMaximized ? '向下还原' : '最大化'}
        onClick={handleToggleMaximize}
      >
        {isMaximized ? (
          <Copy size={11} strokeWidth={2} className="rotate-180" />
        ) : (
          <Square size={11} strokeWidth={2} />
        )}
      </button>

      {/* 关闭按钮：风格统一，悬停带有柔和微红高亮指示 */}
      <button
        type="button"
        tabIndex={-1}
        className="icon-btn w-7 h-7 rounded-md text-txt-muted hover:text-red-400 hover:bg-red-500/15 active:bg-red-500/25 flex items-center justify-center transition-colors cursor-pointer"
        title="关闭（最小化到托盘）"
        onClick={handleClose}
      >
        <X size={14} strokeWidth={2} />
      </button>
    </>
  );
}
