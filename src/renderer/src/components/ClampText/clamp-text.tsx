import React, {useState} from 'react';
import {useTranslation} from 'react-i18next';
import styles from './clamp-text.module.css';
import {Button} from '@/components/Button';

/** 单个值（头部值、JSON 字符串、表单值）超过这个长度就截短 */
export const VALUE_LIMIT = 300;
/** 整块原文超过这个长度就截短 */
export const BLOCK_LIMIT = 20_000;

interface ClampTextProps {
  text: string;
  limit?: number;
}

/** 行内文本：超长时只显示开头，点按钮展开或收起 */
export const ClampText = (props: ClampTextProps): React.ReactElement => {
  const { text, limit = VALUE_LIMIT } = props;
  const { t } = useTranslation();

  const [expanded, setExpanded] = useState(false);
  if (text.length <= limit) return <>{text}</>;
  return (
    <>
      {expanded ? text : `${text.slice(0, limit)}…`}
      <button type="button" className={styles.toggle} onClick={() => setExpanded(!expanded)}>
        {expanded ? t('common.collapse') : t('clamp.expand', {count: text.length})}
      </button>
    </>
  );
};

/** 整块原文：超长时只渲染开头，避免几万字符的单个节点撑满面板 */
export const ClampBlock = (props: ClampTextProps): React.ReactElement => {
  const { text, limit = BLOCK_LIMIT } = props;
  const { t } = useTranslation();

  const [expanded, setExpanded] = useState(false);
  const clipped = text.length > limit && !expanded;
  return (
    <>
      <pre className={styles.code}>{clipped ? text.slice(0, limit) : text}</pre>
      {text.length > limit && (
        <Button
          variant="text"
          size="xs"
          className={styles.more}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? t('common.collapse') : t('clamp.showAll', {count: text.length - limit})}
        </Button>
      )}
    </>
  );
};
