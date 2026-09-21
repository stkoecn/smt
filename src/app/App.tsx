import { useEffect, useCallback, useState } from 'react';
import { TopNav } from '@/components/TopNav';
import { StatusBar } from '@/components/StatusBar';
import { TaskTreePanel } from '@/components/TaskTreePanel';
import { TaskFormModal } from '@/components/TaskFormModal';
import { Workspace } from '@/components/Workspace';
import { useTaskStore } from '@/stores/taskStore';
import { useUIStore, hydrateUISettings } from '@/stores/uiStore';
import { invoke } from '@tauri-apps/api/core';

export default function App() {
  const load = useTaskStore((s) => s.load);
  const createFolder = useTaskStore((s) => s.createFolder);
  const setTreeWidth = useUIStore((s) => s.setTreeWidth);
  const mobileDrawerOpen = useUIStore((s) => s.mobileDrawerOpen);
  const setMobileDrawerOpen = useUIStore((s) => s.setMobileDrawerOpen);
  const newTaskSignal = useUIStore((s) => s.newTaskSignal);
  const newFolderSignal = useUIStore((s) => s.newFolderSignal);
  // 顶栏「新建任务」触发的全局弹窗：挂在 App 层，移动端抽屉关闭时也能弹出
  const [navFormSeq, setNavFormSeq] = useState(0);

  useEffect(() => {
    const init = async () => {
      await load();
      await hydrateUISettings();
      // 前端首帧渲染完毕后，通知桌面端显示主窗口（消除白屏闪烁）
      try {
        await invoke('window_show');
      } catch {
        /* 非 Tauri 桌面端忽略 */
      }
    };
    void init();
  }, [load]);

  // TopNav 全局「新增任务 / 新增文件夹」入口（面板内右键菜单走各自组件，互不影响）
  useEffect(() => {
    if (newTaskSignal === 0) return;
    // setTimeout(0)：避免在 effect 中同步 setState（React lint 级联渲染警告）
    const t = setTimeout(() => setNavFormSeq(newTaskSignal), 0);
    return () => clearTimeout(t);
  }, [newTaskSignal]);
  useEffect(() => {
    if (newFolderSignal === 0) return;
    // 点击新建文件夹立即打开抽屉面板（窄屏/移动端），无延迟
    if (window.matchMedia('(max-width: 767px)').matches) {
      useUIStore.getState().setMobileDrawerOpen(true);
    }
    const t = setTimeout(async () => {
      await createFolder('新建文件夹', null);
    }, 0);
    return () => clearTimeout(t);
  }, [newFolderSignal, createFolder]);

  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const onMove = (ev: MouseEvent) => setTreeWidth(ev.clientX);
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
      };
      document.body.style.cursor = 'col-resize';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      void startX;
    },
    [setTreeWidth],
  );

  return (
    <div className="flex flex-col h-full bg-page text-txt-primary">
      <TopNav
        onNewTask={() => useUIStore.getState().bumpNewTask()}
        onNewFolder={() => useUIStore.getState().bumpNewFolder()}
      />
      <div className="flex flex-1 min-h-0 relative overflow-hidden bg-surface">
        {/* 桌面端常驻任务树面板 */}
        <div className="hidden md:flex h-full shrink-0 relative">
          <TaskTreePanel />
          {/* 左侧面板与终端之间的清晰分割线：高对比实体 1px 线，无任何白色间隙 */}
          <div
            className="relative w-px h-full bg-border-strong hover:bg-accent active:bg-accent cursor-col-resize shrink-0 select-none group transition-colors z-20"
            onMouseDown={onResizeStart}
            title="拖动调整面板宽度"
          >
            {/* 左右扩展 4px 悬浮热区，不占物理宽度，鼠标极易抓取 */}
            <div className="absolute inset-y-0 -left-1 -right-1 cursor-col-resize" />
          </div>
        </div>

        {/* 移动端/窄屏响应式抽屉 (Drawer) */}
        {mobileDrawerOpen && (
          <div className="md:hidden fixed inset-0 z-40 flex">
            {/* 背景遮罩 */}
            <div
              className="fixed inset-0 bg-black/50 backdrop-blur-xs animate-in fade-in duration-200"
              onClick={() => setMobileDrawerOpen(false)}
            />
            {/* 抽屉内容容器 */}
            <div className="relative z-50 w-72 max-w-[85vw] h-full shadow-2xl animate-in slide-in-from-left duration-250 flex flex-col bg-nav border-r border-border-default">
              <TaskTreePanel isMobileDrawer />
            </div>
          </div>
        )}

        {/* 工作区主体（终端标签页） */}
        <div className="relative flex-1 min-w-0 bg-surface">
          <Workspace />
        </div>
      </div>
      <StatusBar />
      {navFormSeq !== 0 && (
        <TaskFormModal
          key={`nav-new-${navFormSeq}`}
          task={null}
          defaultFolderId={null}
          onClose={() => setNavFormSeq(0)}
          onSaved={() => setNavFormSeq(0)}
        />
      )}
    </div>
  );
}