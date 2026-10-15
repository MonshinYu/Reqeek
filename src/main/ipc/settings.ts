import { app, BrowserWindow, ipcMain } from 'electron';
import { getSettings, resetSettings, saveSettings } from '../settings';
import { setMainLanguage } from '../i18n';
import { refreshAppMenu } from '../menu';
import { applyTheme } from '../theme';
import { refreshTray } from '../tray';
import { restartProxyOnPort } from './proxy';
import type { SupportedLanguage } from '@shared/i18n';
import type { AppSettings, UpdateCheckResult } from '@shared/types';

/** 桩里的假延迟：让界面的「检查中」真的能被看见，也贴近以后真实请求的节奏 */
const UPDATE_CHECK_DELAY_MS = 600;

/** 每个窗口的 i18n 都要跟着换；各窗口在 lib/i18n.ts 里各监听一次，不随页面挂载反复订阅 */
const broadcastLanguage = (language: SupportedLanguage): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('language:changed', language);
  }
};

/**
 * 把改动作用到正在运行的东西上。
 *
 * 语言、主题、端口是仅有的三个「改了得立刻生效」的字段，其余只影响下次启动 ——
 * 不逐个比较的话，改个语言都会白重绘一次、甚至白断一次网。
 *
 * 设置文件路径由启动流程（main/index.ts）提前备好，不在这里负责。
 */
const applyLive = async (previous: AppSettings, next: AppSettings): Promise<void> => {
  if (next.language !== previous.language) {
    setMainLanguage(next.language);
    // 菜单和托盘的文案在构建时就定死成字符串了，不会自己跟着 i18n 变
    refreshAppMenu();
    refreshTray();
    broadcastLanguage(next.language);
  }

  if (next.theme !== previous.theme) {
    applyTheme(next.theme);
  }

  if (next.proxy.port !== previous.proxy.port) {
    await restartProxyOnPort(next.proxy.port);
  }
};

export const registerSettings = (): void => {
  ipcMain.handle('settings:get', (): AppSettings => getSettings());

  ipcMain.handle('settings:reset', async (): Promise<AppSettings> => {
    const previous = getSettings();
    const restored = resetSettings();
    await applyLive(previous, restored);
    return restored;
  });

  // 保存的返回值是落盘后的那份（越界端口会被纠正），界面要拿它回填
  ipcMain.handle('settings:save', async (_event, settings: AppSettings): Promise<AppSettings> => {
    const previous = getSettings();
    const saved = saveSettings(settings);
    await applyLive(previous, saved);
    return saved;
  });

  ipcMain.handle('app:version', (): string => app.getVersion());

  // V0 没有更新源：先把 IPC 和界面接好，等发布流程定了换成真实查询即可，界面不用动
  ipcMain.handle('update:check', async (): Promise<UpdateCheckResult> => {
    await new Promise((resolve) => setTimeout(resolve, UPDATE_CHECK_DELAY_MS));

    return {
      currentVersion: app.getVersion(),
      updateAvailable: false,
      latestVersion: null
    };
  });
};
