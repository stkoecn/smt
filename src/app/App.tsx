import { useEffect, useCallback, useState } from 'react';
import { TopNav } from '@/components/TopNav';
import { StatusBar } from '@/components/StatusBar';
import { TaskTreePanel } from '@/components/TaskTreePanel';
import { TaskFormModal } from '@/components/TaskFormModal';
import { Workspace } from '@/components/Workspace';
import { useTaskStore } from '@/stores/taskStore';
import { useUIStore, hydrateUISettings } from '@/stores/uiStore';

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
    void load();
    void hydrateUISettings();
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
    const t = setTimeout(async () => {
      await createFolder('新建文件夹', null);
      // 窄屏下新建结果在左侧树里，自动展开抽屉让用户看到，避免"点了没反应"
      if (window.matchMedia('(max-width: 767px)').matches) {
        useUIStore.getState().setMobileDrawerOpen(true);
      }
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
      <div className="flex flex-1 min-h-0 relative overflow-hidden">
        {/* 桌面端常驻任务树面板 */}
        <div className="hidden md:flex h-full shrink-0">
          <TaskTreePanel />
          <div
            className="w-1.5 shrink-0 cursor-col-resize flex items-center justify-center group select-none"
            onMouseDown={onResizeStart}
            title="拖动调整面板宽度"
          >
            <div className="w-px h-full bg-border-default/60 group-hover:bg-accent/80 transition-colors" />
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
        <div className="relative flex-1 min-w-0">
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