import React from 'react';
import {useTranslation} from 'react-i18next';
import type {CaStatus, Flow, ProxyStatus} from '@shared/types';
import {formatBytes, formatDuration} from '@/lib/format';
import styles from './status-bar.module.css';

interface StatusBarProps {
  status: ProxyStatus;
  shown: Flow[];
  total: number;
  ca: CaStatus | null;
}

/** Chrome Network 底部汇总:请求数 | 已传输 | 完成时间 */
export const StatusBar = (props: StatusBarProps): React.ReactElement => {
  const { status, shown, total, ca } = props;
  const { t } = useTranslation();

  const transferred = shown.reduce((sum, flow) => sum + flow.responseBytes, 0);
  const first = shown.reduce((min, flow) => Math.min(min, flow.startedAt), Infinity);
  const last = shown.reduce((max, flow) => Math.max(max, flow.startedAt + flow.durationMs), 0);
  const finish = shown.length > 0 ? formatDuration(last - first) : '—';

  return (
    <div className={styles.statusBar} role="status">
      <span className={status.running ? `${styles.dot} ${styles.dotOn}` : styles.dot} />
      <span>{status.running ? `127.0.0.1:${status.port}` : t('status.idle')}</span>
      <span>
        {shown.length === total
          ? t('status.requestCount', { count: shown.length })
          : t('status.shownOfTotal', { shown: shown.length, total })}
      </span>
      <span>{t('status.transferred', { size: formatBytes(transferred) })}</span>
      <span>{t('status.finished', { time: finish })}</span>
      <span className={styles.spacer} />
      <span>{t(ca?.trust === 'trusted' ? 'status.httpsOn' : 'status.httpsOff')}</span>
    </div>
  );
};
