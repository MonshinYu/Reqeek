import React from 'react';
import {useTranslation} from 'react-i18next';
import styles from './title-bar.module.css';
import {Button} from '@/components/Button';
import {IconButton} from '@/components/IconButton';
import {Input} from '@/components/Input';
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
  searchRef?: React.RefObject<HTMLInputElement | null>;
}

/**
 * 融合进 titlebar 的操作栏：录制 / 清空 / 搜索 / CA。
 * 整条可拖动，内部控件各自声明 no-drag；左右留白由 body 上的平台类控制，
 * 避开 macOS 红绿灯和 Windows / Linux 的系统按钮。
 */
export const TitleBar = (props: TitleBarProps): React.ReactElement => {
  const { status, gated, keyword, onKeyword, onClear, onOpenCa, searchRef } = props;
  const { t } = useTranslation();

  /** 清空后把焦点交回输入框：不然点完清空要点第二次才能接着打字 */
  const clearKeyword = (): void => {
    onKeyword('');
    searchRef?.current?.focus();
  };

  return (
    <div className={styles.titleBar} role="toolbar" aria-label={t('titleBar.toolbar')}>
      {status.running ? (
        <IconButton
          icon="stop"
          tone="strong"
          label={t('titleBar.stopCapture')}
          onClick={() => window.api.stopServer()}
        />
      ) : (
        <IconButton
          icon="record"
          tone="danger"
          label={t('titleBar.startCapture')}
          // 未受信任时换成"先去装证书"，比只说"开始录制"有用
          title={gated ? t('titleBar.caRequired') : t('titleBar.startCapture')}
          disabled={gated}
          onClick={() => window.api.startServer()}
        />
      )}

      <IconButton
        icon="clear"
        label={t('titleBar.clearRecords')}
        title={t('titleBar.clear')}
        disabled={gated}
        onClick={onClear}
      />

      <Input
        ref={searchRef}
        className={styles.search}
        size="sm"
        type="search"
        placeholder={t('titleBar.searchPlaceholder')}
        aria-label={t('titleBar.searchRequests')}
        disabled={gated}
        value={keyword}
        onChange={(event) => onKeyword(event.target.value)}
        // 自绘清空按钮顶掉 Chromium 原生那个：后者三平台外观不一，也没法跟着主题走
        suffix={
          keyword ? (
            <IconButton
              icon="close"
              size="xs"
              label={t('titleBar.clearSearch')}
              onClick={clearKeyword}
            />
          ) : undefined
        }
      />

      <span className={styles.spacer} />

      {status.error && (
        <span className={styles.error} title={status.error}>
          {status.error}
        </span>
      )}

      <Button size="sm" onClick={onOpenCa}>
        {t('titleBar.ca')}
      </Button>
    </div>
  );
};
