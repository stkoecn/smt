import { useEffect, useState } from 'react';
import { useTaskStore } from '@/stores/taskStore';

function useClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now.toTimeString().slice(0, 8);
}

export function StatusBar() {
  const statuses = useTaskStore((s) => s.statuses);
  const clock = useClock();

  let running = 0;
  let stopped = 0;
  let exited = 0;
  let failed = 0;
  let error = 0;
  let transitional = 0;
  for (const st of Object.values(statuses)) {
    if (st.state === 'running') running++;
    else if (st.state === 'stopped') stopped++;
    else if (st.state === 'exited') exited++;
    else if (st.state === 'failed') failed++;
    else if (st.state === 'error') error++;
    else transitional++;
  }
  const total = Object.keys(statuses).length;

  return (
    <div className="flex items-center h-6 px-2 gap-2 sm:gap-3 bg-nav border-t border-border-default shrink-0 text-xs tabular-nums text-txt-muted select-none overflow-x-auto no-scrollbar">
      <span className="flex items-center gap-1 shrink-0">
        <span className={`status-dot ${running > 0 ? 'status-dot-running' : 'status-dot-stopped'}`} />
        {running} 运行中
      </span>
      {transitional > 0 && <span className="hidden xs:inline shrink-0">{transitional} 转换中</span>}
      <span className="hidden sm:inline shrink-0">{stopped} 已停止</span>
      {exited > 0 && <span className="hidden md:inline shrink-0">{exited} 已结束</span>}
      {(failed > 0 || error > 0) && (
        <span className="text-financial-down shrink-0 font-medium">
          {failed > 0 ? `${failed} 失败` : ''}
          {failed > 0 && error > 0 ? ' · ' : ''}
          {error > 0 ? `${error} 异常` : ''}
        </span>
      )}
      <span className="hidden sm:inline shrink-0">共 {total} 个任务</span>
      <div className="flex-1 min-w-2" />
      <span className="font-mono text-[11px] shrink-0 text-txt-subtle">{clock}</span>
    </div>
  );
}
