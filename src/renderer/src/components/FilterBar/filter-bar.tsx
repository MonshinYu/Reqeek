import React from 'react';
import styles from './filter-bar.module.css';
import {type FilterState, TYPE_FILTERS} from '@/lib/filter';

interface FilterBarProps {
  filter: FilterState;
  onChange: (filter: FilterState) => void;
}

/** Chrome Network 风格的过滤栏：资源类型标签 + 若干开关（关键字输入在 titlebar） */
export const FilterBar = (props: FilterBarProps): React.ReactElement => {
  const { filter, onChange } = props;

  const patch = (next: Partial<FilterState>): void => onChange({ ...filter, ...next });

  return (
    <div className={styles.root} role="group" aria-label="过滤">
      {TYPE_FILTERS.map((item) => (
        <button
          key={item.key}
          type="button"
          className={styles.chip}
          aria-pressed={filter.type === item.key}
          onClick={() => patch({ type: item.key })}
        >
          {item.label}
        </button>
      ))}
      <span className={styles.sep} />
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={filter.invert}
          onChange={(event) => patch({ invert: event.target.checked })}
        />
        反选搜索
      </label>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={filter.errorsOnly}
          onChange={(event) => patch({ errorsOnly: event.target.checked })}
        />
        仅错误
      </label>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={filter.hideTunnels}
          onChange={(event) => patch({ hideTunnels: event.target.checked })}
        />
        隐藏隧道
      </label>
    </div>
  );
};
