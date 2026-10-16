import React from 'react';
import styles from './button.module.css';
import {Spinner} from '../Spinner';

export type ButtonVariant = 'outlined' | 'filled' | 'text' | 'danger';
export type ButtonSize = 'xs' | 'sm' | 'md';

interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /**
   * 圆角形状。pill 是药丸形（默认，M3 按钮的常态）；
   * rounded 用 --shape-xs，给过滤 chip、侧栏项这类成排的密集控件用 ——
   * 一排 24px 高的药丸看着像标签墙，而不是可点的一列。
   */
  shape?: 'pill' | 'rounded';
  /** 加载中：显示 spinner、禁止交互，并打上 aria-busy */
  loading?: boolean;
  /** 前置图标。通常传 <Icon name="…" /> */
  icon?: React.ReactNode;
  iconPosition?: 'start' | 'end';
  fullWidth?: boolean;
  ref?: React.Ref<HTMLButtonElement>;
}

/** type 固定为 button，避免在表单里意外提交 */
export const Button = (props: ButtonProps): React.ReactElement => {
  const {
    variant = 'outlined',
    size = 'md',
    shape = 'pill',
    loading = false,
    icon,
    iconPosition = 'start',
    fullWidth = false,
    disabled,
    className,
    children,
    ...rest
  } = props;

  const classNames = [
    styles.button,
    styles[variant],
    styles[size],
    styles[shape],
    fullWidth ? styles.fullWidth : '',
    className ?? ''
  ]
    .filter(Boolean)
    .join(' ');

  // 加载时 spinner 顶掉起始图标的位置，标签不动 —— 按钮宽度的抖动比换个图标更扎眼
  const leading = loading ? (
    <Spinner size={size === 'md' ? 14 : 12} />
  ) : iconPosition === 'start' ? (
    icon
  ) : null;
  const trailing = !loading && iconPosition === 'end' ? icon : null;

  return (
    <button
      type="button"
      className={classNames}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {leading}
      {children}
      {trailing}
    </button>
  );
};
