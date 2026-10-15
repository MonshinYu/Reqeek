import {app, BrowserWindow, Menu, type MenuItemConstructorOptions, shell} from 'electron';
import {is} from '@electron-toolkit/utils';
import {getCaStatus, getProxyStatus, onProxyEvent} from './proxy';
import {t} from './i18n';
import type {MenuAction} from '@shared/types';

const MENU_CHANNEL = 'menu:action';
const isMac = process.platform === 'darwin';

/**
 * 把动作交给渲染进程执行。
 * @param action
 * @param reveal 是否同时把窗口带到前台；托盘里的后台操作（如停止抓包、清空）传 false，窗口保持隐藏
 */
export const sendMenuAction = (action: MenuAction, reveal = true): void => {
  const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!target || target.isDestroyed()) return;
  if (reveal) {
    if (target.isMinimized()) target.restore();
    target.show();
  }
  target.webContents.send(MENU_CHANNEL, action);
};

const sendAction = (action: MenuAction): void => sendMenuAction(action);

const buildTemplate = (running: boolean): MenuItemConstructorOptions[] => {
  const appName = app.name;

  const appMenu: MenuItemConstructorOptions = {
    label: app.name,
    submenu: [
      { role: 'about', label: t('menu.about', { name: appName }) },
      { type: 'separator' },
      { role: 'services', label: t('menu.services') },
      { type: 'separator' },
      { role: 'hide', label: t('menu.hide', { name: appName }) },
      { role: 'hideOthers', label: t('menu.hideOthers') },
      { role: 'unhide', label: t('menu.unhide') },
      { type: 'separator' },
      { role: 'quit', label: t('menu.quit', { name: appName }) }
    ]
  };

  const captureMenu: MenuItemConstructorOptions = {
    label: t('menu.capture'),
    submenu: [
      {
        label: running ? t('menu.stopCapture') : t('menu.startCapture'),
        accelerator: 'CmdOrCtrl+R',
        click: () => sendAction('toggle-capture')
      },
      {
        label: t('menu.clear'),
        accelerator: 'CmdOrCtrl+K',
        click: () => sendAction('clear')
      },
      { type: 'separator' },
      {
        label: t('menu.focusSearch'),
        accelerator: 'CmdOrCtrl+F',
        click: () => sendAction('focus-search')
      },
      { type: 'separator' },
      {
        label: t('menu.ca'),
        click: () => sendAction('open-ca')
      },
      {
        label: t('menu.settings'),
        accelerator: 'CmdOrCtrl+,',
        click: () => sendAction('open-settings')
      }
    ]
  };

  const editMenu: MenuItemConstructorOptions = {
    label: t('menu.edit'),
    submenu: [
      { role: 'undo', label: t('menu.undo') },
      { role: 'redo', label: t('menu.redo') },
      { type: 'separator' },
      { role: 'cut', label: t('menu.cut') },
      { role: 'copy', label: t('menu.copy') },
      { role: 'paste', label: t('menu.paste') },
      { role: 'selectAll', label: t('menu.selectAll') }
    ]
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: t('menu.view'),
    submenu: [
      // 开发期工具只在 dev 暴露；Cmd+R 已被「开始 / 停止抓包」占用，所以重载用 Shift+Cmd+R
      ...(is.dev
        ? ([
            { role: 'forceReload', label: t('menu.forceReload') },
            { role: 'toggleDevTools', label: t('menu.toggleDevTools') },
            { type: 'separator' }
          ] as MenuItemConstructorOptions[])
        : []),
      { role: 'resetZoom', label: t('menu.resetZoom') },
      { role: 'zoomIn', label: t('menu.zoomIn') },
      { role: 'zoomOut', label: t('menu.zoomOut') },
      { type: 'separator' },
      { role: 'togglefullscreen', label: t('menu.toggleFullScreen') }
    ]
  };

  const windowMenu: MenuItemConstructorOptions = {
    label: t('menu.window'),
    role: 'windowMenu'
  };

  const helpMenu: MenuItemConstructorOptions = {
    label: t('menu.help'),
    role: 'help',
    submenu: [
      // macOS 的「关于」已在应用菜单里，其他平台放到帮助菜单
      ...(isMac
        ? []
        : ([
            { role: 'about', label: t('menu.about', { name: appName }) },
            { type: 'separator' }
          ] as MenuItemConstructorOptions[])),
      {
        label: t('menu.revealCa'),
        click: () => {
          void getCaStatus()
            .then((status) => shell.showItemInFolder(status.certPath))
            .catch((error: unknown) => {
              console.error('[Reqeek] 无法定位 CA 证书：', error);
            });
        }
      },
      {
        label: t('menu.openDataDir'),
        click: () => {
          void shell.openPath(app.getPath('userData'));
        }
      }
    ]
  };

  return [...(isMac ? [appMenu] : []), captureMenu, editMenu, viewMenu, windowMenu, helpMenu];
};

/** 「开始 / 停止抓包」的文案跟着状态走，所以这个值是模块级的，重建时要复用 */
let currentRunning = false;

const applyMenu = (): void => {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildTemplate(currentRunning)));
};

/**
 * 语言变了要重建菜单：label 在构建时就定死成字符串了，不会自己跟着 i18n 走。
 */
export const refreshAppMenu = (): void => applyMenu();

/**
 * 安装应用菜单，并在代理启停时重建，让「开始 / 停止抓包」的文案跟着状态走。
 * 必须在 app ready 之后调用。
 */
export const setupAppMenu = (): void => {
  currentRunning = getProxyStatus().running;
  applyMenu();

  onProxyEvent((event) => {
    if (event.type !== 'status' || event.status.running === currentRunning) return;
    currentRunning = event.status.running;
    applyMenu();
  });
};
