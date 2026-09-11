import { useState } from 'react';
import { TerminalSquare, Sun, Moon, Settings, FolderPlus, FilePlus, Menu } from 'lucide-react';
import { useUIStore } from '@/stores/uiStore';
import { SettingsModal } from '@/components/SettingsModal';

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

  return (
    <div className="flex items-center h-8 sm:h-7 px-2.5 sm:px-2 bg-nav border-b border-border-default gap-1 select-none shrink-0">
      {/* 移动端汉堡菜单触发按钮（仅在小于 md/768px 屏幕展示） */}
      <button
        className="md:hidden icon-btn w-7 h-7 -ml-0.5 text-txt-secondary hover:text-txt-primary active:bg-nav-active"
        title="打开任务列表"
        onClick={toggleMobileDrawer}
      >
        <Menu size={16} />
      </button>

      {/* 品牌标识 */}
      <div className="flex items-baseline gap-1.5 pr-2 sm:pr-3 sm:mr-1 border-r border-border-default/80">
        <TerminalSquare size={15} className="text-accent self-center shrink-0" />
        <span className="text-[13px] font-bold text-txt-primary tracking-wide">SMT</span>
        <span className="hidden sm:inline text-[10px] text-txt-subtle font-normal">Task Manager</span>
      </div>

      {/* 快速新增操作（大屏展示文字，窄屏转为图标） */}
      <div className="flex items-center gap-0.5 flex-1 min-w-0">
        <button
          className="flex items-center h-6 sm:h-6 px-2 py-1 text-xs text-txt-muted hover:text-txt-primary hover:bg-nav-hover active:bg-nav-active rounded transition-colors shrink-0"
          onClick={onNewFolder}
          title="新增文件夹"
        >
          <FolderPlus size={13} className="sm:mr-1 text-txt-subtle" />
          <span className="hidden sm:inline">文件夹</span>
        </button>
        <button
          className="flex items-center h-6 sm:h-6 px-2 py-1 text-xs text-txt-muted hover:text-txt-primary hover:bg-nav-hover active:bg-nav-active rounded transition-colors shrink-0"
          onClick={onNewTask}
          title="新增任务"
        >
          <FilePlus size={13} className="sm:mr-1 text-txt-subtle" />
          <span className="hidden sm:inline">任务</span>
        </button>
      </div>

      {/* 右侧工具按钮 */}
      <div className="flex items-center gap-1 shrink-0">
        <button
          className="icon-btn w-7 h-7 hover:bg-nav-hover rounded-md"
          title={theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题'}
          onClick={toggleTheme}
        >
          {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
        </button>
        <button
          className="icon-btn w-7 h-7 hover:bg-nav-hover rounded-md"
          title="设置（终端字体、字号、配色）"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings size={14} />
        </button>
      </div>
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}