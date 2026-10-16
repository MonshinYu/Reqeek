import {contextBridge, ipcRenderer} from 'electron';
import type {
  AppSettings,
  CaResult,
  CaStatus,
  Flow,
  FlowDetail,
  MenuAction,
  ProxyEvent,
  ProxyStatus,
  UpdateStatus
} from '@shared/types';

/**
 * 主进程创建窗口时通过 additionalArguments 塞进来的语言。
 *
 * 同步可读是这里唯一的重点：i18n 的初始化在模块加载时就跑完了，等不了 IPC，
 * 拿不到的话首帧会先按系统语言渲染一遍再跳。
 */
const initialLanguage = ((): string | null => {
  const prefix = '--reqeek-language=';
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
})();

/** 订阅主进程推送的通道，返回取消订阅函数 */
const subscribe = <T>(channel: string, callback: (payload: T) => void): (() => void) => {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => {
    callback(payload);
  };
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
};

const api = {
  getProxyStatus: (): Promise<ProxyStatus> => ipcRenderer.invoke('proxy:status'),

  /** 拉取主进程保留的历史 flow（渲染进程启动或刷新时用） */
  getTrafficSnapshot: (): Promise<Flow[]> => ipcRenderer.invoke('traffic:snapshot'),
  clearTraffic: (): Promise<void> => ipcRenderer.invoke('traffic:clear'),
  getFlowDetail: (id: number): Promise<FlowDetail | null> =>
    ipcRenderer.invoke('traffic:detail', id),
  /** 同步取平台，用于首帧就按平台排版 titlebar，避免异步等待造成的布局跳动 */
  platform: process.platform,
  /** 订阅批量推送的新 flow，返回取消订阅函数 */
  onTraffic: (callback: (flows: Flow[]) => void): (() => void) =>
    subscribe('traffic:push', callback),

  getCaStatus: (): Promise<CaResult<CaStatus>> => ipcRenderer.invoke('ca:status'),
  installCa: (): Promise<CaResult<CaStatus>> => ipcRenderer.invoke('ca:install'),
  uninstallCa: (): Promise<CaResult<CaStatus>> => ipcRenderer.invoke('ca:uninstall'),
  revealCa: (): Promise<CaResult<void>> => ipcRenderer.invoke('ca:reveal'),

  notifyReady: (): void => ipcRenderer.send('renderer-ready'),

  /** 订阅应用菜单触发的动作，返回取消订阅函数 */
  onMenuAction: (callback: (action: MenuAction) => void): (() => void) =>
    subscribe('menu:action', callback),

  startServer: (): void => ipcRenderer.send('start-server'),
  stopServer: (): void => ipcRenderer.send('stop-server'),

  /** 订阅代理事件，返回取消订阅的函数（React 的 useEffect 直接 return 它即可） */
  onProxyEvent: (callback: (event: ProxyEvent) => void): (() => void) =>
    subscribe('proxy-event', callback),

  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  /** 返回落盘后的设置：非法字段（越界端口）会被主进程纠正，界面要用返回值回填而不是乐观状态 */
  saveSettings: (settings: AppSettings): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:save', settings),
  resetSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:reset'),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),

  /**
   * 发起一次检查更新。不返回结果：结论和下载进度都走 onUpdateStatus，
   * 因为 macOS 上「查」完会直接开始下载，整个过程要几分钟
   */
  checkForUpdates: (): Promise<void> => ipcRenderer.invoke('update:check'),
  /** 设置窗口打开时接回当前状态（可能在别处已经查过、甚至正在下载） */
  getUpdateStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:status'),
  installUpdate: (): Promise<void> => ipcRenderer.invoke('update:install'),
  /** 订阅更新状态，返回取消订阅函数 */
  onUpdateStatus: (callback: (status: UpdateStatus) => void): (() => void) =>
    subscribe('update:status', callback),

  openSettings: (): void => ipcRenderer.send('settings:open'),

  /** 启动时注入的语言（同步值），i18n 初始化用它避免首帧闪错语言 */
  initialLanguage,
  /** 订阅语言变化：设置窗口改完由主进程广播，返回取消订阅函数 */
  onLanguageChanged: (callback: (language: string) => void): (() => void) =>
    subscribe('language:changed', callback)
};

export type Api = typeof api;

// 渲染进程只拿到上面这个受限的 api，不暴露 ipcRenderer 或 electron-toolkit 的通用封装。
// 项目始终开启 contextIsolation，没有 contextBridge 就无法安全暴露，直接让错误冒出来。
contextBridge.exposeInMainWorld('api', api);
