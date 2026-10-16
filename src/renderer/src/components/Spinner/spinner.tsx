import React from 'react';
import styles from './spinner.module.css';

interface SpinnerProps {
  /** 直径，单位 px。边框粗细按比例推，不用调用方操心 */
  size?: number;
  /**
   * 屏幕阅读器文案。给了就渲染成 role="status" 播报；不给则整个元素 aria-hidden ——
   * 按钮里的加载态旁边本来就有文字，再播报一次是噪音。
   */
  label?: string;
  className?: string;
}

export const Spinner = (props: SpinnerProps): React.ReactElement => {
  const { size = 16, label, className } = props;

  // 尺寸走 CSS 变量而不是内联 width/height：边框粗细得跟着一起变，
  // 两条内联样式会互相打架，交给样式表算更省事（flow-table 的 --cols 也是这个路子）
  const style = { '--spinner-size': `${size}px` } as React.CSSProperties;

  return (
    <span
      className={[styles.spinner, className ?? ''].filter(Boolean).join(' ')}
      style={style}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
};
