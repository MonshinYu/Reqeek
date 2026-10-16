import React from 'react';
import {useTranslation} from 'react-i18next';
import {type AppGroup, UNKNOWN_APP} from '@/lib/filter';
import {Button} from '@/components/Button';
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
  const { t } = useTranslation();

  /** 反查不到来源的分组在内部用的是哨兵名，显示时才换成文案 */
  const labelOf = (name: string): string =>
    name === UNKNOWN_APP ? t('sidebar.unknownApp') : name;

  return (
    <nav className={styles.sidebar} aria-label={t('sidebar.byApp')}>
      <Button
        variant="text"
        size="sm"
        shape="rounded"
        className={styles.item}
        aria-pressed={selected === null}
        onClick={() => onSelect(null)}
      >
        <span className={styles.name}>{t('sidebar.allApps')}</span>
        <span className={styles.count}>{total}</span>
      </Button>

      {groups.map((group) => (
        <Button
          key={group.name}
          variant="text"
          size="sm"
          shape="rounded"
          className={styles.item}
          aria-pressed={selected === group.name}
          title={labelOf(group.name)}
          onClick={() => onSelect(selected === group.name ? null : group.name)}
        >
          <span className={styles.name}>{labelOf(group.name)}</span>
          <span className={styles.count}>{group.count}</span>
        </Button>
      ))}
    </nav>
  );
};
