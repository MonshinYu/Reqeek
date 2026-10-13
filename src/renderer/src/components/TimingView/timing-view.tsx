import React from 'react';
import styles from './timing-view.module.css';
import type {Flow} from '@shared/types';
import {formatBytes, formatDuration, formatTime} from '@/lib/format';

/** 代理侧能测到的阶段只有：发出到收到响应头（TTFB）、收到响应头到结束（下载） */
export const TimingView = (props: { flow: Flow }): React.ReactElement => {
  const { flow } = props;

  const total = Math.max(1, flow.durationMs);
  const ttfb = flow.ttfbMs === null ? null : Math.min(flow.ttfbMs, total);
  const download = ttfb === null ? 0 : total - ttfb;

  const rows: [string, number | null, string][] = [
    ['等待服务器响应 (TTFB)', ttfb, styles.wait],
    ['内容下载', ttfb === null ? null : download, styles.download]
  ];

  return (
    <div>
      <p className={styles.meta}>开始于 {formatTime(flow.startedAt)}</p>
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
          <dt>总计</dt>
          <dd>{formatDuration(flow.durationMs)}</dd>
        </div>
        <div className={styles.row}>
          <dt>传输</dt>
          <dd>
            ↑ {formatBytes(flow.requestBytes)} / ↓ {formatBytes(flow.responseBytes)}
          </dd>
        </div>
      </dl>
    </div>
  );
};
