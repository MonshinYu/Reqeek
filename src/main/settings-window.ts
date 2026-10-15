import { BrowserWindow, ipcMain } from 'electron';
import { join } from 'path';
import { is } from '@electron-toolkit/utils';
import icon from '../../resources/icon.png?asset';
import { languageArgs } from './i18n';
import { windowBackground } from './theme';

let settingsWindow: BrowserWindow | null = null;

export const createSettingsWindow = (): BrowserWindow => {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return settingsWindow;
  }

  const window = new BrowserWindow({
    width: 680,
    // 接入 tokens/global 后字号与间距都跟着主界面收紧了，566 = 实测的 44(头) + 451(内容) + 65(脚) 再留几像素余量
    height: 566,
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
