import React, {useState} from 'react';
import styles from './ca-gate.module.css';
import {Button} from '@/components/Button';
import type {CaResult, CaStatus} from '@shared/types';

interface CaGateProps {
  ca: CaStatus | null;
  platform: string;
  onChange: (ca: CaStatus) => void;
}

const STEP_STATE: Record<CaStatus['trust'], string> = {
  trusted: '已安装并受信任',
  installed: '已在证书库中，但还没有被信任',
  'not-installed': '尚未安装',
  unsupported: '当前系统不支持自动安装'
};

const INSTALL_HINT: Record<string, string> = {
  darwin: '点击后系统会弹出钥匙串授权，输入登录密码或使用 Touch ID 即可。',
  win32: '点击后系统会弹出证书安装确认框，选择「是」。',
  linux: '请先导出证书，按你的发行版方式加入系统信任库，再点击「重新检测」。'
};

/**
 * 首次使用引导：根证书不是 trusted 时占满主界面。
 * 没有受信任的根证书，HTTPS 全部只能走隧道，抓到的只有域名，所以不放行进入主界面。
 */
export const CaGate = (props: CaGateProps): React.ReactElement => {
  const { ca, platform, onChange } = props;

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

  return (
    <main className={styles.gate}>
      <h1>先安装 Reqeek 根证书</h1>
      <p className={styles.lead}>
        抓取 HTTPS 内容需要在本机信任 Reqeek 的根证书。证书和私钥只保存在这台电脑上。
      </p>

      <ol className={styles.steps}>
        <li data-done={ca !== null}>
          <strong>1. 生成证书</strong>
          <span>{ca ? ca.commonName : '正在生成…'}</span>
        </li>
        <li data-done={ca?.trust === 'trusted'}>
          <strong>2. 安装并信任</strong>
          <span>{ca ? STEP_STATE[ca.trust] : '等待证书生成'}</span>
        </li>
        <li data-done={ca?.trust === 'trusted'}>
          <strong>3. 验证</strong>
          <span>安装完成后会自动进入主界面</span>
        </li>
      </ol>

      {ca?.trust === 'installed' && (
        <p className={styles.warn}>
          证书已导入但没有被信任。请打开「钥匙串访问」，找到 {ca.commonName}
          ，把信任设置为「始终信任」， 然后点击「重新检测」。
        </p>
      )}
      <p className={styles.hint}>{INSTALL_HINT[platform] ?? INSTALL_HINT.linux}</p>
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
            {busy ? '处理中…' : '安装并信任'}
          </Button>
        )}
        <Button disabled={busy} onClick={() => void run(() => window.api.getCaStatus())}>
          重新检测
        </Button>
        <Button disabled={busy} onClick={() => void run(() => window.api.revealCa())}>
          在文件夹中显示证书
        </Button>
      </div>
    </main>
  );
};
