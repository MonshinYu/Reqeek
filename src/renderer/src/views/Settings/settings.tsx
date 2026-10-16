import React, {useEffect, useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {isSupportedLanguage, SUPPORTED_LANGUAGES} from '@shared/i18n';
import {isValidPort, MAX_PORT, MIN_PORT} from '@shared/settings';
import type {AppSettings, UpdateErrorReason, UpdateStatus} from '@shared/types';
import {Button} from '@/components';
import styles from './settings.module.css';

/**
 * 查询失败的文案。
 *
 * 四类原因各给一句对症的：用户看到「检查失败」时唯一想知道的就是「我该做什么」，
 * 而「该等一会儿」「该查网络」「做什么都没用」是三件不同的事，一句笼统的话答不了。
 * 写成穷尽的 switch 而不是查表，好让以后加原因时漏掉这里会编译不过。
 */
const checkFailKey = (reason: UpdateErrorReason): string => {
  switch (reason) {
    case 'rate-limited':
      return 'settings.update.checkRateLimited';
    case 'network':
      return 'settings.update.checkNetworkFailed';
    case 'no-release':
      return 'settings.update.checkNoRelease';
    case 'unknown':
      return 'settings.update.checkFailed';
  }
};

/**
 * 设置窗口：通用（语言 / 主题 / 端口号）+ 关于（版本 / 检查更新）。
 *
 * 改动即时落盘，没有保存按钮 —— 原来那套「保存后关窗」在只有几个选项时纯属多一步。
 * 唯一的例外是端口：草稿留在本地，失焦或回车才提交（见 portDraft）。
 */
export const Settings = (): React.ReactElement => {
  const {t} = useTranslation();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [version, setVersion] = useState('');
  // 用户敲到一半的「8」不是合法端口，不该被立刻纠正掉，所以输入框自己持有一份草稿
  const [portDraft, setPortDraft] = useState('');
  const [updateState, setUpdateState] = useState<UpdateStatus>({phase: 'idle'});
  /** 提交序号：用来丢弃被后续改动追上的那次保存响应 */
  const requestSeq = useRef(0);

  // 只在挂载时读一次：下面每次 setState 都会重渲染，依赖写宽了会把用户正在编辑的端口草稿重置掉
  useEffect(() => {
    void window.api.getSettings().then((loaded) => {
      setSettings(loaded);
      setPortDraft(String(loaded.proxy.port));
    });
    void window.api.getAppVersion().then(setVersion);
  }, []);

  /*
   * 更新状态不归这个窗口所有：下载可能要跑几分钟，窗口关掉再打开得能接回进度，
   * 所以状态存在主进程，这里先拉一次当前值，再订阅之后的变化。
   */
  useEffect(() => {
    void window.api.getUpdateStatus().then(setUpdateState);
    return window.api.onUpdateStatus(setUpdateState);
  }, []);

  /*
   * 语言不在这里自己切：存盘后主进程会广播给所有窗口（含这一个）。
   * 只有一条路径，设置窗口才不会和主窗口用两套时序各自为政。
   */

  /** 落盘并回填：主进程可能纠正了非法值，界面要跟着落盘结果走，而不是跟着自己的乐观状态走 */
  const commit = (next: AppSettings): void => {
    setSettings(next);

    // 改端口会顺带重启代理（几百毫秒），这期间用户再改一项的话，晚到的那次响应
    // 会把新改动覆盖回去。认序号，只让最后一次提交的返回值回填
    const seq = ++requestSeq.current;
    void window.api.saveSettings(next).then((saved) => {
      if (seq !== requestSeq.current) return;
      setSettings(saved);
      setPortDraft(String(saved.proxy.port));
    });
  };

  const commitPort = (): void => {
    if (!settings) return;

    const parsed = Number(portDraft);
    // 草稿不合法或没变就退回已保存的值：静默改写会让用户以为自己改成功了
    if (!isValidPort(parsed) || parsed === settings.proxy.port) {
      setPortDraft(String(settings.proxy.port));
      return;
    }

    commit({...settings, proxy: {port: parsed}});
  };

  const handleReset = (): void => {
    if (!confirm(t('settings.resetConfirm'))) return;

    // 恢复默认同样要占一个序号，否则在途的保存响应回来会把默认值又改回去
    requestSeq.current += 1;
    void window.api.resetSettings().then((restored) => {
      setSettings(restored);
      setPortDraft(String(restored.proxy.port));
    });
  };

  /** 不 await：macOS 上查完会紧接着下载，整个过程几分钟，进度和结论都从 onUpdateStatus 来 */
  const handleCheckUpdate = (): void => {
    void window.api.checkForUpdates();
  };

  const handleInstallUpdate = (): void => {
    void window.api.installUpdate();
  };

  if (!settings) {
    return (
      <div className={styles.loading}>
        <div className={styles.spinner} />
      </div>
    );
  }

  // 获取平台类名
  const platform = navigator.platform.toLowerCase();
  let platformClass = '';
  if (platform.includes('win')) {
    platformClass = styles.platformWin32;
  } else if (platform.includes('mac')) {
    platformClass = styles.platformDarwin;
  } else if (platform.includes('linux')) {
    platformClass = styles.platformLinux;
  }

  const updateHint = (): string => {
    switch (updateState.phase) {
      case 'checking':
        return t('settings.update.checking');
      case 'up-to-date':
        return t('settings.update.upToDate');
      case 'downloading':
        return t('settings.update.downloading', {percent: updateState.percent});
      case 'ready':
        // 两个平台停在不同地方：Windows 等用户点一下重启，macOS 已经把 dmg 打开了
        return updateState.kind === 'restart'
          ? t('settings.update.readyRestart', {version: updateState.version})
          : t('settings.update.readyOpened', {version: updateState.version});
      case 'error':
        return updateState.stage === 'download'
          ? t('settings.update.downloadFailed')
          : t(checkFailKey(updateState.reason));
      default:
        return '';
    }
  };

  /** 安装包就位后按钮换成后续动作，而不是退回「检查更新」—— 再查一遍只会又下一遍 100MB */
  const updateButtonLabel = (): string => {
    switch (updateState.phase) {
      case 'ready':
        return updateState.kind === 'restart'
          ? t('settings.update.install')
          : t('settings.update.openInstaller');
      default:
        return t('settings.update.check');
    }
  };

  const hint = updateHint();
  const updateBusy = updateState.phase === 'checking' || updateState.phase === 'downloading';
  const updateReadyToInstall = updateState.phase === 'ready';

  return (
    <div className={`${styles.window} ${platformClass}`}>
      <div className={styles.header}>
        <h1>{t('settings.title')}</h1>
      </div>

      <div className={styles.content}>
        <section className={styles.section}>
          <h2>{t('settings.general')}</h2>

          <div className={styles.field}>
            <label htmlFor="setting-language">{t('settings.language')}</label>
            <select
              id="setting-language"
              value={settings.language}
              onChange={(e) => {
                const language = e.target.value;
                if (!isSupportedLanguage(language)) return;
                commit({...settings, language});
              }}
            >
              {SUPPORTED_LANGUAGES.map((code) => (
                <option key={code} value={code}>
                  {t(`languages.${code}`)}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.field}>
            <label htmlFor="setting-theme">{t('settings.theme')}</label>
            <select
              id="setting-theme"
              value={settings.theme}
              onChange={(e) =>
                commit({...settings, theme: e.target.value as AppSettings['theme']})
              }
            >
              <option value="auto">{t('settings.themeOptions.auto')}</option>
              <option value="light">{t('settings.themeOptions.light')}</option>
              <option value="dark">{t('settings.themeOptions.dark')}</option>
            </select>
          </div>

          <div className={styles.field}>
            <label htmlFor="setting-port">{t('settings.port')}</label>
            <input
              id="setting-port"
              type="number"
              min={MIN_PORT}
              max={MAX_PORT}
              value={portDraft}
              onChange={(e) => setPortDraft(e.target.value)}
              onBlur={commitPort}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitPort();
              }}
            />
          </div>
        </section>

        <section className={styles.section}>
          <h2>{t('settings.about')}</h2>

          <div className={styles.field}>
            <label>{t('settings.version')}</label>
            <span className={styles.value}>{version || '—'}</span>
          </div>

          <div className={styles.field}>
            <label>{t('settings.update.title')}</label>
            <div className={styles.updateRow}>
              {hint && <span className={styles.hint}>{hint}</span>}
              <Button
                onClick={updateReadyToInstall ? handleInstallUpdate : handleCheckUpdate}
                disabled={updateBusy}
              >
                {updateButtonLabel()}
              </Button>
            </div>
          </div>

          {/* 进度条挂在 field 外面，好占满整行；只有一个细条，不抢按钮的位置 */}
          {updateState.phase === 'downloading' && (
            <div className={styles.progress}>
              <div className={styles.progressBar} style={{width: `${updateState.percent}%`}} />
            </div>
          )}
        </section>
      </div>

      <div className={styles.footer}>
        <Button onClick={handleReset}>{t('settings.reset')}</Button>
        <Button onClick={() => window.close()}>{t('settings.close')}</Button>
      </div>
    </div>
  );
};
