import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Modal } from '@/components/Modal';
import { TERMINAL_FONTS, useUIStore } from '@/stores/uiStore';
import { useTaskStore } from '@/stores/taskStore';
import type { WebStatus } from '@/types';

const selectCls =
  'w-full h-7 px-2 rounded bg-input-bg border border-border-default text-txt-primary outline-none focus:border-accent focus:ring-1 focus:ring-accent/60 transition-colors';
const inputCls =
  'h-7 px-2 rounded bg-input-bg border border-border-default text-txt-primary outline-none focus:border-accent focus:ring-1 focus:ring-accent/60 transition-colors';
const btnCls =
  'h-7 px-3 rounded text-xs border border-border-default text-txt-secondary hover:bg-nav-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 终端展示样式 + Web 服务设置（右上角齿轮）。全部即时应用，持久化到 smt.yaml。 */
export function SettingsModal({ onClose }: { onClose: () => void }) {
  const fontSize = useUIStore((s) => s.terminalFontSize);
  const fontFamily = useUIStore((s) => s.terminalFontFamily);
  const termTheme = useUIStore((s) => s.terminalTheme);
  const setFontSize = useUIStore((s) => s.setTerminalFontSize);
  const setFontFamily = useUIStore((s) => s.setTerminalFontFamily);
  const setTermTheme = useUIStore((s) => s.setTerminalTheme);
  const closeToTray = useUIStore((s) => s.closeToTray);
  const setCloseToTray = useUIStore((s) => s.setCloseToTray);
  const [configPath, setConfigPath] = useState('');
  const [web, setWeb] = useState<WebStatus | null>(null);
  const [webPort, setWebPort] = useState('');
  const [webPassword, setWebPassword] = useState('');
  const [webBusy, setWebBusy] = useState(false);
  const [webMsg, setWebMsg] = useState('');

  const refreshWeb = () => {
    invoke<WebStatus>('web_service_status')
      .then(setWeb)
      .catch(() => setWeb(null));
  };

  useEffect(() => {
    invoke<string>('config_path')
      .then(setConfigPath)
      .catch(() => setConfigPath(''));
    refreshWeb();
  }, []);

  const webAction = async (cmd: 'web_service_start' | 'web_service_stop' | 'web_service_restart') => {
    setWebBusy(true);
    setWebMsg('');
    try {
      // 端口草稿非空时先落盘，启动/重启即按新端口生效
      if (cmd !== 'web_service_stop' && /^\d{2,5}$/.test(webPort)) {
        const settings = await invoke<Record<string, string>>('load_settings');
        if (settings.webPort !== webPort) {
          settings.webPort = webPort;
          await invoke('save_settings', { settings });
        }
      }
      await invoke(cmd);
      // 端口探测/绑定是异步的，稍等再取状态
      await new Promise((r) => setTimeout(r, 600));
      refreshWeb();
      void useTaskStore.getState().loadWebStatus();
    } catch (e) {
      setWebMsg(String(e));
    } finally {
      setWebBusy(false);
    }
  };

  const saveWebSetting = async (key: 'webPort' | 'webPassword', value: string) => {
    setWebBusy(true);
    setWebMsg('');
    try {
      const settings = await invoke<Record<string, string>>('load_settings');
      settings[key] = value;
      await invoke('save_settings', { settings });
      // 密码即时生效（登录校验实时读取）；端口在下次启动/重启时生效
      refreshWeb();
      setWebMsg(key === 'webPort' ? '端口已保存，启动或重启后生效' : '访问密码已保存');
    } catch (e) {
      setWebMsg(String(e));
    } finally {
      setWebBusy(false);
    }
  };

  const applyWebPassword = async () => {
    if (!webPassword.trim()) {
      // 空密码 = 清除密码 = 关闭认证
      await saveWebSetting('webPassword', '');
      setWebPassword('');
      return;
    }
    const hash = await sha256Hex(webPassword.trim());
    await saveWebSetting('webPassword', hash);
    setWebPassword('');
  };

  return (
    <Modal title="设置" onClose={onClose} width={420}>
      <div className="flex flex-col gap-4 p-4">
        <div className="flex flex-col gap-2">
          <span className="text-xs text-txt-secondary">终端字体</span>
          <select
            className={selectCls}
            value={fontFamily}
            onChange={(e) => setFontFamily(e.target.value)}
          >
            {TERMINAL_FONTS.map((f) => (
              <option key={f.family} value={f.family}>
                {f.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-xs text-txt-secondary">字体大小（10–20px，当前 {fontSize}px）</span>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={10}
              max={20}
              step={1}
              value={fontSize}
              className="flex-1"
              onChange={(e) => setFontSize(Number(e.target.value))}
            />
            <span className="w-7 text-right text-xs font-mono text-txt-primary">{fontSize}</span>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-xs text-txt-secondary">终端配色</span>
          <div className="flex gap-2">
            <button
              className={`flex-1 h-7 rounded text-xs border transition-colors ${
                termTheme === 'dark'
                  ? 'border-accent text-txt-primary bg-accent/10'
                  : 'border-border-default text-txt-muted hover:bg-nav-hover'
              }`}
              onClick={() => setTermTheme('dark')}
            >
              深色（黑窗）
            </button>
            <button
              className={`flex-1 h-7 rounded text-xs border transition-colors ${
                termTheme === 'light'
                  ? 'border-accent text-txt-primary bg-accent/10'
                  : 'border-border-default text-txt-muted hover:bg-nav-hover'
              }`}
              onClick={() => setTermTheme('light')}
            >
              浅色（白底）
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-xs text-txt-secondary">窗口行为</span>
          <label className="flex items-start gap-2 px-2 py-1.5 rounded bg-input-bg border border-border-default cursor-pointer select-none">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={closeToTray}
              onChange={(e) => setCloseToTray(e.target.checked)}
            />
            <span className="text-xs text-txt-secondary leading-5">
              关闭窗口时最小化到托盘
              <span className="block text-[11px] text-txt-subtle">
                勾选后点击右上角 × 只隐藏到系统托盘，后台任务继续运行；取消勾选则直接退出
              </span>
            </span>
          </label>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-xs text-txt-secondary">Web 服务（浏览器 / 局域网访问）</span>
          <div className="flex items-center gap-2 px-2 py-1.5 rounded bg-input-bg border border-border-default">
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                web?.running ? 'bg-green-500' : 'bg-txt-subtle'
              }`}
            />
            <span className="text-xs text-txt-secondary flex-1">
              {web?.running
                ? `运行中 · ${web.addr ?? ''}`
                : '已停止'}
            </span>
            <span className="text-[11px] text-txt-subtle">
              {web?.authRequired ? '已设密码' : '未设密码'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <input
              className={`${inputCls} w-20 font-mono`}
              placeholder="端口"
              title="端口（默认 3088），启动或重启时生效"
              value={webPort}
              onChange={(e) => setWebPort(e.target.value.replace(/\D/g, ''))}
            />
            <button className={btnCls} disabled={webBusy || !!web?.running} onClick={() => webAction('web_service_start')}>
              启动
            </button>
            <button className={btnCls} disabled={webBusy || !web?.running} onClick={() => webAction('web_service_stop')}>
              停止
            </button>
            <button className={btnCls} disabled={webBusy || !web?.running} onClick={() => webAction('web_service_restart')}>
              重启
            </button>
          </div>
          <div className="flex items-center gap-2">
            <input
              className={`${inputCls} flex-1`}
              type="password"
              autoComplete="new-password"
              placeholder={web?.authRequired ? '已设置访问密码（输入新值可修改）' : '设置访问密码（空 = 免认证）'}
              value={webPassword}
              onChange={(e) => setWebPassword(e.target.value)}
            />
            <button
              className={btnCls}
              disabled={webBusy}
              onClick={() => webPassword.trim() && applyWebPassword()}
            >
              保存密码
            </button>
            {web?.authRequired && (
              <button
                className={btnCls}
                disabled={webBusy}
                title="清除密码并关闭认证"
                onClick={() => {
                  setWebPassword('');
                  void saveWebSetting('webPassword', '');
                }}
              >
                清除
              </button>
            )}
          </div>
          <span className="text-[11px] text-txt-subtle leading-relaxed">
            设置密码后，浏览器访问需先输入密码登录，所有接口请求均携带会话凭证；密码以 SHA-256 摘要存入 smt.yaml。
            端口被占用时自动向后顺延，实际地址以运行状态为准，日志见 logs/web.log。
          </span>
          {webMsg && <span className="text-[11px] text-txt-secondary">{webMsg}</span>}
        </div>

        {configPath && (
          <div className="flex flex-col gap-1">
            <span className="text-xs text-txt-secondary">配置文件</span>
            <div className="px-2 py-1.5 rounded bg-input-bg border border-border-default">
              <span className="font-mono text-[10px] text-txt-muted break-all" title={configPath}>
                {configPath}
              </span>
            </div>
          </div>
        )}

        <p className="text-[11px] text-txt-subtle leading-relaxed">
          设置写入 smt.yaml（与可执行文件同目录，便携模式），仅影响新建/已打开终端标签的显示，不影响进程本身。
        </p>
      </div>
    </Modal>
  );
}
