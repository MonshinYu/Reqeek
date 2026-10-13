import {BrowserWindow, ipcMain} from 'electron';
import {clearFlowDetails, getFlowDetail} from '@main/proxy';
import type {Flow, FlowDetail} from '@shared/types';

/** 主进程保留的历史上限。渲染进程刷新后靠它补回列表 */
const MAX_FLOWS = 20_000;
/** 批量推送的间隔与单批大小；积压变多时放大单批、缩短间隔 */
const FLUSH_MS = 100;
const BACKLOG_FLUSH_MS = 50;
const BATCH = 500;
const BACKLOG_BATCH = 2000;
const BACKLOG_THRESHOLD = 2000;

let history: Flow[] = [];
let pending: Flow[] = [];
let timer: NodeJS.Timeout | null = null;

const send = (channel: string, payload: unknown): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
};

const flush = (): void => {
  timer = null;
  if (pending.length === 0) return;

  const size = pending.length > BACKLOG_THRESHOLD ? BACKLOG_BATCH : BATCH;
  const batch = pending.slice(0, size);
  pending = pending.slice(size);
  send('traffic:push', batch);

  // 还有积压才继续排下一轮；空闲时不留定时器
  if (pending.length > 0) {
    timer = setTimeout(flush, pending.length > BACKLOG_THRESHOLD ? BACKLOG_FLUSH_MS : FLUSH_MS);
  }
};

/** 代理每产出一条 flow 就调用一次 */
export const pushFlow = (flow: Flow): void => {
  history.push(flow);
  // 超出 25% 才整段裁一次，避免每条都搬数组
  if (history.length > MAX_FLOWS * 1.25) history = history.slice(-MAX_FLOWS);

  pending.push(flow);
  timer ??= setTimeout(flush, FLUSH_MS);
};

export const registerTraffic = (): void => {
  // 渲染进程启动或刷新时拉一次全量，之后靠 traffic:push 增量；重叠部分由 id 去重
  ipcMain.handle('traffic:snapshot', (): Flow[] => history);

  ipcMain.handle('traffic:detail', (_event, id: unknown): Promise<FlowDetail | null> => {
    if (typeof id !== 'number' || !Number.isSafeInteger(id)) {
      throw new TypeError('traffic:detail 需要整数 id');
    }
    return getFlowDetail(id);
  });

  ipcMain.handle('traffic:clear', (): void => {
    clearFlowDetails();
    history = [];
    pending = [];
    if (timer) clearTimeout(timer);
    timer = null;
  });
};
