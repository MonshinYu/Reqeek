import React, {useEffect, useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {SUPPORTED_LANGUAGES} from '@shared/i18n';
import {isValidPort, MAX_PORT, MIN_PORT} from '@shared/settings';
import type {AppSettings, UpdateCheckResult, UpdateFailureReason} from '@shared/types';
import {Button} from '@/components/Button';
import {Dialog} from '@/components/Dialog';
import {FormField} from '@/components/FormField';
import {Input} from '@/components/Input';
import {Select, type SelectOption} from '@/components/Select';
import {Spinner} from '@/components/Spinner';
import styles from './settings.module.css';

/**
 * 设置窗口：通用（语言 / 主题 / 端口号）+ 关于（版本 / 检查更新）。
 *
 * 改动即时落盘，没有保存按钮 —— 原来那套「保存后关窗」在只有几个选项时纯属多一步。
 * 唯一的例外是端口：草稿留在本地，失焦或回车才提交（见 portDraft）。
 */

/**
 * 更新状态。idle / checking 只存在于界面，主进程只会返回另外三个。
 *
 * 和主进程共用 phase 这个判别字段，所以能把两边的成员并进同一个联合类型里，
 * 窄化一路走得通，不用写类型断言。
 */
type UpdateState = UpdateCheckResult | {phase: 'idle'} | {phase: 'checking'};

/** 失败原因到文案的映射，写成穷尽的 switch：以后加原因时漏掉这里会编译不过 */
const failureKey = (reason: UpdateFailureReason): string => {
  switch (reason) {
    case 'network':
      return 'settings.update.checkNetworkFailed';
    case 'server':
      return 'settings.update.checkServerFailed';
  }
};

export const Settings = (): React.ReactElement => {
  const {t} = useTranslation();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [version, setVersion] = useState('');
  // 用户敲到一半的「8」不是合法端口，不该被立刻纠正掉，所以输入框自己持有一份草稿
  const [portDraft, setPortDraft] = useState('');
  /** 端口不合法时的提示。与草稿一起在提交时判定，输入过程中清掉 */
  const [portError, setPortError] = useState<string | null>(null);
  /*
   * 更新状态留在本窗口，不放主进程 —— 一次请求最多十秒就回来了，没有要跨窗口重连的
   * 进度可言。（上一版把状态放主进程，是因为下载要跑几分钟、关掉窗口再打开得能接回进度。）
   */
  const [update, setUpdate] = useState<UpdateState>({phase: 'idle'});
  const [resetOpen, setResetOpen] = useState(false);
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
    // 草稿不合法就退回已保存的值，并说明原因 —— 静默改写会让用户以为自己改成功了
    if (!isValidPort(parsed)) {
      setPortError(t('settings.portInvalid', {min: MIN_PORT, max: MAX_PORT}));
      setPortDraft(String(settings.proxy.port));
      return;
    }

    setPortError(null);
    if (parsed === settings.proxy.port) return;

    commit({...settings, proxy: {port: parsed}});
  };

  const handleReset = (): void => {
    // 恢复默认同样要占一个序号，否则在途的保存响应回来会把默认值又改回去
    requestSeq.current += 1;
    setPortError(null);
    void window.api.resetSettings().then((restored) => {
      setSettings(restored);
      setPortDraft(String(restored.proxy.port));
    });
  };

  const handleUpdate = (): void => {
    // 有新版本时按钮已经换成「打开官网更新」，这里只负责打开官网
    if (update.phase === 'available') {
      void window.api.openUpdateSite();
      return;
    }

    setUpdate({phase: 'checking'});
    void window.api.checkForUpdates().then(setUpdate);
  };

  if (!settings) {
    return (
      <div className={styles.loading}>
        <Spinner size={32} label={t('common.loading')} />
      </div>
    );
  }

  /*
   * 选项在组件里现算，不放模块级常量：模块级只在加载时求值一次，
   * 存下来的文案会永远停在启动时的语言上（项目里四处注释都强调过这条）。
   * 显式标注类型是为了让 Select 的泛型推成窄联合类型而不是 string，
   * onChange 拿到手就是 AppSettings['language']，不需要类型守卫或断言。
   */
  const languageOptions: SelectOption<AppSettings['language']>[] = SUPPORTED_LANGUAGES.map(
    (code) => ({value: code, label: t(`languages.${code}`)})
  );

  const themeOptions: SelectOption<AppSettings['theme']>[] = [
    {value: 'auto', label: t('settings.themeOptions.auto')},
    {value: 'light', label: t('settings.themeOptions.light')},
    {value: 'dark', label: t('settings.themeOptions.dark')}
  ];

  const updateHint = (): string => {
    switch (update.phase) {
      case 'idle':
        return '';
      case 'checking':
        return t('settings.update.checking');
      case 'up-to-date':
        return t('settings.update.upToDate');
      case 'available':
        return t('settings.update.available', {version: update.version});
      case 'failed':
        return t(failureKey(update.reason));
    }
  };

  /** 只有「有新版本」时按钮才换标签；其余状态一律回到「检查更新」，好让用户能再查一次 */
  const updateButtonLabel = (): string =>
    update.phase === 'available' ? t('settings.update.openSite') : t('settings.update.check');

  const hint = updateHint();

  return (
    <div className={styles.window}>
      <div className={styles.header}>
        <h1>{t('settings.title')}</h1>
      </div>

      <div className={styles.content}>
        <section className={styles.section}>
          <h2>{t('settings.general')}</h2>

          <FormField label={t('settings.language')} htmlFor="setting-language">
            <Select
              id="setting-language"
              className={styles.formControl}
              options={languageOptions}
              value={settings.language}
              onChange={(language) => commit({...settings, language})}
            />
          </FormField>

          <FormField label={t('settings.theme')} htmlFor="setting-theme">
            <Select
              id="setting-theme"
              className={styles.formControl}
              options={themeOptions}
              value={settings.theme}
              onChange={(theme) => commit({...settings, theme})}
            />
          </FormField>

          <FormField label={t('settings.port')} htmlFor="setting-port" error={portError}>
            <Input
              id="setting-port"
              className={styles.formControl}
              type="number"
              min={MIN_PORT}
              max={MAX_PORT}
              value={portDraft}
              onChange={(event) => {
                setPortDraft(event.target.value);
                // 用户一开始改就把上一次的报错收掉，别让红字挂在那儿
                setPortError(null);
              }}
              onBlur={commitPort}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitPort();
              }}
            />
          </FormField>
        </section>

        <section className={styles.section}>
          <h2>{t('settings.about')}</h2>

          <FormField label={t('settings.version')}>
            <span className={styles.value}>{version || '—'}</span>
          </FormField>

          <FormField label={t('settings.update.title')}>
            <div className={styles.updateRow}>
              {/* 必须条件渲染：.updateRow 有 gap，空的 span 照样占一个间距，按钮会莫名左移 */}
              {hint && <span className={styles.hint}>{hint}</span>}
              <Button loading={update.phase === 'checking'} onClick={handleUpdate}>
                {updateButtonLabel()}
              </Button>
            </div>
          </FormField>
        </section>
      </div>

      <div className={styles.footer}>
        <Button onClick={() => setResetOpen(true)}>{t('settings.reset')}</Button>
        <Button onClick={() => window.close()}>{t('settings.close')}</Button>
      </div>

      {resetOpen && (
        <Dialog
          title={t('settings.reset')}
          className={styles.confirm}
          onClose={() => setResetOpen(false)}
          footer={
            <>
              <Button
                variant="filled"
                onClick={() => {
                  setResetOpen(false);
                  handleReset();
                }}
              >
                {t('settings.reset')}
              </Button>
              <Button onClick={() => setResetOpen(false)}>{t('common.cancel')}</Button>
            </>
          }
        >
          <p className={styles.confirmText}>{t('settings.resetConfirm')}</p>
        </Dialog>
      )}
    </div>
  );
};
