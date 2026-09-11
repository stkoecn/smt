import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';

type Theme = 'light' | 'dark';
/** 终端展示模式：深色/浅色 */
export type TerminalTheme = 'dark' | 'light';
/** 任务树快速筛选 */
export type TreeFilter = 'all' | 'running' | 'stopped' | 'error';

export const TERMINAL_FONTS: { label: string; family: string }[] = [
  { label: 'JetBrains Mono', family: "'JetBrains Mono', 'Consolas', 'Courier New', monospace" },
  { label: 'Cascadia Mono', family: "'Cascadia Mono', 'Consolas', 'Courier New', monospace" },
  { label: 'Consolas', family: "'Consolas', 'Courier New', monospace" },
  { label: '中文字体 (等线/微软雅黑)', family: "'Segoe UI', 'Microsoft YaHei', 'Consolas', monospace" },
];

interface UIState {
  theme: Theme;
  toggleTheme: () => void;
  /** 左侧任务树宽度（px） */
  treeWidth: number;
  setTreeWidth: (w: number) => void;
  /** 已折叠的文件夹 id 集合 */
  collapsed: Record<string, boolean>;
  toggleCollapsed: (id: string) => void;
  /** 附加终端样式 */
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalTheme: TerminalTheme;
  setTerminalFontSize: (v: number) => void;
  setTerminalFontFamily: (v: string) => void;
  setTerminalTheme: (v: TerminalTheme) => void;
  /** 关闭窗口时最小化到托盘（false = 直接退出） */
  closeToTray: boolean;
  setCloseToTray: (v: boolean) => void;
  /** 任务树快速筛选 */
  treeFilter: TreeFilter;
  setTreeFilter: (v: TreeFilter) => void;
  /** 移动端/窄屏下的左侧任务树抽屉展开状态 */
  mobileDrawerOpen: boolean;
  setMobileDrawerOpen: (open: boolean) => void;
  toggleMobileDrawer: () => void;
  /** TopNav 全局新增入口（信号量，TaskTreePanel 订阅响应） */
  newTaskSignal: number;
  bumpNewTask: () => void;
  newFolderSignal: number;
  bumpNewFolder: () => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      theme: 'light',
      toggleTheme: () =>
        set((s) => {
          const theme = s.theme === 'dark' ? 'light' : 'dark';
          document.documentElement.classList.toggle('dark', theme === 'dark');
          void queueSettingsPush();
          return { theme };
        }),
      treeWidth: 240,
      setTreeWidth: (w) => set({ treeWidth: Math.min(500, Math.max(160, w)) }),
      collapsed: {},
      toggleCollapsed: (id) =>
        set((s) => ({ collapsed: { ...s.collapsed, [id]: !s.collapsed[id] } })),
      terminalFontSize: 12,
      terminalFontFamily: TERMINAL_FONTS[0].family,
      terminalTheme: 'dark',
      setTerminalFontSize: (v) => {
        set({ terminalFontSize: Math.min(20, Math.max(10, v)) });
        void queueSettingsPush();
      },
      setTerminalFontFamily: (v) => {
        set({ terminalFontFamily: v });
        void queueSettingsPush();
      },
      setTerminalTheme: (v) => {
        set({ terminalTheme: v });
        void queueSettingsPush();
      },
      closeToTray: true,
      setCloseToTray: (v) => {
        set({ closeToTray: v });
        void queueSettingsPush();
      },
      treeFilter: 'all',
      setTreeFilter: (v) => set({ treeFilter: v }),
      mobileDrawerOpen: false,
      setMobileDrawerOpen: (open) => set({ mobileDrawerOpen: open }),
      toggleMobileDrawer: () => set((s) => ({ mobileDrawerOpen: !s.mobileDrawerOpen })),
      newTaskSignal: 0,
      bumpNewTask: () => set((s) => ({ newTaskSignal: s.newTaskSignal + 1 })),
      newFolderSignal: 0,
      bumpNewFolder: () => set((s) => ({ newFolderSignal: s.newFolderSignal + 1 })),
    }),
    {
      name: 'smt-ui-v2',
      // 信号量与临时移动端抽屉属于瞬态事件，禁止持久化
      partialize: (s) => {
        const { newTaskSignal, newFolderSignal, mobileDrawerOpen, ...rest } = s;
        void newTaskSignal;
        void newFolderSignal;
        void mobileDrawerOpen;
        return rest;
      },
    },
  ),
);

// ────────────────────────────────────────────────────────────────
// 设置持久化：优先写 smt.yaml（后端），localStorage 为兜底缓存。
// ────────────────────────────────────────────────────────────────

const YAML_KEYS = ['theme', 'terminalFontSize', 'terminalFontFamily', 'terminalTheme', 'closeToTray'] as const;

function settingsPayload(): Record<string, string> {
  const s = useUIStore.getState();
  return {
    theme: s.theme,
    terminalFontSize: String(s.terminalFontSize),
    terminalFontFamily: s.terminalFontFamily,
    terminalTheme: s.terminalTheme,
    closeToTray: String(s.closeToTray),
  };
}

let pushTimer: ReturnType<typeof setTimeout> | null = null;

async function queueSettingsPush() {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    invoke('save_settings', { settings: settingsPayload() }).catch(() => {
      /* 无后端（纯浏览器 dev）时忽略，localStorage 兜底 */
    });
  }, 400);
}

/** 应用启动时从 smt.yaml 读取设置（优先 yaml，localStorage 作为回退）。 */
export async function hydrateUISettings() {
  try {
    const settings = await invoke<Record<string, string>>('load_settings');
    const next: Partial<UIState> = {};
    for (const k of YAML_KEYS) {
      const v = settings[k];
      if (v == null) continue;
      if (k === 'theme' && (v === 'light' || v === 'dark')) next.theme = v;
      if (k === 'terminalFontSize') {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 10 && n <= 20) next.terminalFontSize = n;
      }
      if (k === 'terminalFontFamily' && v) next.terminalFontFamily = v;
      if (k === 'terminalTheme' && (v === 'dark' || v === 'light')) next.terminalTheme = v;
      if (k === 'closeToTray' && (v === 'true' || v === 'false')) next.closeToTray = v === 'true';
    }
    if (Object.keys(next).length > 0) {
      useUIStore.setState(next);
      // 主题 class 直接生效（ThemeProvider 也会跟随）
      const th = next.theme ?? useUIStore.getState().theme;
      document.documentElement.classList.toggle('dark', th === 'dark');
    }
  } catch {
    /* 首次启动后端未就绪：保持 localStorage 值 */
  }
}