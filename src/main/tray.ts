import {app, Menu, nativeImage, Tray} from 'electron';
import icon from '../../resources/icon.png?asset';
import {getProxyStatus, onProxyEvent} from './proxy';
import {t} from './i18n';
import {sendMenuAction} from './menu';
import type {ProxyStatus} from '@shared/types';

const isMac = process.platform === 'darwin';

/** 托盘需要主窗口配合的几件事，由 index.ts 注入，避免这里反向依赖窗口创建逻辑 */
export interface TrayController {
  /** 显示并聚焦主窗口；窗口不存在时重建 */
  showWindow: () => void;
  /** 窗口当前对用户可见且处于前台 */
  isWindowActive: () => boolean;
  hideWindow: () => void;
}

let tray: Tray | null = null;

/** setupTray 里那个重建函数。语言变了要重来一遍，但那时已经出了闭包 */
let rebuild: (() => void) | null = null;

/** 托盘是否可用。创建失败（例如 Linux 没有 AppIndicator）时为 false，此时关闭窗口必须真的退出，否则应用无法再被唤起 */
export const hasTray = (): boolean => tray !== null && !tray.isDestroyed();

/** 语言变化后重建托盘菜单与提示文字；没创建托盘时什么都不做 */
export const refreshTray = (): void => rebuild?.();

const createTrayIcon = (): Electron.NativeImage => {
  // 源图是 512px，直接交给系统缩放会很糊，所以先按平台常用的托盘尺寸缩好
  const size = isMac ? 18 : 32;
  return nativeImage.createFromPath(icon).resize({ width: size, height: size, quality: 'best' });
};

const describe = (status: ProxyStatus): string =>
  status.running
    ? t('tray.capturing', { name: app.name, port: String(status.port ?? '—') })
    : t('tray.idle', { name: app.name });

const buildMenu = (status: ProxyStatus, controller: TrayController): Menu =>
  Menu.buildFromTemplate([
    { label: t('tray.show', { name: app.name }), click: () => controller.showWindow() },
    { type: 'separator' },
    {
      label: status.running ? t('menu.stopCapture') : t('menu.startCapture'),
      // 开始抓包可能被 CA 门禁拦住，门禁界面在渲染进程里，所以开始时要把窗口带出来让用户看到；
      // 停止不需要，直接在后台完成
      click: () => sendMenuAction('toggle-capture', !status.running)
    },
    { label: t('menu.clear'), click: () => sendMenuAction('clear', false) },
    { type: 'separator' },
    { label: t('menu.ca'), click: () => sendMenuAction('open-ca', true) },
    { type: 'separator' },
    { label: t('tray.quit', { name: app.name }), click: () => app.quit() }
  ]);

/**
 * 创建系统托盘，并随代理启停刷新菜单与提示文字。
 * 必须在 app ready 之后调用。
 */
export const setupTray = (controller: TrayController): void => {
  if (hasTray()) return;

  try {
    tray = new Tray(createTrayIcon());
  } catch (error) {
    console.error('[Reqeek] 创建托盘失败：', error);
    tray = null;
    return;
  }

  const current = tray;
  let status = getProxyStatus();

  rebuild = (): void => {
    if (current.isDestroyed()) return;
    current.setToolTip(describe(status));
    current.setContextMenu(buildMenu(status, controller));
  };
  rebuild();

  // macOS 点击托盘图标本来就会弹出菜单；Windows 习惯左键切换窗口、右键出菜单
  if (!isMac) {
    current.on('click', () => {
      if (controller.isWindowActive()) controller.hideWindow();
      else controller.showWindow();
    });
  }

  onProxyEvent((event) => {
    if (event.type !== 'status') return;
    status = event.status;
    rebuild?.();
  });

  // Windows 上不显式销毁，退出后图标会残留在托盘里直到鼠标划过
  app.on('will-quit', () => {
    if (!current.isDestroyed()) current.destroy();
    tray = null;
    rebuild = null;
  });
};
