import React, {useMemo, useState} from 'react';
import {useTranslation} from 'react-i18next';
import styles from './body-panel.module.css';
import {Button} from '@/components/Button';
import type {BodyData} from '@shared/types';
import {type BodyView, describeBody} from '@/lib/body';
import {formatBytes} from '@/lib/format';
import {ClampBlock, ClampText} from '@/components/ClampText';
import {JsonTree} from '@/components/JsonTree';
import {XmlTree} from '@/components/XmlTree';

interface BodyPanelProps {
  body: BodyData | null;
  mime: string | null;
  /** preview 按数据格式渲染（JSON 树、表单表格、HTML 页面等），raw 永远是原文 */
  mode: 'preview' | 'raw';
  emptyText: string;
}

/** 原文文本：JSON 在 Response 里也保留原样，不擅自改写 */
const rawTextOf = (view: BodyView): string | null => {
  switch (view.kind) {
    case 'json':
    case 'html':
    case 'xml':
    case 'form':
    case 'text':
      return view.raw;
    default:
      return null;
  }
};

const FormTable = (props: { pairs: [string, string][] }): React.ReactElement => {
  const { pairs } = props;
  const { t } = useTranslation();

  return (
    <dl className={styles.list}>
      {pairs.length === 0 && <p className={styles.empty}>{t('body.noParams')}</p>}
      {pairs.map(([key, value], index) => (
        <div key={`${key}-${index}`} className={styles.row}>
          <dt>{key}:</dt>
          <dd>
            {value === '' ? (
              <span className={styles.nullValue}>{t('body.emptyValue')}</span>
            ) : (
              <ClampText text={value} />
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
};

export const BodyPanel = (props: BodyPanelProps): React.ReactElement => {
  const { body, mime, mode, emptyText } = props;
  const { t } = useTranslation();

  const view = useMemo(() => describeBody(body, mime), [body, mime]);
  const [copied, setCopied] = useState(false);

  if (view.kind === 'empty') return <p className={styles.empty}>{emptyText}</p>;

  const notes: string[] = [];
  if (body?.truncated) {
    notes.push(
      t('body.truncated', {
        kept: formatBytes(body.bytes.length),
        total: formatBytes(body.size)
      })
    );
  }
  if (body?.decodeError) notes.push(body.decodeError);
  // view.clipped 不再显示提示，因为用户默认看到的就是收起状态，点"显示全部"才展开

  const copyText = view.kind === 'json' ? view.pretty : rawTextOf(view);
  const copy = async (text: string): Promise<void> => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const renderPreview = (): React.ReactElement => {
    switch (view.kind) {
      case 'json':
        return <JsonTree value={view.value} />;
      case 'xml':
        return <XmlTree raw={view.raw} />;
      case 'form':
        return <FormTable pairs={view.pairs} />;
      case 'html':
        // 空 sandbox：不执行脚本、不带同源权限，只做静态渲染，行为与 Chrome 的 Preview 一致。
        // 页面的 CSP 也会限制外链资源，所以带外部图片或样式的页面可能显示不全
        return (
          <iframe
            className={styles.frame}
            title={t('body.htmlPreview')}
            sandbox=""
            srcDoc={view.raw}
          />
        );
      case 'image':
        return <img className={styles.img} src={view.dataUrl} alt={t('body.imagePreview')} />;
      case 'binary':
        return <pre className={styles.code}>{view.hex}</pre>;
      default:
        return <ClampBlock text={view.raw} />;
    }
  };

  const renderRaw = (): React.ReactElement => {
    if (view.kind === 'image') {
      return <img className={styles.img} src={view.dataUrl} alt={t('body.imagePreview')} />;
    }
    if (view.kind === 'binary') return <pre className={styles.code}>{view.hex}</pre>;
    return <ClampBlock text={rawTextOf(view) ?? ''} />;
  };

  return (
    <div className={styles.root}>
      {notes.length > 0 && <p className={styles.note}>{notes.join(t('common.semicolon'))}</p>}
      {copyText !== null && (
        <Button size="sm" className={styles.copy} onClick={() => void copy(copyText)}>
          {copied
            ? t('body.copied')
            : mode === 'preview' && view.kind === 'json'
              ? t('body.copyPrettyJson')
              : t('body.copy')}
        </Button>
      )}
      {mode === 'preview' ? renderPreview() : renderRaw()}
    </div>
  );
};
