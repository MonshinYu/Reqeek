import React from 'react';
import type {AppGroup} from '@/lib/filter';
import styles from './app-sidebar.module.css';

interface AppSidebarProps {
  groups: AppGroup[];
  total: number;
  /** 当前选中的应用名；null 表示全部 */
  selected: string | null;
  onSelect: (name: string | null) => void;
}

/** 左侧应用列表：按发起请求的应用分组，点击即按应用筛选，再点一次取消 */
export const AppSidebar = (props: AppSidebarProps): React.ReactElement => {
  const { groups, total, selected, onSelect } = props;

  return (
    <nav className={styles.sidebar} aria-label="按应用筛选">
      <button
        type="button"
        className={styles.item}
        aria-pressed={selected === null}
        onClick={() => onSelect(null)}
      >
        <span className={styles.name}>全部应用</span>
        <span className={styles.count}>{total}</span>
      </button>
      {groups.map((group) => (
        <button
          key={group.name}
          type="button"
          className={styles.item}
          aria-pressed={selected === group.name}
          title={group.name}
          onClick={() => onSelect(selected === group.name ? null : group.name)}
        >
          <span className={styles.name}>{group.name}</span>
          <span className={styles.count}>{group.count}</span>
        </button>
      ))}
    </nav>
  );
};
