import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  FolderDef,
  PortsEvent,
  ProcessState,
  ProcessStatus,
  ShellOption,
  StatusEvent,
  TaskDef,
  TaskInput,
  TaskTreePayload,
  TreeNode,
  WebStatus,
} from '@/types';

interface TaskState {
  ready: boolean;
  folders: TaskTreePayload['folders'];
  tasks: TaskDef[];
  statuses: Record<string, ProcessStatus>;
  /** taskId → 监听端口可访问 URL */
  ports: Record<string, string[]>;
  /** 系统探测到的可用终端 */
  shells: ShellOption[];
  /** Web 服务运行状态（包含绑定的 IP:Port） */
  webStatus: WebStatus | null;
  autoAttachHandler?: (taskId: string, name: string) => void;
  load: () => Promise<void>;
  refresh: () => Promise<void>;
  loadShells: (force?: boolean) => Promise<void>;
  loadWebStatus: () => Promise<void>;
  applyStatus: (taskId: string, status: ProcessStatus) => void;
  applyPorts: (ports: Record<string, string[]>) => void;
  openBrowser: (url: string) => Promise<void>;
  openLogFolder: (path: string) => Promise<void>;
  createFolder: (name: string, parentId: string | null) => Promise<string | null>;
  renameFolder: (id: string, name: string) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;
  moveFolder: (id: string, parentId: string | null, toIndex?: number) => Promise<void>;
  createTask: (input: TaskInput) => Promise<string | null>;
  updateTask: (id: string, input: TaskInput) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  moveTask: (id: string, folderId: string | null, toIndex?: number) => Promise<void>;
  start: (taskId: string) => Promise<ProcessStatus | null>;
  /** 右键「以管理员身份运行」：强制提权启动（弹 UAC 授权） */
  startElevated: (taskId: string) => Promise<ProcessStatus | null>;
  stop: (taskId: string) => Promise<ProcessStatus | null>;
  restart: (taskId: string) => Promise<ProcessStatus | null>;
  /** 向附加的 ConPTY 黑窗发送键盘输入（仅普通模式任务支持）。失败返回错误文案 */
  sendInput: (taskId: string, data: string) => Promise<string | null>;
}

let statusListener: Promise<() => void> | null = null;
let portListener: Promise<() => void> | null = null;
let webStatusListener: Promise<() => void> | null = null;

export const useTaskStore = create<TaskState>((set, get) => ({
  ready: false,
  folders: [],
  tasks: [],
  statuses: {},
  ports: {},
  shells: [],
  webStatus: null,

  load: async () => {
    const payload = await invoke<TaskTreePayload>('list_tasks');
    set({ folders: payload.folders, tasks: payload.tasks, statuses: payload.statuses, ready: true });
    void get().loadShells();
    void get().loadWebStatus();
    if (!statusListener) {
      statusListener = listen<StatusEvent>('process-status', (e) => {
        get().applyStatus(e.payload.taskId, e.payload.status);
      });
    }
    if (!portListener) {
      portListener = listen<PortsEvent>('process-ports', (e) => {
        get().applyPorts(e.payload.ports);
      });
    }
    if (!webStatusListener) {
      webStatusListener = listen<WebStatus>('web-status', (e) => {
        set({ webStatus: e.payload });
      });
    }
  },

  refresh: async () => {
    const payload = await invoke<TaskTreePayload>('list_tasks');
    set({ folders: payload.folders, tasks: payload.tasks, statuses: payload.statuses });
    void get().loadWebStatus();
  },

  loadWebStatus: async () => {
    try {
      const webStatus = await invoke<WebStatus>('web_service_status');
      set({ webStatus });
    } catch {
      /* ignore */
    }
  },

  loadShells: async (force = false) => {
    // 内存中已有缓存且不强制刷新时，直接复用，杜绝重复请求
    if (!force && get().shells.length > 0) return;
    try {
      const shells = await invoke<ShellOption[]>('list_shells');
      set({ shells });
    } catch {
      /* ignore */
    }
  },

  applyStatus: (taskId, status) =>
    set((s) => ({
      statuses: { ...s.statuses, [taskId]: status },
    })),

  applyPorts: (ports) => set({ ports }),

  openBrowser: async (url) => {
    try {
      await invoke('open_in_browser', { url });
    } catch {
      /* ignore */
    }
  },

  openLogFolder: async (path) => {
    try {
      await invoke('open_in_folder', { path });
    } catch {
      /* ignore */
    }
  },

  createFolder: async (name, parentId) => {
    const before = new Set(get().folders.map((f) => f.id));
    const payload = await invoke<TaskTreePayload>('create_folder', { name, parentId });
    set({ folders: payload.folders, tasks: payload.tasks, statuses: payload.statuses });
    return payload.folders.find((f) => !before.has(f.id))?.id ?? null;
  },

  renameFolder: async (id, name) => {
    const payload = await invoke<TaskTreePayload>('rename_folder', { id, name });
    set({ folders: payload.folders, tasks: payload.tasks, statuses: payload.statuses });
  },

  deleteFolder: async (id) => {
    const payload = await invoke<TaskTreePayload>('delete_folder', { id });
    set({ folders: payload.folders, tasks: payload.tasks, statuses: payload.statuses });
  },

  moveFolder: async (id, parentId, toIndex) => {
    try {
      const payload = await invoke<TaskTreePayload>('move_folder', { id, parentId, toIndex });
      set({ folders: payload.folders, tasks: payload.tasks, statuses: payload.statuses });
    } catch {
      /* 非法落点（如移入自身子树），忽略 */
    }
  },

  createTask: async (input) => {
    const before = new Set(get().tasks.map((t) => t.id));
    const payload = await invoke<TaskTreePayload>('create_task', { input });
    set({ folders: payload.folders, tasks: payload.tasks, statuses: payload.statuses });
    // 按「新增的 id」找回，避免同名任务匹配错（旧实现按 name 匹配会选中错误的旧任务）
    return payload.tasks.find((t) => !before.has(t.id))?.id ?? null;
  },

  updateTask: async (id, input) => {
    const payload = await invoke<TaskTreePayload>('update_task', { id, input });
    set({ folders: payload.folders, tasks: payload.tasks, statuses: payload.statuses });
  },

  deleteTask: async (id) => {
    const payload = await invoke<TaskTreePayload>('delete_task', { id });
    set({ folders: payload.folders, tasks: payload.tasks, statuses: payload.statuses });
  },

  moveTask: async (id, folderId, toIndex) => {
    const payload = await invoke<TaskTreePayload>('move_task', { id, folderId, toIndex });
    set({ folders: payload.folders, tasks: payload.tasks, statuses: payload.statuses });
  },

  start: async (taskId) => {
    try {
      const task = get().tasks.find((t) => t.id === taskId);
      const status = await invoke<ProcessStatus>('start_process', { taskId });
      get().applyStatus(taskId, status);
      if (task?.autoAttach) {
        get().autoAttachHandler?.(taskId, task.name);
      }
      return status;
    } catch {
      return null;
    }
  },

  startElevated: async (taskId) => {
    try {
      const task = get().tasks.find((t) => t.id === taskId);
      const status = await invoke<ProcessStatus>('start_process_elevated', { taskId });
      get().applyStatus(taskId, status);
      if (task?.autoAttach) {
        get().autoAttachHandler?.(taskId, task.name);
      }
      return status;
    } catch {
      return null;
    }
  },

  stop: async (taskId) => {
    try {
      const status = await invoke<ProcessStatus>('stop_process', { taskId });
      get().applyStatus(taskId, status);
      return status;
    } catch {
      return null;
    }
  },

  restart: async (taskId) => {
    try {
      const status = await invoke<ProcessStatus>('restart_process', { taskId });
      get().applyStatus(taskId, status);
      return status;
    } catch {
      return null;
    }
  },

  /** 向附加的 ConPTY 黑窗发送键盘输入（仅普通模式任务支持）。失败返回错误文案 */
  sendInput: async (taskId, data) => {
    try {
      await invoke('send_input', { taskId, data });
      return null;
    } catch (e) {
      return typeof e === 'string' ? e : '发送输入失败';
    }
  },
}));

/** 把 folders/tasks 构建成树（顺序由服务端 order 维护，目录在前、任务在后）。 */
export function buildTree(folders: TaskTreePayload['folders'], tasks: TaskDef[]): TreeNode[] {
  const folderNodes = new Map<string, TreeNode>();
  for (const f of folders) {
    folderNodes.set(f.id, { kind: 'folder', data: f, children: [] });
  }
  const sortByOrder = <T extends { order: number; name: string }>(arr: T[]) =>
    [...arr].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'zh-CN'));
  const roots: TreeNode[] = [];
  // 文件夹：父节点 maps 已建好，按 order 顺序挂接
  for (const f of sortByOrder(folders)) {
    const node = folderNodes.get(f.id)!;
    const parentId = f.parentId;
    if (parentId && folderNodes.has(parentId)) {
      const parent = folderNodes.get(parentId)!;
      if (parent.kind === 'folder') parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  // 任务：按 order 顺序挂到其文件夹（或根）
  for (const t of sortByOrder(tasks)) {
    const node: TreeNode = { kind: 'task', data: t };
    const fid = t.folderId;
    if (fid && folderNodes.has(fid)) {
      const parent = folderNodes.get(fid)!;
      if (parent.kind === 'folder') parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

/** 某文件夹（null=根）下的任务，按服务端 order 排序 —— 拖拽 index 计算用 */
export function siblingsOf(
  folders: TaskTreePayload['folders'],
  tasks: TaskDef[],
  parentId: string | null,
): { folders: FolderDef[]; tasks: TaskDef[] } {
  return {
    folders: folders
      .filter((f) => f.parentId === parentId)
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'zh-CN')),
    tasks: tasks
      .filter((t) => t.folderId === parentId)
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'zh-CN')),
  };
}

export const STATE_LABEL: Record<ProcessState, string> = {
  stopped: '已停止',
  starting: '启动中',
  running: '运行中',
  stopping: '停止中',
  restarting: '重启中',
  exited: '已结束',
  failed: '失败',
  error: '异常',
};

/** 进程已停、可重新启动的状态 */
export const STARTABLE_STATES = ['stopped', 'exited', 'failed', 'error'];
