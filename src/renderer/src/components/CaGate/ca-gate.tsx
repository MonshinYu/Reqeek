import React, {useState} from 'react';
import {useTranslation} from 'react-i18next';
import styles from './ca-gate.module.css';
import {Button} from '@/components/Button';
import type {CaResult, CaStatus} from '@shared/types';

interface CaGateProps {
  ca: CaStatus | null;
  platform: string;
  onChange: (ca: CaStatus) => void;
}

/* 这两张表存 key 而不是文案：模块级常量只在加载时求值一次，存文案就会停在启动时的语言上 */
const STEP_STATE_KEY: Record<CaStatus['trust'], string> = {
  trusted: 'ca.stepState.trusted',
  installed: 'ca.stepState.installed',
  'not-installed': 'ca.stepState.notInstalled',
  unsupported: 'ca.stepState.unsupported'
};

const INSTALL_HINT_KEY: Record<string, string> = {
  darwin: 'ca.hint.darwin',
  win32: 'ca.hint.win32',
  linux: 'ca.hint.linux'
};

/**
 * 首次使用引导：根证书不是 trusted 时占满主界面。
 * 没有受信任的根证书，HTTPS 全部只能走隧道，抓到的只有域名，所以不放行进入主界面。
 */
export const CaGate = (props: CaGateProps): React.ReactElement => {
  const { ca, platform, onChange } = props;
  const { t } = useTranslation();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (task: () => Promise<CaResult<CaStatus | void>>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await task();
      if (!result.ok) setError(result.error);
      else if (result.value) onChange(result.value);
    } finally {
      setBusy(false);
    }
  };

  const canAutoInstall = ca !== null && ca.trust !== 'unsupported';
  // 产品名走语言包而不是散在各处硬编码，改名时只动一处
  const appName = t('app.name');

  return (
    <main className={styles.gate}>
      <h1>{t('ca.gateTitle', { name: appName })}</h1>
      <p className={styles.lead}>{t('ca.gateLead', { name: appName })}</p>

      <ol className={styles.steps}>
        <li data-done={ca !== null}>
          <strong>{t('ca.step.generate')}</strong>
          <span>{ca ? ca.commonName : t('ca.generating')}</span>
        </li>
        <li data-done={ca?.trust === 'trusted'}>
          <strong>{t('ca.step.install')}</strong>
          <span>{ca ? t(STEP_STATE_KEY[ca.trust]) : t('ca.waitingGenerate')}</span>
        </li>
        <li data-done={ca?.trust === 'trusted'}>
          <strong>{t('ca.step.verify')}</strong>
          <span>{t('ca.autoEnter')}</span>
        </li>
      </ol>

      {ca?.trust === 'installed' && (
        <p className={styles.warn}>{t('ca.installedWarning', { name: ca.commonName })}</p>
      )}
      <p className={styles.hint}>
        {t(INSTALL_HINT_KEY[platform] ?? INSTALL_HINT_KEY.linux)}
      </p>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}

      <div className={styles.actions}>
        {canAutoInstall && (
          <Button
            variant="filled"
            disabled={busy}
            onClick={() => void run(() => window.api.installCa())}
          >
            {busy ? t('ca.actions.busy') : t('ca.actions.install')}
          </Button>
        )}
        <Button disabled={busy} onClick={() => void run(() => window.api.getCaStatus())}>
          {t('ca.actions.recheck')}
        </Button>
        <Button disabled={busy} onClick={() => void run(() => window.api.revealCa())}>
          {t('ca.actions.reveal')}
        </Button>
      </div>
    </main>
  );
};
