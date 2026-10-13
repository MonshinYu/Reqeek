import {contextBridge, ipcRenderer} from 'electron';
import type {CaResult, CaStatus, Flow, FlowDetail, MenuAction, ProxyEvent, ProxyStatus} from '@shared/types';

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
    subscribe('proxy-event', callback)
};

export type Api = typeof api;

// 渲染进程只拿到上面这个受限的 api，不暴露 ipcRenderer 或 electron-toolkit 的通用封装。
// 项目始终开启 contextIsolation，没有 contextBridge 就无法安全暴露，直接让错误冒出来。
contextBridge.exposeInMainWorld('api', api);
