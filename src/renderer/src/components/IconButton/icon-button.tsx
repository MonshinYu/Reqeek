import React from 'react';
import styles from './icon-button.module.css';
import {Icon, type IconName} from '../Icon';

interface IconButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'children'> {
  icon: IconName;
  /**
   * 必填，同时落到 aria-label 与 title。
   * 图标按钮没有可见文字，漏了这个屏幕阅读器只会念「按钮」——
   * 做成必填项，漏掉就编译不过，比写在文档里管用。
   */
  label: string;
  size?: 'xs' | 'sm';
  /** 图标颜色：默认弱化（次要操作）、strong 用于强调、danger 用于录制这类红色语义 */
  tone?: 'subtle' | 'strong' | 'danger';
  ref?: React.Ref<HTMLButtonElement>;
}

export const IconButton = (props: IconButtonProps): React.ReactElement => {
  const {
    icon,
    label,
    size = 'sm',
    tone = 'subtle',
    className,
    ...rest
  } = props;

  const classNames = [styles.iconButton, styles[tone], styles[size], className ?? '']
    .filter(Boolean)
    .join(' ');

  return (
    <button type="button" className={classNames} title={label} aria-label={label} {...rest}>
      <Icon name={icon} size={size === 'sm' ? 14 : 12} />
    </button>
  );
};
