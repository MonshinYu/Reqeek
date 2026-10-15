import React from 'react';
import {useTranslation} from 'react-i18next';
import styles from './timing-view.module.css';
import type {Flow} from '@shared/types';
import {formatBytes, formatDuration, formatTime} from '@/lib/format';

/** 代理侧能测到的阶段只有：发出到收到响应头（TTFB）、收到响应头到结束（下载） */
export const TimingView = (props: { flow: Flow }): React.ReactElement => {
  const { flow } = props;
  const { t } = useTranslation();

  const total = Math.max(1, flow.durationMs);
  const ttfb = flow.ttfbMs === null ? null : Math.min(flow.ttfbMs, total);
  const download = ttfb === null ? 0 : total - ttfb;

  const rows: [string, number | null, string][] = [
    [t('timing.ttfb'), ttfb, styles.wait],
    [t('timing.download'), ttfb === null ? null : download, styles.download]
  ];

  return (
    <div>
      <p className={styles.meta}>{t('timing.startedAt', { time: formatTime(flow.startedAt) })}</p>
      <dl className={styles.list}>
        {rows.map(([label, value, tone]) => (
          <div key={label} className={`${styles.row} ${styles.timingRow}`}>
            <dt>{label}</dt>
            <dd>
              <span className={styles.bar}>
                <span
                  className={`${styles.fill} ${tone}`}
                  style={{ width: `${((value ?? 0) / total) * 100}%` }}
                />
              </span>
              {value === null ? '—' : formatDuration(value)}
            </dd>
          </div>
        ))}
        <div className={styles.row}>
          <dt>{t('timing.total')}</dt>
          <dd>{formatDuration(flow.durationMs)}</dd>
        </div>
        <div className={styles.row}>
          <dt>{t('timing.transferred')}</dt>
          <dd>
            ↑ {formatBytes(flow.requestBytes)} / ↓ {formatBytes(flow.responseBytes)}
          </dd>
        </div>
      </dl>
    </div>
  );
};
