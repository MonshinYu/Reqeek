import React, {useEffect, useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import styles from './ca-dialog.module.css';
import {Button} from '@/components/Button';
import type {CaResult, CaStatus} from '@shared/types';

interface CaDialogProps {
  ca: CaStatus | null;
  onChange: (ca: CaStatus) => void;
  onClose: () => void;
}

/* 存 key 而不是文案：模块级常量只在加载时求值一次，存文案就会停在启动时的语言上 */
const TRUST_KEY: Record<CaStatus['trust'], string> = {
  trusted: 'ca.trust.trusted',
  installed: 'ca.trust.installed',
  'not-installed': 'ca.trust.notInstalled',
  unsupported: 'ca.trust.unsupported'
};

const formatDate = (timestamp: number): string => new Date(timestamp).toLocaleDateString();

export const CaDialog = (props: CaDialogProps): React.ReactElement => {
  const { ca, onChange, onClose } = props;
  const { t } = useTranslation();

  const dialogRef = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

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

  return (
    <dialog ref={dialogRef} className={styles.dialog} aria-labelledby="ca-title" onClose={onClose}>
      <h2 id="ca-title">{t('ca.dialogTitle')}</h2>

      {ca ? (
        <dl className={styles.info}>
          <dt>{t('ca.field.name')}</dt>
          <dd>{ca.commonName}</dd>
          <dt>{t('ca.field.fingerprint')}</dt>
          <dd>{ca.fingerprint256}</dd>
          <dt>{t('ca.field.expires')}</dt>
          <dd>{formatDate(ca.notAfter)}</dd>
          <dt>{t('ca.field.status')}</dt>
          <dd className={ca.trust === 'trusted' ? styles.ok : styles.warn}>
            {t(TRUST_KEY[ca.trust])}
          </dd>
        </dl>
      ) : (
        <p>{t('ca.reading')}</p>
      )}

      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}

      <div className={styles.actions}>
        <Button
          variant="filled"
          disabled={busy || !ca || ca.trust === 'trusted' || ca.trust === 'unsupported'}
          onClick={() => run(() => window.api.installCa())}
        >
          {busy ? t('ca.actions.busy') : t('ca.actions.install')}
        </Button>
        <Button
          disabled={busy || !ca || ca.trust === 'not-installed' || ca.trust === 'unsupported'}
          onClick={() => run(() => window.api.uninstallCa())}
        >
          {t('ca.actions.uninstall')}
        </Button>
        <Button disabled={busy} onClick={() => run(() => window.api.revealCa())}>
          {t('ca.actions.revealShort')}
        </Button>
        <Button onClick={() => dialogRef.current?.close()}>{t('ca.actions.close')}</Button>
      </div>
    </dialog>
  );
};
