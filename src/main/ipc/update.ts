import {ipcMain} from 'electron';
import {checkForUpdates, getUpdateStatus, installUpdate} from '../updater';
import type {UpdateStatus} from '@shared/types';

export const registerUpdate = (): void => {
  // 不 await：macOS 上「查」和「下」连在一起，要跑几分钟。界面靠 update:status
  // 事件跟进进度，不需要等这一次调用返回
  ipcMain.handle('update:check', (): void => {
    void checkForUpdates();
  });

  // 设置窗口每次都是新建的，打开时要能接回上一次检查的结果和正在跑的下载
  ipcMain.handle('update:status', (): UpdateStatus => getUpdateStatus());

  ipcMain.handle('update:install', (): void => installUpdate());
};
