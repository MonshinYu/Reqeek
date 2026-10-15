import { BrowserWindow, nativeTheme } from 'electron';
import type { AppSettings } from '@shared/types';

/**
 * 窗口自身的颜色。
 *
 * 这两组值必须和 tokens.css 里对应的 --md-* 保持一致：窗口先于 CSS 显示出来，
 * 对不上的话启动时会先闪一下另一种主题的颜色再跳成正确的。
 */
const WINDOW_BACKGROUND = {
  dark: '#1b1b1f',
  light: '#f9f9ff'
} as const;

/** Windows 标题栏上那三个按钮：浅色下必须换成深色，否则白底上看不见白按钮 */
const TITLE_BAR_SYMBOL = {
  dark: '#ffffff',
  light: '#191c20'
} as const;

export const windowBackground = (): string =>
  nativeTheme.shouldUseDarkColors ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light;

export const titleBarSymbol = (): string =>
  nativeTheme.shouldUseDarkColors ? TITLE_BAR_SYMBOL.dark : TITLE_BAR_SYMBOL.light;

/**
 * 把设置里的主题交给 Electron —— 这是主题的唯一权威。
 *
 * themeSource 一变，所有窗口的 prefers-color-scheme 立刻跟着变，渲染进程一行 JS 都不用写，
 * 之后新开的窗口也自动是对的。'auto' 直接交给 'system'：系统换主题时 Electron 自己会推。
 */
export const applyTheme = (theme: AppSettings['theme']): void => {
  nativeTheme.themeSource = theme === 'auto' ? 'system' : theme;
};

/**
 * 主题变化时，把渲染进程管不到的那几处颜色补上。
 *
 * CSS 里的颜色不用管（media query 会自己重算），但窗口底色和 Windows 的系统标题栏按钮
 * 是 Electron 在页面之外画的，只能手动同步。系统跟随（auto）导致的切换也走这条路径。
 */
export const watchTheme = (options: { titleBarHeight: number }): void => {
  nativeTheme.on('updated', () => {
    const background = windowBackground();

    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue;

      window.setBackgroundColor(background);

      // 只有 Windows / Linux 用了系统画的标题栏覆盖层；设置窗口在那边是原生边框，没有这层
      if (process.platform !== 'darwin') {
        try {
          window.setTitleBarOverlay({
            color: '#00000000',
            symbolColor: titleBarSymbol(),
            height: options.titleBarHeight
          });
        } catch {
          // 没启用覆盖层的窗口会在这里抛：不是错误，本来就没它的事
        }
      }
    }
  });
};
