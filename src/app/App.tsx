import { useEffect, useCallback } from 'react';
import { TopNav } from '@/components/TopNav';
import { StatusBar } from '@/components/StatusBar';
import { TaskTreePanel } from '@/components/TaskTreePanel';
import { Workspace } from '@/components/Workspace';
import { useTaskStore } from '@/stores/taskStore';
import { useUIStore, hydrateUISettings } from '@/stores/uiStore';

export default function App() {
  const load = useTaskStore((s) => s.load);
  const setTreeWidth = useUIStore((s) => s.setTreeWidth);

  useEffect(() => {
    void load();
    void hydrateUISettings();
  }, [load]);

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
      <div className="flex flex-1 min-h-0">
        <TaskTreePanel />
        <div
          className="w-1.5 shrink-0 cursor-col-resize flex items-center justify-center group"
          onMouseDown={onResizeStart}
          title="拖动调整面板宽度"
        >
          {/* 常驻分割线去掉，悬停时显示高亮条（拖拽区域仍在，只是视觉无痕） */}
          <div className="w-px h-full bg-transparent group-hover:bg-accent/70 transition-colors" />
        </div>
        <div className="relative flex-1 min-w-0">
          <Workspace />
        </div>
      </div>
      <StatusBar />
    </div>
  );
}