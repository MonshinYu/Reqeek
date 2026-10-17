import {app, BrowserWindow} from 'electron';
import {join} from 'path';
import {electronApp, is, optimizer} from '@electron-toolkit/utils';
import icon from '../../resources/icon.png?asset';
import {configureProxy} from './proxy';
import {configureSettings, getSettings} from './settings';
import {languageArgs, setMainLanguage} from './i18n';
import {applyTheme, titleBarSymbol, watchTheme, windowBackground} from './theme';
import {setupAppMenu} from './menu';
import {hasTray, setupTray} from './tray';
import {
  recoverStaleSystemProxyOnStartup,
  registerProxy,
  registerSettings,
  registerTraffic,
  registerUpdate,
  shutdownProxy
} from './ipc';
import {setupSettingsIpc} from './settings-window';

// 必须与渲染进程 .titleBar 的高度（title-bar.module.css）一致，系统按钮才能垂直居中
const TITLE_BAR_HEIGHT = 44;

let mainWindow: BrowserWindow | null = null;

// 用户是否真的要退出。有托盘时，点关闭按钮只是把窗口藏起来，抓包继续在后台跑；
// 只有走托盘「退出」、Cmd+Q 等路径（before-quit）才会置为 true 并放行关闭
let isQuitting = false;

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

const createWindow = (): BrowserWindow => {
  const window = new BrowserWindow({
    width: 1100,
    height: 700,
    // 太窄时 titlebar 里的搜索框会和系统按钮挤在一起
    minWidth: 720,
    minHeight: 420,
    // 先藏着，等首屏画好再放出来（见下面的 dom-ready）。窗口一旦显示，第一帧就是加载态
    show: false,
    titleBarStyle: 'hidden',
    backgroundColor: windowBackground(),
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
            symbolColor: titleBarSymbol(),
            height: TITLE_BAR_HEIGHT
          }
        }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 语言随启动参数同步交给 preload：渲染进程的 i18n 初始化等不了 IPC
      additionalArguments: languageArgs()
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

  // 首屏就绪再放出窗口，这样窗口弹出的第一帧就是加载态，而不是一层空底色。
  //
  // 为什么只等 dom-ready：加载态是静态内联在 home.html 里的，不依赖 JS，所以等到 HTML
  // 解析完就够了 —— 不必像 ready-to-show 那样等 React 渲染完，窗口会晚得多。
  // 为什么不再等绘制：底色和加载态的背景本来就是同一个颜色，dom-ready 之后那一两帧
  // 即使还没来得及画上 spinner，看起来也是连续的。而等绘制要靠 rAF，隐藏窗口里的
  // rAF 会被 backgroundThrottling 拖慢，得不偿失。
  const revealWindow = (): void => {
    if (!window.isDestroyed() && !window.isVisible()) window.show();
  };
  // 兜底：加载挂起时也得把窗口放出来，否则用户看到的是「应用根本没启动」
  const failSafe = setTimeout(revealWindow, 2000);
  window.webContents.once('dom-ready', () => {
    clearTimeout(failSafe);
    revealWindow();
  });

  window.on('close', (event) => {
    if (isQuitting || !hasTray()) return;
    event.preventDefault();
    window.hide();
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/home.html`);
  } else {
    window.loadFile(join(__dirname, '../renderer/home.html'));
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

/** 把主窗口带到前台：窗口被藏进托盘、最小化或已被销毁时都能唤起 */
const revealMainWindow = (): void => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
};

app.on('second-instance', revealMainWindow);

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

  // 这几件事都必须先于 createWindow：窗口底色是创建那一刻定下的，启动参数里的语言也是，
  // 而设置路径不提前备好的话，这里读到的只是默认值
  configureSettings();
  const initialSettings = getSettings();
  applyTheme(initialSettings.theme);
  setMainLanguage(initialSettings.language);
  watchTheme({ titleBarHeight: TITLE_BAR_HEIGHT });

  mainWindow = createWindow();

  // 窗口可能只是被藏进托盘（未销毁），所以不能只在「没有窗口」时才处理
  app.on('activate', revealMainWindow);

  // 代理核心要拿到 userData 目录才能把快照落盘，而核心本身不 import electron，
  // 所以路径由这里注入。必须在任何代理操作之前完成。
  configureProxy({ stateDir: app.getPath('userData') });

  registerTraffic();
  registerProxy();
  registerSettings();
  registerUpdate();
  setupSettingsIpc();
  setupAppMenu();
  setupTray({
    showWindow: revealMainWindow,
    isWindowActive: () =>
      !!mainWindow &&
      !mainWindow.isDestroyed() &&
      mainWindow.isVisible() &&
      !mainWindow.isMinimized() &&
      mainWindow.isFocused(),
    hideWindow: () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
    }
  });

  // 异步做，不挡窗口显示
  void recoverStaleSystemProxyOnStartup();
});

// 退出前必须把系统代理撤掉，否则会留下一个指向已经消失的进程的设置，
// 用户下次上网就是断的，而且不知道去哪改回来
let proxyShutdown = false;
app.on('before-quit', (event) => {
  isQuitting = true;
  if (proxyShutdown || !hasSingleInstanceLock) return;
  proxyShutdown = true;
  event.preventDefault();
  void shutdownProxy().finally(() => app.quit());
});

app.on('window-all-closed', () => {
  // 有托盘时应用留在后台等待唤起；没有托盘（创建失败）就沿用原行为，否则用户再也找不到它
  if (process.platform !== 'darwin' && !hasTray()) {
    app.quit();
  }
});
