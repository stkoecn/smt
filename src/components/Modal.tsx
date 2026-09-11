import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}

export function Modal({ title, onClose, children, width = 460 }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-xs p-0 sm:p-4 animate-in fade-in duration-200"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="bg-surface border-t sm:border border-border-default rounded-t-xl sm:rounded-lg shadow-2xl flex flex-col max-h-[92vh] w-full sm:w-auto animate-in slide-in-from-bottom-6 sm:zoom-in-95 duration-200"
        style={{ maxWidth: '100vw', width: `min(${width}px, 100vw)` }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between h-9 sm:h-8 px-3.5 sm:px-3 border-b border-border-default shrink-0 bg-nav/50 rounded-t-xl sm:rounded-t-lg">
          <span className="text-xs font-semibold text-txt-primary truncate">{title}</span>
          <button className="icon-btn w-6 h-6 hover:bg-nav-hover rounded" title="关闭" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <div className="overflow-y-auto flex-1 min-h-0 overscroll-contain">{children}</div>
      </div>
    </div>
  );
}