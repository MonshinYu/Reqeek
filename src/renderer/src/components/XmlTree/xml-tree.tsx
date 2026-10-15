import React, {useMemo, useState} from 'react';
import {useTranslation} from 'react-i18next';
import styles from './xml-tree.module.css';

const PAGE_SIZE = 200;

/** 解析失败（含 parsererror 文档）返回 null，调用方退回纯文本 */
const parseXml = (raw: string): Document | null => {
  const doc = new DOMParser().parseFromString(raw, 'application/xml');
  return doc.querySelector('parsererror') ? null : doc;
};

/** 只保留有意义的子节点：元素、非空白文本、CDATA，丢掉缩进用的空白 */
const meaningfulChildren = (element: Element): ChildNode[] =>
  Array.from(element.childNodes).filter(
    (node) =>
      node.nodeType === Node.ELEMENT_NODE ||
      node.nodeType === Node.CDATA_SECTION_NODE ||
      (node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '')
  );

const OpenTag = (props: { element: Element }): React.ReactElement => {
  const { element } = props;

  return (
    <>
      <span className={styles.punct}>&lt;</span>
      <span className={styles.tag}>{element.tagName}</span>
      {Array.from(element.attributes).map((attribute) => (
        <span key={attribute.name}>
          {' '}
          <span className={styles.attr}>{attribute.name}</span>
          <span className={styles.punct}>=</span>
          <span className={styles.value}>{JSON.stringify(attribute.value)}</span>
        </span>
      ))}
    </>
  );
};

const CloseTag = (props: { element: Element }): React.ReactElement => {
  const { element } = props;

  return (
    <>
      <span className={styles.punct}>&lt;/</span>
      <span className={styles.tag}>{element.tagName}</span>
      <span className={styles.punct}>&gt;</span>
    </>
  );
};

const XmlNode = (props: { element: Element; depth: number }): React.ReactElement => {
  const { element, depth } = props;
  const { t } = useTranslation();

  const [open, setOpen] = useState(depth < 2);
  const [shown, setShown] = useState(PAGE_SIZE);
  const children = meaningfulChildren(element);

  if (children.length === 0) {
    return (
      <div className={styles.leaf}>
        <OpenTag element={element} />
        <span className={styles.punct}>{' />'}</span>
      </div>
    );
  }

  // 只有一段文本的元素写成一行：<name>text</name>
  if (children.length === 1 && children[0].nodeType !== Node.ELEMENT_NODE) {
    return (
      <div className={styles.leaf}>
        <OpenTag element={element} />
        <span className={styles.punct}>&gt;</span>
        <span className={styles.text}>{children[0].textContent?.trim()}</span>
        <CloseTag element={element} />
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        className={styles.toggle}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className={styles.arrow} aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <OpenTag element={element} />
        <span className={styles.punct}>&gt;</span>
        {!open && (
          <>
            <span className={styles.summary}>…</span>
            <CloseTag element={element} />
          </>
        )}
      </button>
      {open && (
        <>
          <div className={styles.children}>
            {children.slice(0, shown).map((child, index) =>
              child.nodeType === Node.ELEMENT_NODE ? (
                <XmlNode key={index} element={child as Element} depth={depth + 1} />
              ) : (
                <div key={index} className={styles.text}>
                  {child.textContent?.trim()}
                </div>
              )
            )}
            {children.length > shown && (
              <button
                type="button"
                className={styles.more}
                onClick={() => setShown(shown + PAGE_SIZE)}
              >
                {t('tree.showMore', {count: children.length - shown})}
              </button>
            )}
          </div>
          <div className={styles.close}>
            <CloseTag element={element} />
          </div>
        </>
      )}
    </div>
  );
};

/** XML 的可折叠树；不是合法 XML 时显示原文并说明 */
export const XmlTree = (props: { raw: string }): React.ReactElement => {
  const { raw } = props;
  const { t } = useTranslation();

  const doc = useMemo(() => parseXml(raw), [raw]);
  if (!doc?.documentElement) {
    return (
      <>
        <p className={styles.note}>{t('tree.invalidXml')}</p>
        <pre className={styles.code}>{raw}</pre>
      </>
    );
  }
  return (
    <div className={styles.root}>
      <XmlNode element={doc.documentElement} depth={0} />
    </div>
  );
};
