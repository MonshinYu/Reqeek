import {DEFAULT_LANGUAGE, type SupportedLanguage} from '@shared/i18n';
import de from '@shared/locales/de.json';
import en from '@shared/locales/en.json';
import es from '@shared/locales/es.json';
import fr from '@shared/locales/fr.json';
import ja from '@shared/locales/ja.json';
import ko from '@shared/locales/ko.json';
import pt from '@shared/locales/pt.json';
import ru from '@shared/locales/ru.json';
import zh from '@shared/locales/zh.json';

/*
 * 主进程要翻的只有原生菜单和托盘，用不到复数、格式化这些能力，
 * 所以不把整个 i18next 拖进主进程 bundle —— 一个点号查表加插值就够了。
 * 语言包本身和渲染进程共用同一份（shared/locales），改文案不会漏掉菜单。
 *
 * 类型是 Record<SupportedLanguage, …>，所以 shared/i18n.ts 里加了语言却忘了在这里
 * import 的话，typecheck 会直接报错，不会拖到运行时才发现菜单缺词。
 */
const RESOURCES: Record<SupportedLanguage, unknown> = { de, en, es, fr, ja, ko, pt, ru, zh };

let current: SupportedLanguage = DEFAULT_LANGUAGE;

/** 由启动流程和设置保存处调用；改完要自己负责重建菜单 */
export const setMainLanguage = (language: SupportedLanguage): void => {
  current = language;
};

/**
 * 随窗口启动参数把当前语言带给渲染进程。
 *
 * 渲染进程的 i18n 在模块加载时就初始化，等不了一次 IPC；同步读到的值意味着首帧
 * 就是正确的语言，而不是先按系统语言渲染一遍再跳过去。
 */
export const languageArgs = (): string[] => [`--reqeek-language=${current}`];

const lookup = (source: unknown, path: string[]): string | null => {
  let node: unknown = source;

  for (const key of path) {
    if (typeof node !== 'object' || node === null) return null;
    node = (node as Record<string, unknown>)[key];
  }

  return typeof node === 'string' ? node : null;
};

/**
 * 取词。当前语言里找不到就退回英语，再找不到把 key 原样返回 ——
 * 菜单上出现一个 menu.capture，总比整条菜单是空的强。
 */
export const t = (key: string, vars?: Record<string, string>): string => {
  const path = key.split('.');
  const raw =
    lookup(RESOURCES[current], path) ?? lookup(RESOURCES[DEFAULT_LANGUAGE], path) ?? key;

  if (!vars) return raw;

  return raw.replace(/\{\{(\w+)\}\}/g, (match, name: string) => vars[name] ?? match);
};
