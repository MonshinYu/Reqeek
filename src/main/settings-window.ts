import {BrowserWindow, ipcMain} from 'electron';
import {join} from 'path';
import {is} from '@electron-toolkit/utils';
import icon from '../../resources/icon.png?asset';
import {languageArgs} from './i18n';
import {windowBackground} from './theme';

let settingsWindow: BrowserWindow | null = null;

/** 设置窗口与主窗口共享 preload，导航范围必须同样收紧到自己的唯一入口页。 */
const isSettingsUrl = (url: string): boolean => {
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  try {
    const target = new URL(url);
    if (is.dev && devUrl) {
      const devTarget = new URL(devUrl);
      return target.origin === devTarget.origin && target.pathname === '/settings.html';
    }
    return target.protocol === 'file:' && target.pathname.endsWith('/settings.html');
  } catch {
    return false;
  }
};

export const createSettingsWindow = (): BrowserWindow => {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return settingsWindow;
  }

  const window = new BrowserWindow({
    width: 680,
    /*
     * 接入 tokens/global 后字号与间距都跟着主界面收紧了，高度是按内容实测卡死的，
     * 窗口里加了东西就要跟着改：622 = 44(头) + 507(内容) + 65(脚) 再留几像素余量。
     * 内容从 451 涨到 507 是「关于」区多了一行「检查更新」（.field 的上下内边距 24 + 按钮 32）。
     *
     * useContentSize 不能省：默认 false 时 height 指的是整窗尺寸，而下面非 darwin 走
     * frame: true，会被原生标题栏吃掉约 31px —— 同一个常量于是三平台不同义（macOS 内容高 622，
     * Windows 只剩约 591），差额一直靠 .content 的滚动条吞着。设成 true，这个数字才处处同义。
     */
    height: 622,
    useContentSize: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    title: 'Settings',
    backgroundColor: windowBackground(),
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hidden',
          trafficLightPosition: { x: 20, y: 20 }
        }
      : {
          icon,
          frame: true
        }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: languageArgs()
    }
  });

  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  window.webContents.on('will-navigate', (event, url) => {
    if (!isSettingsUrl(url)) event.preventDefault();
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  window.on('closed', () => {
    settingsWindow = null;
  });

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/settings.html`);
  } else {
    window.loadFile(join(__dirname, '../renderer/settings.html'));
  }

  settingsWindow = window;
  return window;
};

export const setupSettingsIpc = (): void => {
  ipcMain.on('settings:open', () => {
    createSettingsWindow();
  });
};
