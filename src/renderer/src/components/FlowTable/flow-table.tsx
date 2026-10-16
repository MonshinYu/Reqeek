import React, {useEffect, useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import styles from './flow-table.module.css';
import {Button} from '@/components/Button';
import {Icon} from '@/components/Icon';
import type {FlowGroup} from '@/lib/group';
import {
  flowName,
  flowPath,
  formatBytes,
  formatDuration,
  statusText,
  statusTone,
  typeIcon,
  typeLabel
} from '@/lib/format';
import type {SortKey, SortState} from '@/lib/sort';

const TONE_CLASS: Record<ReturnType<typeof statusTone>, string | undefined> = {
  ok: styles.ok,
  redirect: styles.redirect,
  error: styles.error,
  none: undefined
};

const ROW_HEIGHT = 24;
/** 可视区上下各多渲染几行，滚动时不露白 */
const OVERSCAN = 8;

interface FlowTableProps {
  groups: FlowGroup[];
  selectedId: number | null;
  /** 详情面板打开时收窄成只剩 Name 列，与 Chrome 一致 */
  compact: boolean;
  sort: SortState;
  onSort: (key: SortKey) => void;
  onSelect: (id: number) => void;
  onToggleExpand: (domain: string) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
}

/** 列名存 key 而不是文案：模块级常量只在加载时求值一次，存文案就永远停在启动时的语言上 */
const COLUMNS: { key: SortKey | 'waterfall'; labelKey: string; sortable: boolean }[] = [
  { key: 'name', labelKey: 'table.name', sortable: true },
  { key: 'status', labelKey: 'table.status', sortable: true },
  { key: 'type', labelKey: 'table.type', sortable: true },
  { key: 'size', labelKey: 'table.size', sortable: true },
  { key: 'duration', labelKey: 'table.time', sortable: true },
  { key: 'waterfall', labelKey: 'table.waterfall', sortable: false }
];

/**
 * 固定行高的虚拟列表：支持域名分组展开/折叠
 * 新数据到达且用户停在底部时自动跟随；用户向上翻看时不抢滚动位置。
 */
export const FlowTable = (props: FlowTableProps): React.ReactElement => {
  const {
    groups,
    selectedId,
    compact,
    sort,
    onSort,
    onSelect,
    onToggleExpand,
    onExpandAll,
    onCollapseAll
  } = props;
  const { t } = useTranslation();

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(400);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setViewport(element.clientHeight));
    observer.observe(element);
    setViewport(element.clientHeight);
    return () => observer.disconnect();
  }, []);

  const rows = groups;

  useEffect(() => {
    const element = scrollRef.current;
    if (element && stickToBottom.current) element.scrollTop = element.scrollHeight;
  }, [rows.length]);

  // 瀑布图的时间轴：整张表最早开始到最晚结束
  let origin = Infinity;
  let end = 0;
  for (const row of rows) {
    if (row.type === 'flow') {
      const flow = row.flow;
      if (flow.startedAt < origin) origin = flow.startedAt;
      if (flow.startedAt + flow.durationMs > end) end = flow.startedAt + flow.durationMs;
    }
  }
  const span = Math.max(1, end - origin);

  const onScroll = (event: React.UIEvent<HTMLDivElement>): void => {
    const element = event.currentTarget;
    setScrollTop(element.scrollTop);
    stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 8;
  };

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + OVERSCAN);

  /** 方向键只在请求行之间跳转，跳过域名分组头 */
  const moveSelection = (delta: number): void => {
    const flowIndexes: number[] = [];
    rows.forEach((row, index) => {
      if (row.type === 'flow') flowIndexes.push(index);
    });
    if (flowIndexes.length === 0) return;
    const currentRow = rows.findIndex((row) => row.type === 'flow' && row.flow.id === selectedId);
    const currentPos = flowIndexes.indexOf(currentRow);
    const nextPos = Math.min(
      flowIndexes.length - 1,
      Math.max(0, (currentPos === -1 ? (delta > 0 ? -1 : flowIndexes.length) : currentPos) + delta)
    );
    const nextRow = flowIndexes[nextPos];
    const next = rows[nextRow];
    if (next.type !== 'flow') return;
    onSelect(next.flow.id);
    const element = scrollRef.current;
    if (!element) return;
    const top = nextRow * ROW_HEIGHT;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight) {
      element.scrollTop = top + ROW_HEIGHT - element.clientHeight;
    }
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveSelection(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveSelection(-1);
    }
  };

  const columns = compact ? COLUMNS.slice(0, 1) : COLUMNS;

  return (
    <div
      className={compact ? `${styles.table} ${styles.compact}` : styles.table}
      role="grid"
      aria-label={t('table.requests')}
      aria-rowcount={rows.length}
    >
      <div className={styles.head} role="row">
        {columns.map((column) => {
          const active = sort.key === column.key;
          return (
            <button
              key={column.key}
              type="button"
              role="columnheader"
              className={styles.th}
              disabled={!column.sortable}
              aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
              onClick={() => column.sortable && onSort(column.key as SortKey)}
            >
              {t(column.labelKey)}
              {active && (
                <Icon name={sort.dir === 'asc' ? 'chevron-up' : 'chevron-down'} size={12} />
              )}
            </button>
          );
        })}
      </div>

      <div className={styles.toolbar}>
        <Button variant="text" size="xs" onClick={onExpandAll}>
          {t('table.expandAll')}
        </Button>
        <Button variant="text" size="xs" onClick={onCollapseAll}>
          {t('table.collapseAll')}
        </Button>
      </div>

      <div
        className={styles.scroll}
        ref={scrollRef}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        tabIndex={0}
      >
        <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
          {rows.slice(first, last).map((row, offset) => {
            const index = first + offset;

            if (row.type === 'group') {
              return (
                <div
                  key={row.key}
                  role="row"
                  className={styles.group}
                  style={{ top: index * ROW_HEIGHT }}
                  onClick={() => onToggleExpand(row.domain)}
                >
                  <span
                    className={
                      row.expanded ? `${styles.arrow} ${styles.arrowExpanded}` : styles.arrow
                    }
                  >
                    <Icon name="chevron-right" size={12} />
                  </span>
                  <strong>{row.domain}</strong>
                  <span className={styles.count}>
                    {t('table.groupCount', { count: row.count })}
                  </span>
                </div>
              );
            }

            // flow 行
            const flow = row.flow;
            const left = ((flow.startedAt - origin) / span) * 100;
            const width = Math.max(0.5, (flow.durationMs / span) * 100);

            return (
              <div
                key={row.key}
                role="row"
                aria-selected={flow.id === selectedId}
                className={
                  index % 2 === 1
                    ? `${styles.row} ${styles.odd} ${styles.child}`
                    : `${styles.row} ${styles.child}`
                }
                style={{ top: index * ROW_HEIGHT }}
                onClick={() => onSelect(flow.id)}
              >
                <span className={styles.name} title={flow.url}>
                  <span>{typeIcon(flow)}</span>
                  <span>{flowName(flow)}</span>
                  <span className={styles.sub}>{flow.host}</span>
                </span>
                {!compact && (
                  <>
                    <span className={TONE_CLASS[statusTone(flow)]} title={flow.error ?? undefined}>
                      {statusText(flow)}
                    </span>
                    <span title={typeLabel(flow)}>{typeLabel(flow)}</span>
                    <span>{formatBytes(flow.responseBytes)}</span>
                    <span>{formatDuration(flow.durationMs)}</span>
                    <span className={styles.waterfall} title={flowPath(flow)}>
                      <span
                        className={styles.bar}
                        style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
                      />
                    </span>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
