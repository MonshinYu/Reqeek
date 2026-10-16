import i18n from 'i18next';
import {initReactI18next} from 'react-i18next';
import {DEFAULT_LANGUAGE, matchLanguage, type SupportedLanguage} from '@shared/i18n';
import de from '@shared/locales/de.json';
import en from '@shared/locales/en.json';
import es from '@shared/locales/es.json';
import fr from '@shared/locales/fr.json';
import ja from '@shared/locales/ja.json';
import ko from '@shared/locales/ko.json';
import pt from '@shared/locales/pt.json';
import ru from '@shared/locales/ru.json';
import zh from '@shared/locales/zh.json';

/* 加语言时这里和 main/i18n.ts 都要补一行 —— 静态 import 没法扫描目录 */
const resources = {
  de: { translation: de },
  en: { translation: en },
  es: { translation: es },
  fr: { translation: fr },
  ja: { translation: ja },
  ko: { translation: ko },
  pt: { translation: pt },
  ru: { translation: ru },
  zh: { translation: zh }
};

/**
 * 语言由主进程在创建窗口时注入（settings.json 是唯一权威源），同步就能读到 ——
 * 所以首帧就是正确的语言，不会先按系统语言渲染一帧再跳。
 *
 * 注入值缺失时退回系统语言，再不行才用兜底值；这条路径正常不会走到，
 * 留着是为了 i18n 初始化不能因为一个取不到的值就崩掉。
 */
const initialLanguage = (): SupportedLanguage =>
  matchLanguage(window.api.initialLanguage ?? '') ??
  matchLanguage(navigator.language) ??
  DEFAULT_LANGUAGE;

void i18n.use(initReactI18next).init({
  resources,
  lng: initialLanguage(),
  fallbackLng: DEFAULT_LANGUAGE,
  interpolation: {
    escapeValue: false
  }
});

/*
 * 设置窗口改了语言，主进程会广播过来。
 * 注册在这里而不是各个页面里：这个模块被 home 和 settings 两个入口都 import 过，
 * 注册一次两个窗口都生效，也不会随 React 的挂载卸载反复订阅。
 */
window.api.onLanguageChanged((language) => {
  const matched = matchLanguage(language);
  if (matched) void i18n.changeLanguage(matched);
});

export { i18n };
