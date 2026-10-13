import {BrowserWindow, ipcMain, shell} from 'electron';
import {
  getCaStatus,
  getProxyStatus,
  installCa,
  onProxyEvent,
  recoverStaleSystemProxy,
  startProxy,
  stopProxy,
  uninstallCa
} from '@main/proxy';
import type {CaResult, Flow, ProxyEvent} from '@shared/types';
import {pushFlow} from './traffic';

/** 代理监听端口。改这一处，UI 和系统代理都会跟着走 */
export const PROXY_PORT = 8989;

const toMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// ------------------------------------------------------------------ 终端打印
// 打印这一层做成"往一个通道里发事件"的形状，现在的通道实现是 console.log。
// 以后换成 webContents.send 推给界面时，上面的采集逻辑一行都不用改。

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
};

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

const printFlow = (flow: Flow): void => {
  const time = new Date(flow.startedAt).toTimeString().slice(0, 8);
  const status = flow.status === null ? '—' : String(flow.status);

  const line = [
    (flow.kind === 'connect' ? '[TUNNEL]' : '[HTTP]').padEnd(8),
    time,
    flow.method.padEnd(9),
    truncate(flow.url, 64).padEnd(66),
    status.padEnd(6),
    `${flow.durationMs}ms`.padEnd(8),
    `↑${formatBytes(flow.requestBytes)} ↓${formatBytes(flow.responseBytes)}`
  ].join(' ');

  console.log(flow.error ? `${line}  ✗ ${flow.error}` : line);
};

// ------------------------------------------------------------------ IPC 接线

const broadcast = (event: ProxyEvent): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('proxy-event', event);
  }
};

export const registerProxy = (): void => {
  onProxyEvent((event) => {
    if (event.type === 'flow') {
      printFlow(event.flow);
      // flow 走 traffic.ts 的批量通道；逐条 send 在大流量下会堵住主进程
      pushFlow(event.flow);
      return;
    }
    broadcast(event);
  });

  ipcMain.handle('proxy:status', () => getProxyStatus());

  // CA 操作失败要让界面看到原因，所以统一包成 { ok, ... }，不让异常穿过 IPC 变成难读的报错
  const wrap = async <T>(task: () => Promise<T>): Promise<CaResult<T>> => {
    try {
      return { ok: true, value: await task() };
    } catch (error) {
      return { ok: false, error: toMessage(error) };
    }
  };

  ipcMain.handle('ca:status', () => wrap(getCaStatus));
  ipcMain.handle('ca:install', () => wrap(installCa));
  ipcMain.handle('ca:uninstall', () => wrap(uninstallCa));
  ipcMain.handle('ca:reveal', () =>
    wrap(async () => {
      const status = await getCaStatus();
      shell.showItemInFolder(status.certPath);
    })
  );

  // 前端用 send 触发，成败通过 proxy-event 回推 —— startProxy 是异步的，
  // 用 handle 会逼着前端再等一轮，而按钮状态本来就要靠推送来维护
  ipcMain.on('start-server', () => {
    startProxy(PROXY_PORT).catch((error: unknown) => {
      const message = toMessage(error);
      console.error(`[Reqeek] 启动代理失败：${message}`);
      broadcast({ type: 'status', status: { running: false, port: null, error: message } });
    });
  });

  ipcMain.on('stop-server', () => {
    stopProxy().catch((error: unknown) => {
      const message = toMessage(error);
      console.error(`[Reqeek] 停止代理失败：${message}`);
      broadcast({ type: 'status', status: { running: false, port: null, error: message } });
    });
  });
};

/**
 * app 启动时清理上次崩溃留下的系统代理残留。
 *
 * 只认我们自己落盘的那份快照 —— 不再像 V0 那样「系统代理指着我们的端口就清」，
 * 那种做法会误伤别人，也会用空快照把用户的 bypass 列表抹掉。
 */
export const recoverStaleSystemProxyOnStartup = async (): Promise<void> => {
  if (await recoverStaleSystemProxy()) {
    console.log('[Reqeek] 已按快照还原上次异常退出留下的系统代理设置');
  }
};

/** 退出前必须走一遍，否则系统代理会留着指向一个已经消失的进程 */
export const shutdownProxy = (): Promise<void> => stopProxy().catch(() => undefined);
