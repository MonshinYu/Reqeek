/**
 * 语言清单与匹配规则。
 *
 * 主进程（首次启动探测系统语言）和渲染进程（i18n 初始化）都要用同一份，
 * 各写一份的话，加语言时漏掉任何一边都会表现成「设置里能选、界面不认」。
 */

/** 界面支持的语言。加语言时这里和 shared/locales/ 下的文件要一起加 */
export const SUPPORTED_LANGUAGES = ['en', 'zh', 'ja'] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** 系统语言一个都对不上时的兜底 */
export const DEFAULT_LANGUAGE: SupportedLanguage = 'en';

export const isSupportedLanguage = (value: unknown): value is SupportedLanguage =>
  typeof value === 'string' && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);

/**
 * 把系统给的标签收成我们支持的语言。
 *
 * 系统给的是 zh-CN / ja-JP / en_US 这类带地区的标签，我们只按主语言标签匹配 ——
 * 简繁、英式美式都落到同一个包里。匹配不上返回 null，由调用方决定兜底成什么。
 */
export const matchLanguage = (tag: string): SupportedLanguage | null => {
  const primary = tag.toLowerCase().split(/[-_]/)[0];
  return isSupportedLanguage(primary) ? primary : null;
};
