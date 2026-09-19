import { useEffect, useState, useMemo } from 'react';
import { Globe } from 'lucide-react';
import { useTaskStore } from '@/stores/taskStore';

function useClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now.toTimeString().slice(0, 8);
}

function parseWebUrl(addr: string | null): { url: string; port: string } | null {
  if (!addr) return null;
  const idx = addr.lastIndexOf(':');
  if (idx === -1) return null;
  const port = addr.slice(idx + 1);
  const rawHost = addr.slice(0, idx);
  const host =
    rawHost === '0.0.0.0' || rawHost === '[::]' || rawHost === '::' || !rawHost
      ? '127.0.0.1'
      : rawHost;
  return {
    url: `http://${host}:${port}`,
    port,
  };
}

export function StatusBar() {
  const statuses = useTaskStore((s) => s.statuses);
  const webStatus = useTaskStore((s) => s.webStatus);
  const openBrowser = useTaskStore((s) => s.openBrowser);
  const clock = useClock();

  useEffect(() => {
    if (!webStatus) {
      void useTaskStore.getState().loadWebStatus();
    }
  }, [webStatus]);

  const webInfo = useMemo(() => {
    if (!webStatus || !webStatus.running) return null;
    return parseWebUrl(webStatus.addr);
  }, [webStatus]);

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
      {webInfo && (
        <button
          type="button"
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-mono text-accent bg-accent/10 hover:bg-accent/20 hover:text-accent-hover transition-colors shrink-0 cursor-pointer"
          title={`点击打开 Web 管理界面 (${webInfo.url})`}
          onClick={() => void openBrowser(webInfo.url)}
        >
          <Globe size={11} className="shrink-0" />
          <span>Web :{webInfo.port}</span>
        </button>
      )}
      <span className="font-mono text-[11px] shrink-0 text-txt-subtle">{clock}</span>
    </div>
  );
}
