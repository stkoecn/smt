import { useState, useMemo } from 'react';
import { FolderOpen } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import type { TaskDef, TaskInput } from '@/types';
import { useTaskStore } from '@/stores/taskStore';
import { Modal } from '@/components/Modal';
import { ScriptEditor } from '@/components/ScriptEditor';

const LANG_BY_SHELL: Record<string, string> = {
  bash: 'shell',
  powershell: 'powershell',
  pwsh: 'powershell',
  python: 'python',
  q: 'plaintext',
};

interface Props {
  /** null = 新建 */
  task: TaskDef | null;
  /** 新建时预填的文件夹 */
  defaultFolderId: string | null;
  onClose: () => void;
  onSaved: (taskId: string) => void;
}

/**
 * 注意：父组件应以 key 重建本组件实例（task id 或自增序号），
 * 保证初始 state 与打开场景一致。
 */
export function TaskFormModal({ task, defaultFolderId, onClose, onSaved }: Props) {
  const folders = useTaskStore((s) => s.folders);
  const tasks = useTaskStore((s) => s.tasks);
  const createTask = useTaskStore((s) => s.createTask);
  const updateTask = useTaskStore((s) => s.updateTask);

  // 可选的依赖任务 = 除"编辑中本任务"外的所有任务
  const depOptions = useMemo(() => tasks.filter((t) => t.id !== task?.id), [tasks, task?.id]);

  const [name, setName] = useState(task?.name ?? '');
  const [folderId, setFolderId] = useState<string>(task?.folderId ?? defaultFolderId ?? '');
  const [command, setCommand] = useState(task?.command ?? '');
  const [workdir, setWorkdir] = useState(task?.workdir ?? '');
  const [envText, setEnvText] = useState(
    Object.entries(task?.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
  );
  const [autoStart, setAutoStart] = useState(task?.autoStart ?? false);
  const [autoAttach, setAutoAttach] = useState(task?.autoAttach ?? true);
  const [saveLog, setSaveLog] = useState(task?.saveLog ?? false);
  const [runAsAdmin, setRunAsAdmin] = useState(task?.runAsAdmin ?? false);
  const [shell, setShell] = useState(task?.shell ?? '');
  const [deps, setDeps] = useState<string[]>(task?.dependencies ?? []);
  const [waitForDeps, setWaitForDeps] = useState(task?.waitForDeps ?? false);
  const [depDelaySecs, setDepDelaySecs] = useState(task?.depDelaySecs ?? 5);
  const [depsOpen, setDepsOpen] = useState(false);
  const [error, setError] = useState('');

  const toggleDep = (id: string) =>
    setDeps((prev) => (prev.includes(id) ? prev.filter((d) => d !== id) : [...prev, id]));

  const shells = useTaskStore((s) => s.shells);

  const parseEnv = (): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const line of envText.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf('=');
      if (eq > 0) env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return env;
  };

  const save = async () => {
    setError('');
    if (!name.trim()) return setError('请输入任务名称');
    if (!command.trim()) return setError('请输入启动命令');
    const input: TaskInput = {
      name: name.trim(),
      folderId: folderId || null,
      command: command.trim(),
      workdir: workdir.trim() || null,
      env: parseEnv(),
      autoStart,
      autoAttach,
      saveLog,
      shell: shell || null,
      runAsAdmin,
      dependencies: deps,
      waitForDeps,
      depDelaySecs: Math.max(0, Math.trunc(depDelaySecs) || 0),
    };
    try {
      let id = task?.id ?? null;
      if (task) {
        await updateTask(task.id, input);
        id = task.id;
      } else {
        id = await createTask(input);
      }
      if (id) onSaved(id);
      onClose();
    } catch (e) {
      setError(String(e));
    }
  };

  const inputCls =
    'w-full h-7 px-2 rounded bg-input-bg border border-border-default text-txt-primary placeholder:text-txt-subtle outline-none focus:border-accent focus:ring-1 focus:ring-accent/60 transition-colors';

  /** 弹出系统目录选择框（无后端纯浏览器 dev 时静默失败，仍可手动填写） */
  const pickDir = async () => {
    try {
      const dir = await open({ directory: true, title: '选择工作目录' });
      if (typeof dir === 'string') setWorkdir(dir);
    } catch {
      /* 忽略 */
    }
  };

  return (
    <Modal title={task ? `编辑任务 · ${task.name}` : '新增任务'} onClose={onClose} width={680}>
      <div className="flex flex-col gap-3 p-3">
        <div className="flex flex-col sm:flex-row gap-3">
          <label className="flex-1 flex flex-col gap-1 text-xs text-txt-muted">
            任务名称
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </label>
          <label className="flex-1 flex flex-col gap-1 text-xs text-txt-muted">
            所属文件夹
            <select className={inputCls} value={folderId} onChange={(e) => setFolderId(e.target.value)}>
              <option value="">（根目录）</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="flex flex-col gap-1 text-xs text-txt-muted">
          终端
          <select className={inputCls} value={shell} onChange={(e) => setShell(e.target.value)}>
            <option value="">系统默认（CMD）</option>
            {shells.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}（{s.exe}）
              </option>
            ))}
          </select>
          <span className="text-txt-subtle">多行脚本自动交给所选终端执行（CMD 可写 BAT / PowerShell 可写 PS / Bash 可写 sh）</span>
        </label>
        <div className="flex flex-col gap-1 text-xs text-txt-muted">
          启动脚本
          <ScriptEditor
            value={command}
            language={LANG_BY_SHELL[shell] ?? 'bat'}
            onChange={setCommand}
            height={140}
          />
          <span className="text-txt-subtle">支持多行脚本，内容将交给所选终端直接执行</span>
        </div>
        <div className="flex flex-col sm:flex-row gap-3">
          <label className="flex-1 flex flex-col gap-1 text-xs text-txt-muted">
            工作目录
            <div className="relative">
              <input
                className={inputCls}
                style={{ paddingRight: 34 }}
                value={workdir}
                onChange={(e) => setWorkdir(e.target.value)}
                placeholder="留空使用应用默认目录"
              />
              <button
                type="button"
                className="icon-btn absolute right-1 top-1/2 -translate-y-1/2"
                title="选择文件夹"
                onClick={() => void pickDir()}
              >
                <FolderOpen size={13} />
              </button>
            </div>
          </label>
          <label className="flex-1 flex flex-col gap-1 text-xs text-txt-muted">
            环境变量（每行 KEY=VALUE）
            <textarea
              className={`${inputCls} h-12 py-1 resize-y font-mono`}
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              spellCheck={false}
            />
          </label>
        </div>
        {/* 依赖项：下拉多选 + 是否自动拉起 + 延时 */}
        <div className="flex flex-col gap-1 text-xs text-txt-muted">
          <div className="flex items-center justify-between">
            <span>依赖项（启动本任务前先就绪）</span>
            <button
              type="button"
              className="h-6 px-2 rounded text-xs border border-border-default bg-surface hover:bg-nav-hover transition-colors"
              onClick={() => setDepsOpen((v) => !v)}
            >
              {depsOpen ? '收起' : '选择依赖'}
            </button>
          </div>
          {deps.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {deps.map((id) => {
                const t = tasks.find((x) => x.id === id);
                return (
                  <span key={id} className="px-1.5 py-0.5 rounded-sm bg-accent/10 text-accent font-mono text-[10px]">
                    {t?.name ?? id}
                  </span>
                );
              })}
            </div>
          )}
          {depsOpen && (
            <div className="mt-1 rounded border border-border-default bg-input-bg max-h-40 overflow-y-auto">
              {depOptions.length === 0 ? (
                <div className="px-2 py-2 text-[11px] text-txt-subtle">还没有其他任务可依赖</div>
              ) : (
                depOptions.map((t) => (
                  <label
                    key={t.id}
                    className="flex items-center gap-2 px-2 py-1 hover:bg-nav-hover cursor-pointer text-txt-secondary"
                  >
                    <input
                      type="checkbox"
                      checked={deps.includes(t.id)}
                      onChange={() => toggleDep(t.id)}
                    />
                    <span className="truncate font-mono text-[11px]">{t.name}</span>
                  </label>
                ))
              )}
            </div>
          )}
          <label className="flex items-center gap-2 mt-1 text-txt-secondary">
            <input type="checkbox" checked={waitForDeps} onChange={(e) => setWaitForDeps(e.target.checked)} />
            启动前自动拉起依赖任务（未勾选时，依赖未启动则本任务启动失败）
          </label>
          {waitForDeps && (
            <label className="flex items-center gap-2 mt-1 text-txt-secondary">
              依赖就绪后延时
              <input
                type="number"
                min={0}
                value={depDelaySecs}
                onChange={(e) => setDepDelaySecs(Number(e.target.value))}
                className={`${inputCls} h-6`}
                style={{ width: 64 }}
              />
              秒
            </label>
          )}
        </div>
        <div className="flex flex-col gap-2 pt-1">
          <label className="flex items-center gap-2 text-xs text-txt-secondary">
            <input type="checkbox" checked={autoStart} onChange={(e) => setAutoStart(e.target.checked)} />
            应用启动时自动拉起
          </label>
          <label className="flex items-center gap-2 text-xs text-txt-secondary">
            <input type="checkbox" checked={autoAttach} onChange={(e) => setAutoAttach(e.target.checked)} />
            启动后自动打开输出窗口
          </label>
          <label className="flex items-center gap-2 text-xs text-txt-secondary">
            <input type="checkbox" checked={saveLog} onChange={(e) => setSaveLog(e.target.checked)} />
            保存日志文件（每次启动生成带时间戳的 .log 文件）
          </label>
          <label className="flex items-center gap-2 text-xs text-txt-secondary">
            <input type="checkbox" checked={runAsAdmin} onChange={(e) => setRunAsAdmin(e.target.checked)} />
            以管理员身份运行（启动时弹出 UAC 授权）
            <span className="text-txt-subtle">—— 提权进程输出经日志文件回读，控制台实时性略有延迟</span>
          </label>
        </div>
        {error && <div className="text-xs text-financial-down">{error}</div>}
        <div className="flex justify-end gap-2 pt-1 border-t border-border-default">
          <button
            className="h-7 px-3 rounded text-xs border border-border-default bg-surface hover:bg-nav-hover transition-colors"
            onClick={onClose}
          >
            取消
          </button>
          <button
            className="h-7 px-3 rounded text-xs bg-accent text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
            onClick={() => void save()}
          >
            保存
          </button>
        </div>
      </div>
    </Modal>
  );
}
