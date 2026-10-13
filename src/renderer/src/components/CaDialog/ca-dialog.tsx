import React, {useEffect, useRef, useState} from 'react';
import styles from './ca-dialog.module.css';
import {Button} from '@/components/Button';
import type {CaResult, CaStatus} from '@shared/types';

interface CaDialogProps {
  ca: CaStatus | null;
  onChange: (ca: CaStatus) => void;
  onClose: () => void;
}

const TRUST_TEXT: Record<CaStatus['trust'], string> = {
  trusted: '已安装并受信任，HTTPS 解密可用',
  installed: '已在证书库中，但未被信任。请在钥匙串中把它设为「始终信任」',
  'not-installed': '尚未安装到系统信任库',
  unsupported: '当前平台不支持自动安装，请导出证书后手动安装'
};

const formatDate = (timestamp: number): string => new Date(timestamp).toLocaleDateString();

export const CaDialog = (props: CaDialogProps): React.ReactElement => {
  const { ca, onChange, onClose } = props;

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
      <h2 id="ca-title">CA 根证书</h2>

      {ca ? (
        <dl className={styles.info}>
          <dt>名称</dt>
          <dd>{ca.commonName}</dd>
          <dt>指纹 (SHA-256)</dt>
          <dd>{ca.fingerprint256}</dd>
          <dt>有效期至</dt>
          <dd>{formatDate(ca.notAfter)}</dd>
          <dt>状态</dt>
          <dd className={ca.trust === 'trusted' ? styles.ok : styles.warn}>
            {TRUST_TEXT[ca.trust]}
          </dd>
        </dl>
      ) : (
        <p>正在读取证书信息…</p>
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
          {busy ? '处理中…' : '安装并信任'}
        </Button>
        <Button
          disabled={busy || !ca || ca.trust === 'not-installed' || ca.trust === 'unsupported'}
          onClick={() => run(() => window.api.uninstallCa())}
        >
          从系统移除
        </Button>
        <Button disabled={busy} onClick={() => run(() => window.api.revealCa())}>
          在文件夹中显示
        </Button>
        <Button onClick={() => dialogRef.current?.close()}>关闭</Button>
      </div>
    </dialog>
  );
};
