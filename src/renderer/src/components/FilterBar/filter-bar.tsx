import React from 'react';
import {useTranslation} from 'react-i18next';
import styles from './filter-bar.module.css';
import {Button} from '@/components/Button';
import {Checkbox} from '@/components/Checkbox';
import {type FilterState, TYPE_FILTERS} from '@/lib/filter';

interface FilterBarProps {
  filter: FilterState;
  onChange: (filter: FilterState) => void;
}

/** Chrome Network 风格的过滤栏：资源类型标签 + 若干开关（关键字输入在 titlebar） */
export const FilterBar = (props: FilterBarProps): React.ReactElement => {
  const { filter, onChange } = props;
  const { t } = useTranslation();

  const patch = (next: Partial<FilterState>): void => onChange({ ...filter, ...next });

  return (
    <div className={styles.root} role="group" aria-label={t('filter.group')}>
      {/* 类型标签沿用 Chrome DevTools 的英文原名，故意不翻译（见 lib/filter.ts） */}
      {TYPE_FILTERS.map((item) => (
        <Button
          key={item.key}
          variant="text"
          size="xs"
          shape="rounded"
          aria-pressed={filter.type === item.key}
          onClick={() => patch({ type: item.key })}
        >
          {item.label}
        </Button>
      ))}

      <span className={styles.sep} />

      <Checkbox
        label={t('filter.invertSearch')}
        checked={filter.invert}
        onChange={(event) => patch({ invert: event.target.checked })}
      />
      <Checkbox
        label={t('filter.errorsOnly')}
        checked={filter.errorsOnly}
        onChange={(event) => patch({ errorsOnly: event.target.checked })}
      />
      <Checkbox
        label={t('filter.hideTunnels')}
        checked={filter.hideTunnels}
        onChange={(event) => patch({ hideTunnels: event.target.checked })}
      />
    </div>
  );
};
