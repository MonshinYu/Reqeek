import React from 'react';
import {useTranslation} from 'react-i18next';
import styles from './title-bar.module.css';
import {Button} from '@/components/Button';
import type {ProxyStatus} from '@shared/types';

interface TitleBarProps {
  status: ProxyStatus;
  /** 根证书未受信任、主界面被引导页替代时为 true：录制 / 清空 / 搜索不可用 */
  gated: boolean;
  keyword: string;
  onKeyword: (value: string) => void;
  onClear: () => void;
  onOpenCa: () => void;
  /** 供应用菜单的「搜索请求」聚焦搜索框 */
  searchRef?: React.Ref<HTMLInputElement>;
}

/**
 * 融合进 titlebar 的操作栏：录制 / 清空 / 搜索 / CA。
 * 整条可拖动，按钮和输入框在 CSS 里设为 no-drag；左右留白由 body 上的平台类控制，
 * 避开 macOS 红绿灯和 Windows / Linux 的系统按钮。
 */
export const TitleBar = (props: TitleBarProps): React.ReactElement => {
  const { status, gated, keyword, onKeyword, onClear, onOpenCa, searchRef } = props;
  const { t } = useTranslation();

  return (
    <div className={styles.titleBar} role="toolbar" aria-label={t('titleBar.toolbar')}>
      {status.running ? (
        <button
          type="button"
          className={`${styles.iconButton} ${styles.stop}`}
          title={t('titleBar.stopCapture')}
          aria-label={t('titleBar.stopCapture')}
          onClick={() => window.api.stopServer()}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" />
          </svg>
        </button>
      ) : (
        <button
          type="button"
          className={`${styles.iconButton} ${styles.record}`}
          title={gated ? t('titleBar.caRequired') : t('titleBar.startCapture')}
          aria-label={t('titleBar.startCapture')}
          disabled={gated}
          onClick={() => window.api.startServer()}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <circle cx="8" cy="8" r="5" fill="currentColor" />
          </svg>
        </button>
      )}
      <button
        type="button"
        className={styles.iconButton}
        title={t('titleBar.clear')}
        aria-label={t('titleBar.clearRecords')}
        disabled={gated}
        onClick={onClear}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M4.5 11.5l7-7" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </button>
      <input
        ref={searchRef}
        className={styles.search}
        type="search"
        placeholder={t('titleBar.searchPlaceholder')}
        aria-label={t('titleBar.searchRequests')}
        disabled={gated}
        value={keyword}
        onChange={(event) => onKeyword(event.target.value)}
      />
      <span className={styles.spacer} />
      {status.error && (
        <span className={styles.error} title={status.error}>
          {status.error}
        </span>
      )}
      <Button size="small" onClick={onOpenCa}>
        {t('titleBar.ca')}
      </Button>
    </div>
  );
};
