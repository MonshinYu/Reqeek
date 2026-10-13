import React from 'react';
import styles from './button.module.css';

interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant?: 'default' | 'filled';
  size?: 'default' | 'small';
}

/** 药丸形按钮。type 固定为 button，避免在表单里意外提交 */
export const Button = (props: ButtonProps): React.ReactElement => {
  const { variant = 'default', size = 'default', className, ...rest } = props;

  const classNames = [
    styles.button,
    size === 'small' ? styles.small : '',
    variant === 'filled' ? styles.filled : '',
    className ?? ''
  ]
    .filter(Boolean)
    .join(' ');

  return <button type="button" className={classNames} {...rest} />;
};
