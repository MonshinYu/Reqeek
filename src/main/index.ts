import {app, BrowserWindow, ipcMain} from 'electron';
import {join} from 'path';
import {electronApp, is, optimizer} from '@electron-toolkit/utils';
import icon from '../../resources/icon.png?asset';
import {configureProxy} from './proxy';
import {setupAppMenu} from './menu';
import {recoverStaleSystemProxyOnStartup, registerProxy, registerTraffic, shutdownProxy} from './ipc';

const BACKGROUND_COLOR = '#1b1b1f';
// 必须与渲染进程 .titleBar 的高度（title-bar.module.css）一致，系统按钮才能垂直居中
const TITLE_BAR_HEIGHT = 44;

let mainWindow: BrowserWindow | null = null;

const isAppUrl = (url: string): boolean => {
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  try {
    const target = new URL(url);
    if (is.dev && devUrl) return target.origin === new URL(devUrl).origin;
    return target.protocol === 'file:';
  } catch {
    // 解析不了的地址一律当作应用外地址拦下
    return false;
  }
};

const showWindow = (window: BrowserWindow): void => {
  if (!window.isDestroyed() && !window.isVisible()) window.show();
};

const createWindow = (): BrowserWindow => {
  const window = new BrowserWindow({
    width: 1100,
    height: 700,
    // 太窄时 titlebar 里的搜索框会和系统按钮挤在一起
    minWidth: 720,
    minHeight: 420,
    show: false,
    titleBarStyle: 'hidden',
    backgroundColor: BACKGROUND_COLOR,
    ...(process.platform === 'darwin'
      ? {
          trafficLightPosition: {
            x: 18,
            y: 15
          }
        }
      : {
          icon,
          titleBarOverlay: {
            color: '#00000000',
            symbolColor: '#ffffff',
            height: TITLE_BAR_HEIGHT
          }
        }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // 应用只有一个本地页面：不允许新开窗口，也不允许导航到别处（含 dev 服务器以外的地址）
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });

  // Windows / Linux 只隐藏菜单栏而不移除：菜单仍挂在窗口上，Ctrl+R / Ctrl+K 等快捷键才有效。
  // macOS 的应用菜单是 app 级的，不受影响
  if (process.platform !== 'darwin') window.setMenuBarVisibility(false);

  window.once('ready-to-show', () => showWindow(window));
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return window;
};

// 系统代理的还原依赖「同一时刻只有一份落盘记录」这个前提。
// 放任第二个实例起来，它会把前一个实例的快照当成"上次崩溃的残留"去还原，
// 于是第一个实例还在跑、系统代理却已经被撤掉了。
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
}

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return;

  electronApp.setAppUserModelId('com.reqeek.app');

  app.setAboutPanelOptions({
    applicationName: 'Reqeek',
    applicationVersion: app.getVersion(),
    copyright: 'Copyright © 2026 MonshinYu'
  });

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  ipcMain.on('renderer-ready', () => {
    if (mainWindow) showWindow(mainWindow);
  });

  mainWindow = createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });

  // 代理核心要拿到 userData 目录才能把快照落盘，而核心本身不 import electron，
  // 所以路径由这里注入。必须在任何代理操作之前完成。
  configureProxy({ stateDir: app.getPath('userData') });

  registerTraffic();
  registerProxy();
  setupAppMenu();

  // 异步做，不挡窗口显示
  void recoverStaleSystemProxyOnStartup();
});

// 退出前必须把系统代理撤掉，否则会留下一个指向已经消失的进程的设置，
// 用户下次上网就是断的，而且不知道去哪改回来
let proxyShutdown = false;
app.on('before-quit', (event) => {
  if (proxyShutdown || !hasSingleInstanceLock) return;
  proxyShutdown = true;
  event.preventDefault();
  void shutdownProxy().finally(() => app.quit());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
