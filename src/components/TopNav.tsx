import { useState, useCallback } from 'react';
import { Sun, Moon, Settings, FolderPlus, FilePlus, Menu } from 'lucide-react';
import { useUIStore } from '@/stores/uiStore';
import { SettingsModal } from '@/components/SettingsModal';
import { WindowControls, isDesktopApp } from '@/components/WindowControls';

interface Props {
  /** 新增任务（打开表单，根目录） */
  onNewTask?: () => void;
  /** 新增文件夹 */
  onNewFolder?: () => void;
}

export function TopNav({ onNewTask, onNewFolder }: Props) {
  const theme = useUIStore((s) => s.theme);
  const toggleTheme = useUIStore((s) => s.toggleTheme);
  const toggleMobileDrawer = useUIStore((s) => s.toggleMobileDrawer);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // 双击标题栏空白区域触发最大化/还原（仅桌面端无边框模式生效）
  const handleDoubleClickTitlebar = useCallback(async () => {
    if (!isDesktopApp()) return;
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().toggleMaximize();
    } catch {
      /* ignore */
    }
  }, []);

  return (
    <header
      data-tauri-drag-region
      onDoubleClick={handleDoubleClickTitlebar}
      className="flex items-center h-8 px-2.5 sm:px-2 bg-nav border-b border-border-default gap-1 select-none shrink-0"
    >
      {/* 移动端汉堡菜单触发按钮（仅在小于 md/768px 屏幕展示） */}
      <button
        type="button"
        className="md:hidden icon-btn w-7 h-7 -ml-0.5 text-txt-secondary hover:text-txt-primary active:bg-nav-active shrink-0 cursor-pointer"
        title="打开任务列表"
        onClick={toggleMobileDrawer}
      >
        <Menu size={16} />
      </button>

      {/* 品牌标识（可拖拽区域） */}
      <div
        data-tauri-drag-region
        className="flex items-center gap-1.5 pr-2 sm:pr-3 sm:mr-1 border-r border-border-default/80 shrink-0 cursor-default"
      >
        <img
          src="/icon-192.png"
          alt="SMT Logo"
          className="w-4 h-4 rounded-xs self-center shrink-0 object-contain shadow-xs pointer-events-none"
        />
        <span className="text-[13px] font-bold text-txt-primary tracking-wide pointer-events-none">SMT</span>
        <span className="hidden sm:inline text-[10px] text-txt-subtle font-normal pointer-events-none">Task Manager</span>
      </div>

      {/* 快速新增操作（大屏展示文字，窄屏转为图标） */}
      <div className="flex items-center gap-0.5 shrink-0">
        <button
          type="button"
          className="flex items-center h-6 px-2 py-1 text-xs text-txt-muted hover:text-txt-primary hover:bg-nav-hover active:bg-nav-active rounded transition-colors shrink-0 cursor-pointer"
          onClick={() => {
            // 移动端/窄屏下立即打开左侧抽屉面板，方便用户查看新建结果
            if (window.matchMedia('(max-width: 767px)').matches) {
              useUIStore.getState().setMobileDrawerOpen(true);
            }
            onNewFolder?.();
          }}
          title="新增文件夹"
        >
          <FolderPlus size={13} className="sm:mr-1 text-txt-subtle" />
          <span className="hidden sm:inline">文件夹</span>
        </button>
        <button
          type="button"
          className="flex items-center h-6 px-2 py-1 text-xs text-txt-muted hover:text-txt-primary hover:bg-nav-hover active:bg-nav-active rounded transition-colors shrink-0 cursor-pointer"
          onClick={onNewTask}
          title="新增任务"
        >
          <FilePlus size={13} className="sm:mr-1 text-txt-subtle" />
          <span className="hidden sm:inline">任务</span>
        </button>
      </div>

      {/* 弹性拖拽空白区域：支持拖动窗口与双击最大化 */}
      <div
        data-tauri-drag-region
        className="flex-1 h-full min-w-4 cursor-default"
      />

      {/* 右侧通用工具按钮 */}
      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          className="icon-btn w-7 h-7 hover:bg-nav-hover rounded-md cursor-pointer"
          title={theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题'}
          onClick={toggleTheme}
        >
          {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
        </button>
        <button
          type="button"
          className="icon-btn w-7 h-7 hover:bg-nav-hover rounded-md cursor-pointer"
          title="设置（终端字体、字号、配色）"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings size={14} />
        </button>
      </div>

      {/* 桌面端专属无边框窗口控制按钮：最小化 / 最大化 / 关闭（网页端不渲染） */}
      <WindowControls />

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </header>
  );
}
