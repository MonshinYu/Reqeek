import { app } from 'electron';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { DEFAULT_LANGUAGE, isSupportedLanguage, matchLanguage, type SupportedLanguage } from '@shared/i18n';
import { isValidPort } from '@shared/settings';
import type { AppSettings } from '@shared/types';

const DEFAULT_SETTINGS: AppSettings = {
  // 只是个占位：真正生效的语言由 detectLanguage() 决定，从不写死某个语言
  language: DEFAULT_LANGUAGE,
  theme: 'auto',
  proxy: {
    // 与打通前硬编码在 ipc/proxy.ts 里的端口一致：老用户升级后代理不会突然换个端口起
    port: 8989
  }
};

/**
 * 首次启动（以及文件里存着我们不认识的语言时）按系统区域设置挑一个。
 *
 * 用 getSystemLocale 而不是 getLocale：前者是操作系统实际的区域设置，后者是 Chromium
 * 真正用于渲染的语言，用户改过显示语言时两者会分叉 —— 我们要的是「这台电脑的语言」。
 * 支持列表里没有对应的就用英语。
 */
const detectLanguage = (): SupportedLanguage =>
  matchLanguage(app.getSystemLocale()) ?? DEFAULT_LANGUAGE;

let settingsPath = '';
let cachedSettings: AppSettings | null = null;

export const configureSettings = (): void => {
  settingsPath = join(app.getPath('userData'), 'settings.json');
};

/**
 * 把磁盘上读到的任意内容收成当前的设置结构。
 *
 * 逐字段挑而不是展开：老版本存下的 autoStart / fontSize 这些在结构里已经没有位置，
 * 留着它们只会在下次写盘时把垃圾抄回去。这里同时也是端口合法性的唯一权威 ——
 * settings.json 是纯文本，用户手改成 70000 也不能让代理真去绑。
 */
const normalize = (raw: unknown): AppSettings => {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<AppSettings>;
  const proxy = (source.proxy ?? {}) as Partial<AppSettings['proxy']>;

  return {
    language: isSupportedLanguage(source.language) ? source.language : detectLanguage(),
    theme: source.theme === 'light' || source.theme === 'dark' ? source.theme : 'auto',
    proxy: {
      port: isValidPort(proxy.port) ? proxy.port : DEFAULT_SETTINGS.proxy.port
    }
  };
};

export const getSettings = (): AppSettings => {
  if (cachedSettings) return cachedSettings;

  let raw: unknown = null;
  if (existsSync(settingsPath)) {
    try {
      raw = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {
      // 文件坏了不该让应用起不来：退回默认值，下一次保存会把它覆盖掉
      raw = null;
    }
  }

  cachedSettings = normalize(raw);
  return cachedSettings;
};

/** 返回真正落盘的那份 —— 非法字段会被纠正，调用方拿它回填界面，而不是信自己传进来的值 */
export const saveSettings = (settings: AppSettings): AppSettings => {
  const normalized = normalize(settings);

  try {
    writeFileSync(settingsPath, JSON.stringify(normalized, null, 2), 'utf-8');
  } catch (error) {
    throw new Error(`Failed to save settings: ${error}`);
  }

  cachedSettings = normalized;
  return normalized;
};

/**
 * 写回默认值并返回它。返回值同样是落盘后的那份，语义与 saveSettings 一致。
 *
 * 语言单独取当前系统语言：把「恢复默认」也定义成「切回英语」是说不通的。
 */
export const resetSettings = (): AppSettings =>
  saveSettings({ ...DEFAULT_SETTINGS, language: detectLanguage() });
