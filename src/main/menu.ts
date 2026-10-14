import {app, BrowserWindow, Menu, type MenuItemConstructorOptions, shell} from 'electron';
import {is} from '@electron-toolkit/utils';
import {getCaStatus, getProxyStatus, onProxyEvent} from './proxy';
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
  const appMenu: MenuItemConstructorOptions = {
    label: app.name,
    submenu: [
      { role: 'about', label: `关于 ${app.name}` },
      { type: 'separator' },
      { role: 'services', label: '服务' },
      { type: 'separator' },
      { role: 'hide', label: `隐藏 ${app.name}` },
      { role: 'hideOthers', label: '隐藏其他' },
      { role: 'unhide', label: '全部显示' },
      { type: 'separator' },
      { role: 'quit', label: `退出 ${app.name}` }
    ]
  };

  const captureMenu: MenuItemConstructorOptions = {
    label: '抓包',
    submenu: [
      {
        label: running ? '停止抓包' : '开始抓包',
        accelerator: 'CmdOrCtrl+R',
        click: () => sendAction('toggle-capture')
      },
      {
        label: '清空记录',
        accelerator: 'CmdOrCtrl+K',
        click: () => sendAction('clear')
      },
      { type: 'separator' },
      {
        label: '搜索请求',
        accelerator: 'CmdOrCtrl+F',
        click: () => sendAction('focus-search')
      },
      { type: 'separator' },
      {
        label: 'CA 证书…',
        click: () => sendAction('open-ca')
      }
    ]
  };

  const editMenu: MenuItemConstructorOptions = {
    label: '编辑',
    submenu: [
      { role: 'undo', label: '撤销' },
      { role: 'redo', label: '重做' },
      { type: 'separator' },
      { role: 'cut', label: '剪切' },
      { role: 'copy', label: '复制' },
      { role: 'paste', label: '粘贴' },
      { role: 'selectAll', label: '全选' }
    ]
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: '视图',
    submenu: [
      // 开发期工具只在 dev 暴露；Cmd+R 已被「开始 / 停止抓包」占用，所以重载用 Shift+Cmd+R
      ...(is.dev
        ? ([
            { role: 'forceReload', label: '强制重新加载' },
            { role: 'toggleDevTools', label: '开发者工具' },
            { type: 'separator' }
          ] as MenuItemConstructorOptions[])
        : []),
      { role: 'resetZoom', label: '实际大小' },
      { role: 'zoomIn', label: '放大' },
      { role: 'zoomOut', label: '缩小' },
      { type: 'separator' },
      { role: 'togglefullscreen', label: '切换全屏' }
    ]
  };

  const windowMenu: MenuItemConstructorOptions = {
    label: '窗口',
    role: 'windowMenu'
  };

  const helpMenu: MenuItemConstructorOptions = {
    label: '帮助',
    role: 'help',
    submenu: [
      // macOS 的「关于」已在应用菜单里，其他平台放到帮助菜单
      ...(isMac
        ? []
        : ([
            { role: 'about', label: `关于 ${app.name}` },
            { type: 'separator' }
          ] as MenuItemConstructorOptions[])),
      {
        label: '在文件夹中显示 CA 证书',
        click: () => {
          void getCaStatus()
            .then((status) => shell.showItemInFolder(status.certPath))
            .catch((error: unknown) => {
              console.error('[Reqeek] 无法定位 CA 证书：', error);
            });
        }
      },
      {
        label: '打开数据目录',
        click: () => {
          void shell.openPath(app.getPath('userData'));
        }
      }
    ]
  };

  return [...(isMac ? [appMenu] : []), captureMenu, editMenu, viewMenu, windowMenu, helpMenu];
};

const applyMenu = (running: boolean): void => {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildTemplate(running)));
};

/**
 * 安装应用菜单，并在代理启停时重建，让「开始 / 停止抓包」的文案跟着状态走。
 * 必须在 app ready 之后调用。
 */
export const setupAppMenu = (): void => {
  let running = getProxyStatus().running;
  applyMenu(running);

  onProxyEvent((event) => {
    if (event.type !== 'status' || event.status.running === running) return;
    running = event.status.running;
    applyMenu(running);
  });
};
