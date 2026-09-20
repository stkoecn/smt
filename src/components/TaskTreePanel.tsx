import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  Play,
  Square,
  RotateCw,
  FolderPlus,
  FolderTree,
  FilePlus,
  TerminalSquare,
  RefreshCw,
  Filter,
  GripVertical,
  List,
} from 'lucide-react';
import type { TreeNode, TaskDef } from '@/types';
import { useTaskStore, buildTree, siblingsOf, STARTABLE_STATES } from '@/stores/taskStore';
import { useUIStore, type TreeFilter } from '@/stores/uiStore';
import { openConsoleTab, closeConsoleTab } from '@/components/Workspace';
import { ContextMenu, type ContextMenuItem } from '@/components/ContextMenu';
import { TaskFormModal } from '@/components/TaskFormModal';
import { Modal } from '@/components/Modal';

type MenuState =
  | { kind: 'task'; id: string; x: number; y: number }
  | { kind: 'folder'; id: string; x: number; y: number }
  | { kind: 'blank'; x: number; y: number };

interface FormState {
  task: TaskDef | null;
  defaultFolderId: string | null;
}

interface RenameState {
  kind: 'folder';
  id: string;
  name: string;
}

function stateColor(state: string): string {
  if (state === 'running') return 'status-dot-running';
  // 退出码 0 自然结束 = 正常完成，灰色点；只有失败/异常才是红色
  if (state === 'failed' || state === 'error') return 'status-dot-error';
  if (state === 'starting' || state === 'stopping' || state === 'restarting') return 'status-dot-starting';
  return 'status-dot-stopped';
}

const RUNNABLE_STATES = ['running', 'exited', 'failed', 'error'];

/** 筛选 chip 的纯图标形态：面板过窄时替代文字（状态点与任务树视觉语言一致） */
const CHIP_ICONS: Record<TreeFilter, React.ReactNode> = {
  all: <List size={12} />,
  running: <span className="status-dot status-dot-running" />,
  stopped: <span className="status-dot status-dot-stopped" />,
  error: <span className="status-dot status-dot-error" />,
};

/** 文件夹内的任务总数与运行数（含子文件夹） */
function folderStats(node: Extract<TreeNode, { kind: 'folder' }>, statuses: Record<string, string>): [number, number] {
  let total = 0;
  let running = 0;
  const walk = (n: TreeNode) => {
    if (n.kind === 'task') {
      total++;
      if (statuses[n.data.id] === 'running') running++;
    } else {
      for (const c of n.children) walk(c);
    }
  };
  for (const c of node.children) walk(c);
  return [total, running];
}

/** 按 id 在树中查找节点 */
function findNode(nodes: TreeNode[], id: string): TreeNode | null {
  for (const n of nodes) {
    if (n.data.id === id) return n;
    if (n.kind === 'folder') {
      const hit = findNode(n.children, id);
      if (hit) return hit;
    }
  }
  return null;
}

/** 节点下所有任务 id（含子文件夹） */
function collectTaskIds(node: TreeNode): string[] {
  return node.kind === 'task' ? [node.data.id] : node.children.flatMap(collectTaskIds);
}

/** 节点自身及其所有子文件夹 id */
function collectFolderIds(node: TreeNode): string[] {
  return node.kind === 'folder' ? [node.data.id, ...node.children.flatMap(collectFolderIds)] : [];
}

interface TaskTreePanelProps {
  /** 是否以移动端抽屉形式展示 */
  isMobileDrawer?: boolean;
}

export function TaskTreePanel({ isMobileDrawer = false }: TaskTreePanelProps) {
  const folders = useTaskStore((s) => s.folders);
  const tasks = useTaskStore((s) => s.tasks);
  const statuses = useTaskStore((s) => s.statuses);
  const ports = useTaskStore((s) => s.ports);
  const openBrowser = useTaskStore((s) => s.openBrowser);
  const ready = useTaskStore((s) => s.ready);
  const start = useTaskStore((s) => s.start);
  const startElevated = useTaskStore((s) => s.startElevated);
  const stop = useTaskStore((s) => s.stop);
  const restart = useTaskStore((s) => s.restart);
  const createTask = useTaskStore((s) => s.createTask);
  const createFolder = useTaskStore((s) => s.createFolder);
  const renameFolder = useTaskStore((s) => s.renameFolder);
  const deleteFolder = useTaskStore((s) => s.deleteFolder);
  const deleteTask = useTaskStore((s) => s.deleteTask);
  const refresh = useTaskStore((s) => s.refresh);
  const treeWidth = useUIStore((s) => s.treeWidth);
  const collapsed = useUIStore((s) => s.collapsed);
  const toggleCollapsed = useUIStore((s) => s.toggleCollapsed);
  const filter = useUIStore((s) => s.treeFilter);
  const setFilter = useUIStore((s) => s.setTreeFilter);
  const setMobileDrawerOpen = useUIStore((s) => s.setMobileDrawerOpen);

  const [menu, setMenu] = useState<MenuState | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [formSeq, setFormSeq] = useState(0);
  const [rename, setRename] = useState<RenameState | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [dragging, setDragging] = useState<{ id: string; kind: 'folder' | 'task' } | null>(null);
  // 删除确认（防误删：文件夹删除会级联删除子项并停止运行中的进程）
  const [delConfirm, setDelConfirm] = useState<{ kind: 'task' | 'folder'; id: string; name: string } | null>(null);

  // 筛选 chips 可用宽度不足时切换为纯图标（文字版需要约 240px），避免挤压错乱；移动端抽屉始终使用纯图标
  const chipsRef = useRef<HTMLDivElement>(null);
  const [narrowChips, setNarrowChips] = useState(false);
  useEffect(() => {
    if (isMobileDrawer) return;
    const el = chipsRef.current;
    if (!el) return;
    const update = () => setNarrowChips(el.clientWidth < 240);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [isMobileDrawer]);
  const iconChips = isMobileDrawer || narrowChips;
  const [dragOver, setDragOver] = useState<
    | { kind: 'folder'; id: string; zone: 'before' | 'into' | 'after' }
    | { kind: 'task'; id: string; zone: 'before' | 'after' }
    | { kind: 'root' }
    | null
  >(null);
  const [ghost, setGhost] = useState<{ x: number; y: number; label: string } | null>(null);

  interface DragSession {
    id: string;
    kind: 'folder' | 'task';
    sourceParent: string | null;
    startX: number;
    startY: number;
    active: boolean;
  }
  const dragRef = useRef<DragSession | null>(null);
  const didDragRef = useRef(false);

  const openForm = (f: FormState) => {
    setForm(f);
    setFormSeq((n) => n + 1);
  };

  // TopNav 全局「新增任务 / 新增文件夹」入口已提升到 App 层
  // （本组件在移动端抽屉关闭时不挂载，弹窗挂在级别会在窄屏下无响应）

  const tree = useMemo(() => buildTree(folders, tasks), [folders, tasks]);

  /** 快速筛选：各状态计数（chips 上显示） */
  const filterStats = useMemo(() => {
    let running = 0;
    let stopped = 0;
    let error = 0;
    for (const st of Object.values(statuses)) {
      const s = st.state;
      if (s === 'running' || s === 'starting' || s === 'restarting') running++;
      else if (s === 'stopped' || s === 'stopping' || s === 'exited') stopped++;
      else if (s === 'failed' || s === 'error') error++;
    }
    return { running, stopped, error };
  }, [statuses]);

  /** 任务状态是否命中当前筛选 */
  const matchesFilter = (st: string | undefined): boolean => {
    if (filter === 'all') return true;
    if (filter === 'running') return st === 'running' || st === 'starting' || st === 'restarting';
    if (filter === 'stopped') return st === 'stopped' || st === 'stopping' || st === 'exited';
    return st === 'failed' || st === 'error';
  };

  /** 按筛选剪枝：只保留命中的任务，及含命中任务的文件夹链 */
  const filteredTree = useMemo(() => {
    if (filter === 'all') return tree;
    const prune = (nodes: TreeNode[]): TreeNode[] => {
      const out: TreeNode[] = [];
      for (const n of nodes) {
        if (n.kind === 'task') {
          if (matchesFilter(statuses[n.data.id]?.state)) out.push(n);
        } else {
          const kids = prune(n.children);
          if (kids.length > 0) out.push({ ...n, children: kids });
        }
      }
      return out;
    };
    return prune(tree);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, filter, statuses]);

  const openConsole = (task: TaskDef, autoStartIfStopped = false) => {
    setSelected(task.id);
    openConsoleTab(task.id, task.name);
    if (isMobileDrawer) {
      setMobileDrawerOpen(false);
    }
    // 双击节点特性：进程未运行时开 tab 自动启动
    if (autoStartIfStopped) {
      const st = statuses[task.id]?.state;
      if (!st || STARTABLE_STATES.includes(st)) {
        setTimeout(() => void start(task.id), 200);
      }
    }
  };

  const onTaskContextMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    setSelected(id);
    setMenu({ kind: 'task', id, x: e.clientX, y: e.clientY });
  };

  const onFolderContextMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ kind: 'folder', id, x: e.clientX, y: e.clientY });
  };

  const taskMenu = (task: TaskDef): ContextMenuItem[] => {
    const st = statuses[task.id]?.state;
    return [
      { label: '启动', color: 'rgb(var(--color-up))', action: () => void start(task.id), disabled: st === 'running' || st === 'starting' },
      { label: '以管理员身份运行', color: 'rgb(var(--color-accent))', action: () => void startElevated(task.id), disabled: st === 'running' || st === 'starting' },
      { label: '停止', color: 'rgb(var(--color-down))', action: () => void stop(task.id), disabled: st !== 'running' && st !== 'starting' },
      { label: '重启', color: 'rgb(var(--color-accent))', action: () => void restart(task.id), disabled: !st || !RUNNABLE_STATES.includes(st) },
      { label: '', action: () => {}, disabled: true },
      { label: '打开输出窗口', action: () => openConsole(task) },
      { label: '复制任务', action: () => void duplicate(task) },
      { label: '编辑', action: () => openForm({ task, defaultFolderId: task.folderId }) },
      { label: '删除', action: () => setDelConfirm({ kind: 'task', id: task.id, name: task.name }), danger: true },
    ];
  };

  const duplicate = async (task: TaskDef) => {
    const id = await createTask({
      name: `${task.name} 副本`,
      folderId: task.folderId,
      command: task.command,
      workdir: task.workdir,
      env: task.env,
      autoStart: false,
      autoAttach: false,
      saveLog: task.saveLog,
      shell: task.shell,
      runAsAdmin: task.runAsAdmin,
      dependencies: task.dependencies,
      waitForDeps: task.waitForDeps,
      depDelaySecs: task.depDelaySecs,
    });
    if (id) setSelected(id);
  };

  const folderMenu = (folderId: string): ContextMenuItem[] => {
    const node = findNode(tree, folderId);
    const runAll = (fn: (id: string) => Promise<unknown>) => {
      if (node) void Promise.all(collectTaskIds(node).map((id) => fn(id)));
    };
    return [
      { label: '启动全部', color: 'rgb(var(--color-up))', action: () => runAll(start) },
      { label: '停止全部', color: 'rgb(var(--color-down))', action: () => runAll(stop) },
      { label: '重启全部', color: 'rgb(var(--color-accent))', action: () => runAll(restart) },
      { label: '', action: () => {}, disabled: true },
      { label: '新增子文件夹', action: () => void createFolder('新建文件夹', folderId) },
      { label: '新增任务', action: () => openForm({ task: null, defaultFolderId: folderId }) },
      { label: '重命名', action: () => setRename({ kind: 'folder', id: folderId, name: folders.find((f) => f.id === folderId)?.name ?? '' }) },
      { label: '删除', action: () => setDelConfirm({ kind: 'folder', id: folderId, name: folders.find((f) => f.id === folderId)?.name ?? '' }), danger: true },
    ];
  };

  const blankMenu: ContextMenuItem[] = [
    { label: '新增文件夹', action: () => void createFolder('新建文件夹', null) },
    { label: '新增任务', action: () => openForm({ task: null, defaultFolderId: null }) },
  ];

  /** 确认后真正执行删除：先关掉对应控制台标签（后端同时停掉进程）。 */
  const doDelete = () => {
    if (!delConfirm) return;
    if (delConfirm.kind === 'task') {
      closeConsoleTab(delConfirm.id);
      void deleteTask(delConfirm.id);
    } else {
      const node = findNode(tree, delConfirm.id);
      if (node?.kind === 'folder') {
        for (const tid of collectTaskIds(node)) closeConsoleTab(tid);
      }
      void deleteFolder(delConfirm.id);
    }
    setDelConfirm(null);
  };

  /** Pointer 事件实现拖拽（不依赖 WebView2 时好时坏的 HTML5 DnD）。
   *  落点按指针在目标节点行内的纵向位置判定：
   *  - 文件夹：上 28% → before / 下 28% → after / 中间 → into（移入该文件夹）
   *  - 任务：上/下半 → before / after（同文件夹内重排） */
  type DropResolve =
    | { kind: 'folder'; id: string; zone: 'before' | 'into' | 'after' }
    | { kind: 'task'; id: string; zone: 'before' | 'after' }
    | { kind: 'root' };

  const resolveDrop = (clientX: number, clientY: number): DropResolve | null => {
    const el = document.elementFromPoint(clientX, clientY);
    const target = el instanceof Element ? el.closest<HTMLElement>('[data-node-kind]') : null;
    if (!target) return null;
    const kind = target.getAttribute('data-node-kind');
    const rect = target.getBoundingClientRect();
    const yOff = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;
    if (kind === 'folder') {
      const zone = yOff < 0.28 ? 'before' : yOff > 0.72 ? 'after' : 'into';
      return { kind: 'folder', id: target.getAttribute('data-node-id')!, zone };
    }
    if (kind === 'task') {
      return {
        kind: 'task',
        id: target.getAttribute('data-node-id')!,
        zone: yOff < 0.5 ? 'before' : 'after',
      };
    }
    if (kind === 'tree') return { kind: 'root' };
    return null;
  };

  /** 某目录（null=根）下兄弟文件夹/任务的有序列表，索引即 order 位置 */
  const orderedSiblings = (parentId: string | null) =>
    siblingsOf(folders, tasks, parentId);

  const onMove = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.active) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 5) return;
      d.active = true;
      didDragRef.current = true;
      setDragging({ id: d.id, kind: d.kind });
    }
    const label = d.kind === 'folder' ? folders.find((f) => f.id === d.id)?.name ?? '' : tasks.find((t) => t.id === d.id)?.name ?? '';
    setGhost({ x: e.clientX, y: e.clientY, label });
    // eslint-disable-next-line react-hooks/immutability -- 拖拽期间全局光标（WebView 兼容写法）
    document.body.style.cursor = 'grabbing';
    setDragOver(resolveDrop(e.clientX, e.clientY));
  };

  const onUp = (e: PointerEvent) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    didDragRef.current = false;
    const d = dragRef.current;
    dragRef.current = null;
    // eslint-disable-next-line react-hooks/immutability -- 拖拽结束恢复光标（WebView 兼容写法）
    document.body.style.cursor = '';
    setGhost(null);
    if (!d || !d.active) {
      setDragging(null);
      setDragOver(null);
      return;
    }
    const hit = resolveDrop(e.clientX, e.clientY);
    const store = useTaskStore.getState();
    let op: (() => void) | null = null;
    if (d.kind === 'folder') {
      const source = d as DragSession;
      const node = findNode(tree, source.id);
      const selfAndDesc = (node?.kind === 'folder' ? collectFolderIds(node) : []) as string[];
      const forbidden = (fid: string | null) => !!fid && (selfAndDesc.includes(fid) || fid === source.id);
      if (hit?.kind === 'root') {
        if (source.sourceParent !== null) op = () => void store.moveFolder(source.id, null);
      } else if (hit?.kind === 'folder') {
        if (hit.zone === 'into') {
          if (!forbidden(hit.id)) op = () => void store.moveFolder(source.id, hit.id);
        } else {
          // before/after → 在目标文件夹所属目录中重排/搬入
          const parent = folders.find((f) => f.id === hit.id)?.parentId ?? null;
          if (!forbidden(parent)) {
            const sibs = orderedSiblings(parent).folders;
            const at = sibs.findIndex((f) => f.id === hit.id);
            if (at >= 0) {
              const idx = at + (hit.zone === 'after' ? 1 : 0);
              op = () => void store.moveFolder(source.id, parent, idx);
            }
          }
        }
      } else if (hit?.kind === 'task') {
        const parent = tasks.find((t) => t.id === hit.id)?.folderId ?? null;
        if (!forbidden(parent)) op = () => void store.moveFolder(source.id, parent);
      }
    } else {
      const source = d as DragSession;
      if (hit?.kind === 'task') {
        if (hit.id !== source.id) {
          const parent = tasks.find((t) => t.id === hit.id)?.folderId ?? null;
          const sibs = orderedSiblings(parent).tasks;
          const at = sibs.findIndex((t) => t.id === hit.id);
          if (at >= 0) {
            const idx = at + (hit.zone === 'after' ? 1 : 0);
            op = () => void store.moveTask(source.id, parent, idx);
          }
        }
      } else if (hit?.kind === 'folder') {
        const parent = hit.id;
        if (parent !== source.sourceParent) {
          const sibs = orderedSiblings(parent).tasks;
          op = () => void store.moveTask(source.id, parent, sibs.length); // 追加到该目录末尾
        }
      } else if (hit?.kind === 'root') {
        if (source.sourceParent !== null) op = () => void store.moveTask(source.id, null);
      }
    }
    if (op) op();
    setDragging(null);
    setDragOver(null);
  };

  const beginDrag = (e: React.PointerEvent, kind: 'folder' | 'task', id: string, sourceParent: string | null) => {
    if (e.button !== 0) return;
    if (e.target instanceof Element && e.target.closest('[data-act]')) return;
    // 不要 setPointerCapture：拖动逻辑全部走 window 级 pointermove/pointerup，
    // 捕获没有任何收益；反而若指针在窗口外松开，捕获不会被释放，
    // 会把后续第一次点击重定向到本节点（Modal 里 Monaco 首次点击失焦的根因）。
    dragRef.current = { id, kind, sourceParent, startX: e.clientX, startY: e.clientY, active: false };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    if (node.kind === 'folder') {
      const f = node.data;
      const isCollapsed = !!collapsed[f.id];
      const hasChildren = node.children.length > 0;
      const over = dragOver !== null && dragOver.kind === 'folder' && dragOver.id === f.id ? dragOver.zone : null;
      const [total, running] = folderStats(node, Object.fromEntries(Object.entries(statuses).map(([k, v]) => [k, v.state])));
      const dropCls =
        over === 'into'
          ? 'bg-accent/15 outline outline-1 outline-accent/60 -outline-offset-1'
          : over === 'before'
            ? 'drop-line-top'
            : over === 'after'
              ? 'drop-line-bottom'
              : '';
      return (
        <div key={f.id}>
          <div
            data-node-kind="folder"
            data-node-id={f.id}
            className={`tree-row group ${selected === f.id ? 'tree-row-selected' : ''} ${dragging?.id === f.id ? 'opacity-60 outline outline-dashed outline-1 outline-border-default -outline-offset-2' : ''} ${dropCls}`}
            style={{ paddingLeft: depth * 16 + 8 }}
            title={f.name}
            onPointerDown={(e) => beginDrag(e, 'folder', f.id, f.parentId)}
            onClick={() => {
              if (didDragRef.current) {
                didDragRef.current = false;
                return;
              }
              setSelected(f.id);
              if (hasChildren) toggleCollapsed(f.id);
            }}
            onContextMenu={(e) => onFolderContextMenu(e, f.id)}
          >
            <span className="w-4 h-4 flex items-center justify-center shrink-0">
              {hasChildren ? (
                isCollapsed ? (
                  <ChevronRight size={12} className="text-txt-muted" />
                ) : (
                  <ChevronDown size={12} className="text-txt-muted" />
                )
              ) : (
                <span className="w-3" />
              )}
            </span>
            <span className="w-4 h-4 flex items-center justify-center shrink-0">
              {isCollapsed ? (
                <Folder size={13} className="text-txt-muted" />
              ) : (
                <FolderOpen size={13} className="text-accent" />
              )}
            </span>
            {/* 文件夹名 + 运行/总数徽标作为一个整体：徽标紧跟名字，hover 按钮在行尾 */}
            <span className="flex-1 min-w-0 flex items-center gap-1 ml-1">
              <span className="font-mono text-xs truncate">{f.name}</span>
              {total > 0 && (
                <span className={`shrink-0 text-[10px] font-mono tabular-nums ${running > 0 ? 'text-financial-up' : 'text-txt-subtle'}`}>
                  {running}/{total}
                </span>
              )}
            </span>
            <span className="hidden group-hover:flex items-center shrink-0">
              <button
                data-act
                className="icon-btn"
                title="新增子文件夹"
                onClick={(e) => {
                  e.stopPropagation();
                  void createFolder('新建文件夹', f.id);
                }}
              >
                <FolderPlus size={12} />
              </button>
              <button
                data-act
                className="icon-btn"
                title="在此文件夹新增任务"
                onClick={(e) => {
                  e.stopPropagation();
                  openForm({ task: null, defaultFolderId: f.id });
                }}
              >
                <FilePlus size={12} />
              </button>
              <button
                data-act
                className="icon-btn icon-btn-success"
                title="启动全部"
                onClick={(e) => {
                  e.stopPropagation();
                  const n = findNode(tree, f.id);
                  if (n) void Promise.all(collectTaskIds(n).map((id) => start(id)));
                }}
              >
                <Play size={11} />
              </button>
              <button
                data-act
                className="icon-btn icon-btn-danger"
                title="停止全部"
                onClick={(e) => {
                  e.stopPropagation();
                  const n = findNode(tree, f.id);
                  if (n) void Promise.all(collectTaskIds(n).map((id) => stop(id)));
                }}
              >
                <Square size={10} />
              </button>
              <button
                data-act
                className="icon-btn icon-btn-accent"
                title="重启全部"
                onClick={(e) => {
                  e.stopPropagation();
                  const n = findNode(tree, f.id);
                  if (n) void Promise.all(collectTaskIds(n).map((id) => restart(id)));
                }}
              >
                <RotateCw size={11} />
              </button>
            </span>
          </div>
          {!isCollapsed && node.children.map((c) => renderNode(c, depth + 1))}
        </div>
      );
    }
    const task = node.data;
    const st = statuses[task.id]?.state ?? 'stopped';
    const over = dragOver !== null && dragOver.kind === 'task' && dragOver.id === task.id ? dragOver.zone : null;
    const dropCls =
      over === 'before'
        ? 'drop-line-top'
        : over === 'after'
          ? 'drop-line-bottom'
          : '';
    return (
      <div
        key={task.id}
        data-node-kind="task"
        data-node-id={task.id}
        data-folder={task.folderId ?? ''}
        className={`tree-row group ${selected === task.id ? 'tree-row-selected' : ''} ${dragging?.id === task.id ? 'opacity-60 outline outline-dashed outline-1 outline-border-default -outline-offset-2' : ''} ${dropCls}`}
        style={{ paddingLeft: depth * 16 + 8 }}
        title={`${task.name} — ${task.command}`}
        onPointerDown={(e) => beginDrag(e, 'task', task.id, task.folderId)}
        onDoubleClick={() => openConsole(task, true)}
        onClick={() => {
          if (didDragRef.current) {
            didDragRef.current = false;
            return;
          }
          setSelected(task.id);
        }}
        onContextMenu={(e) => onTaskContextMenu(e, task.id)}
      >
        <span className="w-4 h-4 shrink-0" />
        <span className="w-4 h-4 flex items-center justify-center shrink-0">
          <span className={`status-dot ${stateColor(st)}`} />
        </span>
        {/* 任务名 + 端口作为一个整体：端口紧跟名字，hover 按钮在行尾，互不挤压 */}
        <span className="flex-1 min-w-0 flex items-center gap-1 ml-1">
          <span className="font-mono text-xs truncate">{task.name}</span>
          {ports[task.id]?.length ? (
            <span className="flex items-center gap-1 shrink-0">
              {ports[task.id]!.map((url) => (
                <button
                  key={url}
                  data-act
                  className="px-1 py-0.5 text-[10px] rounded-sm text-accent bg-accent/10 hover:bg-accent/20 font-mono transition-colors"
                  title={`用浏览器打开 ${url}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void openBrowser(url);
                  }}
                >
                  :{url.slice(url.lastIndexOf(':') + 1)}
                </button>
              ))}
            </span>
          ) : null}
        </span>
        <span className="hidden group-hover:flex items-center shrink-0">
          <button
            data-act
            className="icon-btn"
            title="打开输出窗口"
            onClick={(e) => {
              e.stopPropagation();
              openConsole(task);
            }}
          >
            <TerminalSquare size={11} />
          </button>
          {st === 'running' ? (
            <button
              data-act
              className="icon-btn icon-btn-danger"
              title="停止"
              onClick={(e) => {
                e.stopPropagation();
                void stop(task.id);
              }}
            >
              <Square size={10} />
            </button>
          ) : (
            st !== 'starting' && (
              <button
                data-act
                className="icon-btn icon-btn-success"
                title="启动"
                onClick={(e) => {
                  e.stopPropagation();
                  void start(task.id);
                }}
              >
                <Play size={11} />
              </button>
            )
          )}
          <button
            data-act
            className="icon-btn icon-btn-accent"
            title="重启"
            onClick={(e) => {
              e.stopPropagation();
              void restart(task.id);
            }}
          >
            <RotateCw size={11} />
          </button>
        </span>
      </div>
    );
  };

  const menuItems =
    menu?.kind === 'task'
      ? taskMenu(tasks.find((t) => t.id === menu.id) ?? ({ id: menu.id } as TaskDef))
      : menu?.kind === 'folder'
        ? folderMenu(menu.id)
        : menu?.kind === 'blank'
          ? blankMenu
          : [];

  const ghostHint = (() => {
    if (dragOver?.kind === 'root') return '移到根目录末尾';
    if (dragOver?.kind === 'folder') {
      if (dragOver.zone === 'into') return `移入「${folders.find((f) => f.id === dragOver.id)?.name ?? ''}」末尾`;
      if (dragOver.zone === 'before') return `插到「${folders.find((f) => f.id === dragOver.id)?.name ?? ''}」前`;
      return `插到「${folders.find((f) => f.id === dragOver.id)?.name ?? ''}」后`;
    }
    if (dragOver?.kind === 'task') {
      const parentId = tasks.find((t) => t.id === dragOver.id)?.folderId;
      const pos = dragOver.zone === 'before' ? '前' : '后';
      return `插入到「${tasks.find((t) => t.id === dragOver.id)?.name ?? ''}」${pos}（${folders.find((f) => f.id === parentId)?.name ?? '根目录'}）`;
    }
    return '';
  })();

  const activeMenu =
    menu?.kind === 'task'
      ? tasks.find((t) => t.id === menu.id)
      : menu?.kind === 'folder'
        ? folders.find((f) => f.id === menu.id)
        : null;

  const menuDisabled = (i: number) => {
    if (menu?.kind === 'task') {
      const t = tasks.find((x) => x.id === menu.id);
      if (!t) return true;
      const st = statuses[t.id]?.state;
      const item = menuItems[i];
      if (item.label === '启动') return st === 'running' || st === 'starting';
      if (item.label === '停止') return st !== 'running' && st !== 'starting';
      if (item.label === '重启') return !st || !RUNNABLE_STATES.includes(st);
      if (item.label === '') return true;
    }
    return false;
  };

  return (
    <div
      className="flex flex-col h-full bg-nav shrink-0"
      style={{ width: isMobileDrawer ? '100%' : treeWidth }}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ kind: 'blank', x: e.clientX, y: e.clientY });
      }}
    >
      <div className="flex h-8 items-center gap-1 border-b border-border-default px-2 shrink-0">
        {isMobileDrawer && (
          <span className="text-xs font-semibold text-txt-primary mr-1 shrink-0 whitespace-nowrap">任务列表</span>
        )}
        {!isMobileDrawer && treeWidth >= 200 && (
          <span className="text-xs font-semibold text-txt-primary mr-1 shrink-0 whitespace-nowrap">任务</span>
        )}
        <button className="icon-btn shrink-0" title="刷新" onClick={() => void refresh()}>
          <RefreshCw size={12} />
        </button>
        {/* 筛选 chips：宽度不足时只显示图标（hover 有 tooltip），不换行不挤压 */}
        <div ref={chipsRef} className="flex items-center gap-1 min-w-0 flex-1 overflow-hidden">
          {(
            [
              ['all', '全部', '全部', CHIP_ICONS.all],
              ['running', '运行中', `运行中${filterStats.running ? ` ${filterStats.running}` : ''}`, CHIP_ICONS.running],
              ['stopped', '已停止', `已停止${filterStats.stopped ? ` ${filterStats.stopped}` : ''}`, CHIP_ICONS.stopped],
              ['error', '异常', `异常${filterStats.error ? ` ${filterStats.error}` : ''}`, CHIP_ICONS.error],
            ] as [TreeFilter, string, string, React.ReactNode][]
          ).map(([value, name, label, icon]) => (
            <button
              key={value}
              title={name}
              aria-label={name}
              className={`rounded transition-colors shrink-0 whitespace-nowrap flex items-center gap-1 ${
                iconChips ? 'w-5 h-5 justify-center' : 'h-5 px-1.5 text-[11px]'
              } ${
                filter === value
                  ? iconChips
                    ? 'bg-accent/15 text-accent'
                    : 'bg-accent text-white'
                  : 'text-txt-muted hover:bg-nav-hover hover:text-txt-primary'
              }`}
              onClick={() => setFilter(value)}
            >
              {icon}
              {!iconChips && <span>{label}</span>}
            </button>
          ))}
        </div>
        {filter !== 'all' && (
          <button className="icon-btn shrink-0" title="清除筛选" onClick={() => setFilter('all')}>
            <Filter size={12} />
          </button>
        )}
        {isMobileDrawer && (
          <button
            className="icon-btn w-6 h-6 ml-auto text-txt-subtle hover:text-txt-primary"
            title="关闭抽屉"
            onClick={() => setMobileDrawerOpen(false)}
          >
            ✕
          </button>
        )}
      </div>
      <div data-node-kind="tree" className="flex-1 overflow-y-auto min-h-0 py-1 px-1 select-none">
        {!ready && <div className="px-3 py-2 text-xs text-txt-subtle">加载中…</div>}
        {ready && tree.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 h-full text-center px-4 py-8">
            <FolderTree size={30} strokeWidth={1.5} className="text-txt-subtle/70" />
            <span className="text-xs text-txt-subtle">还没有任务</span>
            <button
              className="mt-1 h-6 px-2.5 rounded text-[11px] bg-accent text-white hover:opacity-90 transition-opacity"
              onClick={() => openForm({ task: null, defaultFolderId: null })}
            >
              新增第一个任务
            </button>
          </div>
        )}
        {ready && tree.length > 0 && filteredTree.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 h-full text-center px-4 py-8">
            <Filter size={26} strokeWidth={1.5} className="text-txt-subtle/70" />
            <span className="text-xs text-txt-subtle">没有符合当前筛选的任务</span>
            <button
              className="mt-1 h-6 px-2.5 rounded text-[11px] border border-border-default text-txt-muted hover:bg-nav-hover transition-colors"
              onClick={() => setFilter('all')}
            >
              清除筛选
            </button>
          </div>
        )}
        {filteredTree.map((node) => renderNode(node, 0))}
      </div>
      <div
        className="shrink-0 h-6 px-2 flex items-center text-[10px] text-txt-subtle border-t border-border-default select-none overflow-hidden min-w-0"
        title="双击任务打开输出窗口 · 拖拽节点可排序/移入文件夹"
      >
        <span className="truncate block w-full">
          双击任务打开输出窗口 · 拖拽节点可排序/移入文件夹
        </span>
      </div>

      {ghost && <DragGhost x={ghost.x} y={ghost.y} label={ghost.label} hint={ghostHint} />}

      {menu && (menu.kind === 'blank' || activeMenu !== null) && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={menuItems.map((item, i) => ({ ...item, disabled: menuDisabled(i) }))}
        />
      )}
      {form && (
        <TaskFormModal
          key={form.task ? form.task.id : `new-${formSeq}`}
          task={form.task}
          defaultFolderId={form.defaultFolderId}
          onClose={() => setForm(null)}
          onSaved={(taskId) => setSelected(taskId)}
        />
      )}
      {rename && (
        <RenameModal
          current={rename.name}
          onClose={() => setRename(null)}
          onSave={async (name) => {
            await renameFolder(rename.id, name);
            setRename(null);
          }}
        />
      )}
      {delConfirm && (
        <DeleteConfirmModal
          kind={delConfirm.kind}
          name={delConfirm.name}
          onCancel={() => setDelConfirm(null)}
          onConfirm={doDelete}
        />
      )}
    </div>
  );
}

function DragGhost({ x, y, label, hint }: { x: number; y: number; label: string; hint: string }) {
  return (
    <div
      className="fixed z-[60] pointer-events-none flex items-center gap-1.5 pl-1 pr-2 h-6 rounded-md text-xs bg-accent/10 border border-accent/50 text-txt-primary shadow-lg shadow-black/40"
      style={{ left: x + 10, top: y + 10, transform: 'translate(-50%, -100%)' }}
    >
      <GripVertical size={10} className="text-accent shrink-0" />
      <span className="font-medium whitespace-nowrap max-w-48 truncate">{label}</span>
      {hint && (
        <span className="whitespace-nowrap text-txt-subtle border-l border-accent/30 pl-1.5">{hint}</span>
      )}
    </div>
  );
}

function RenameModal({ current, onClose, onSave }: { current: string; onClose: () => void; onSave: (name: string) => Promise<void> }) {
  const [name, setName] = useState(current);
  const save = async () => {
    if (!name.trim()) return;
    await onSave(name.trim());
  };
  return (
    <Modal title="重命名文件夹" onClose={onClose} width={320}>
      <div className="flex flex-col gap-3 p-3">
        <input
          className="w-full h-7 px-2 rounded bg-input-bg border border-border-default text-txt-primary outline-none focus:border-accent focus:ring-1 focus:ring-accent/60 transition-colors"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
          }}
        />
        <div className="flex justify-end gap-2">
          <button
            className="h-7 px-3 rounded text-xs border border-border-default bg-surface hover:bg-nav-hover transition-colors"
            onClick={onClose}
          >
            取消
          </button>
          <button
            className="h-7 px-3 rounded text-xs bg-accent text-white hover:opacity-90 transition-opacity"
            onClick={() => void save()}
          >
            保存
          </button>
        </div>
      </div>
    </Modal>
  );
}

function DeleteConfirmModal({
  kind,
  name,
  onCancel,
  onConfirm,
}: {
  kind: 'task' | 'folder';
  name: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal title="删除确认" onClose={onCancel} width={380}>
      <div className="flex flex-col gap-3 p-3">
        <p className="text-xs text-txt-secondary leading-relaxed">
          {kind === 'folder' ? (
            <>
              确定删除文件夹「<span className="text-txt-primary font-medium">{name}</span>」？
              <span className="block mt-1 text-txt-subtle">
                该文件夹下的所有子文件夹和任务都会被一并删除，运行中的进程会被停止。
              </span>
            </>
          ) : (
            <>
              确定删除任务「<span className="text-txt-primary font-medium">{name}</span>」？
              <span className="block mt-1 text-txt-subtle">若正在运行，进程会被停止。</span>
            </>
          )}
        </p>
        <div className="flex justify-end gap-2">
          <button
            className="h-7 px-3 rounded text-xs border border-border-default bg-surface hover:bg-nav-hover transition-colors"
            onClick={onCancel}
          >
            取消
          </button>
          <button
            className="h-7 px-3 rounded text-xs bg-financial-down text-white hover:opacity-90 transition-opacity"
            onClick={onConfirm}
          >
            删除
          </button>
        </div>
      </div>
    </Modal>
  );
}
