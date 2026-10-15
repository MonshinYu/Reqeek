import React, {useState} from 'react';
import {useTranslation} from 'react-i18next';
import styles from './json-tree.module.css';
import {ClampText} from '@/components/ClampText';

/** 单个容器一次最多渲染的子项数，更多的点按钮再展开，避免几万项的数组卡死渲染 */
const PAGE_SIZE = 100;

type Entry = [string, unknown];

const isContainer = (value: unknown): value is object =>
  typeof value === 'object' && value !== null;

const sizeOf = (value: object): number =>
  Array.isArray(value) ? value.length : Object.keys(value).length;

/** 只取前 limit 项，大数组不会为了显示 100 项而把整个数组映射一遍 */
const entriesOf = (value: object, limit: number): Entry[] =>
  Array.isArray(value)
    ? value.slice(0, limit).map((item, index): Entry => [String(index), item])
    : Object.entries(value).slice(0, limit);

/** 折叠时的一行摘要：数组显示长度，对象显示前几个键名 */
const summaryOf = (value: object): string => {
  if (Array.isArray(value)) return `Array(${value.length})`;
  const keys = Object.keys(value);
  return `{${keys.slice(0, 5).join(', ')}${keys.length > 5 ? ', …' : ''}}`;
};

const Primitive = (props: { value: unknown }): React.ReactElement => {
  const { value } = props;

  if (value === null) return <span className={styles.nullValue}>null</span>;
  if (typeof value === 'string')
    return (
      <span className={styles.string}>
        <ClampText text={JSON.stringify(value)} />
      </span>
    );
  if (typeof value === 'number') return <span className={styles.number}>{String(value)}</span>;
  return <span className={styles.bool}>{String(value)}</span>;
};

interface JsonNodeProps {
  name: string | null;
  value: unknown;
  depth: number;
}

const JsonNode = (props: JsonNodeProps): React.ReactElement => {
  const { name, value, depth } = props;
  const { t } = useTranslation();

  // 与 Chrome 一致：根节点展开一层，其余默认折叠
  const [open, setOpen] = useState(depth === 0);
  const [shown, setShown] = useState(PAGE_SIZE);

  const label =
    name === null ? null : (
      <>
        <span className={styles.key}>{name}</span>
        <span className={styles.colon}>: </span>
      </>
    );

  if (!isContainer(value)) {
    return (
      <div className={styles.leaf}>
        {label}
        <Primitive value={value} />
      </div>
    );
  }

  const total = sizeOf(value);
  return (
    <div className={styles.node}>
      <button
        type="button"
        className={styles.toggle}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className={styles.arrow} aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        {label}
        <span className={styles.summary}>
          {open ? (Array.isArray(value) ? `Array(${total})` : 'Object') : summaryOf(value)}
        </span>
      </button>
      {open && (
        <div className={styles.children}>
          {entriesOf(value, shown).map(([key, child]) => (
            <JsonNode key={key} name={key} value={child} depth={depth + 1} />
          ))}
          {total > shown && (
            <button
              type="button"
              className={styles.more}
              onClick={() => setShown(shown + PAGE_SIZE)}
            >
              {t('tree.showMore', {count: total - shown})}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

/** JSON 的可折叠树，对应 Chrome Network 的 Preview */
export const JsonTree = (props: { value: unknown }): React.ReactElement => {
  const { value } = props;

  return (
    <div className={styles.root}>
      <JsonNode name={null} value={value} depth={0} />
    </div>
  );
};
