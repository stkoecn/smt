// 前后端契约类型（与 Rust serde rename_all="camelCase" 对齐）

export type ProcessState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'restarting'
  | 'exited'
  | 'failed'
  | 'error';

export interface FolderDef {
  id: string;
  name: string;
  parentId: string | null;
  /** 同一父目录下兄弟文件夹的展示顺序（服务端维护） */
  order: number;
}

export interface TaskDef {
  id: string;
  name: string;
  folderId: string | null;
  command: string;
  workdir: string | null;
  env: Record<string, string>;
  autoStart: boolean;
  autoAttach: boolean;
  /** 每次启动把输出保存到 <数据目录>/logs/ 下带时间戳的日志文件 */
  saveLog: boolean;
  /** 终端类型：null/"cmd"=CMD，"powershell"，"pwsh"，"bash" */
  shell: string | null;
  /** Windows 下经 UAC 以管理员身份启动 */
  runAsAdmin: boolean;
  /** 依赖的任务 id 列表（启动前需先就绪，且须构成有向无环关系） */
  dependencies: string[];
  /** 是否在本任务启动前自动拉起依赖任务（false = 依赖未启动则本任务启动失败） */
  waitForDeps: boolean;
  /** 依赖全部就绪后、启动本任务前的延时秒数（默认 5） */
  depDelaySecs: number;
  /** 同一文件夹下任务顺序（服务端维护） */
  order: number;
}

export interface TaskInput {
  name: string;
  folderId: string | null;
  command: string;
  workdir: string | null;
  env: Record<string, string>;
  autoStart: boolean;
  autoAttach: boolean;
  saveLog: boolean;
  shell: string | null;
  runAsAdmin: boolean;
  dependencies: string[];
  waitForDeps: boolean;
  depDelaySecs: number;
}

/** list_shells 返回的可选终端 */
export interface ShellOption {
  id: string;
  name: string;
  exe: string;
  args: string;
}

export interface ProcessStatus {
  state: ProcessState;
  pid: number | null;
  exitCode: number | null;
  startedAt: number | null;
  error: string | null;
}

export interface ConsoleLine {
  at: number;
  stream: 'stdout' | 'stderr';
  text: string;
  /** 是否以换行收尾的完整行；false 表示未换行的部分行（提示符等），前端不应补换行 */
  eol: boolean;
}

export interface AttachResult {
  taskId: string;
  taskName: string;
  status: ProcessStatus;
  /** 终端基线：普通任务为原始字节流（base64，ANSI 保真）；提权任务为日志文本 */
  text: string;
  /** 日志文件路径（未开启日志保存则为 null） */
  logPath: string | null;
  /** text 是否为原始终端字节流（base64） */
  raw: boolean;
}

export interface TaskTreePayload {
  folders: FolderDef[];
  tasks: TaskDef[];
  statuses: Record<string, ProcessStatus>;
}

export interface OutputEvent {
  taskId: string;
  lines: ConsoleLine[];
}

/** process-output-raw：原始终端字节流（base64，保留 ANSI 转义序列） */
export interface RawOutputEvent {
  taskId: string;
  /** base64 编码的 UTF-8 字节（含 ANSI），交给 xterm.write(Uint8Array) */
  data: string;
}

export interface StatusEvent {
  taskId: string;
  status: ProcessStatus;
}

/** process-ports：taskId → 可访问 URL 列表（如 http://127.0.0.1:8000） */
export interface PortsEvent {
  ports: Record<string, string[]>;
}

export type TreeNode =
  | { kind: 'folder'; data: FolderDef; children: TreeNode[] }
  | { kind: 'task'; data: TaskDef };
