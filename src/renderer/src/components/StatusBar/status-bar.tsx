import React from 'react';
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

  const transferred = shown.reduce((sum, flow) => sum + flow.responseBytes, 0);
  const first = shown.reduce((min, flow) => Math.min(min, flow.startedAt), Infinity);
  const last = shown.reduce((max, flow) => Math.max(max, flow.startedAt + flow.durationMs), 0);
  const finish = shown.length > 0 ? formatDuration(last - first) : '—';

  return (
    <div className={styles.statusBar} role="status">
      <span className={status.running ? `${styles.dot} ${styles.dotOn}` : styles.dot} />
      <span>{status.running ? `127.0.0.1:${status.port}` : '未在抓包'}</span>
      <span>
        {shown.length === total ? `${shown.length} 个请求` : `${shown.length} / ${total} 个请求`}
      </span>
      <span>已传输 {formatBytes(transferred)}</span>
      <span>完成 {finish}</span>
      <span className={styles.spacer} />
      <span>{ca?.trust === 'trusted' ? 'HTTPS 解密:已启用' : 'HTTPS 解密:不可用'}</span>
    </div>
  );
};
