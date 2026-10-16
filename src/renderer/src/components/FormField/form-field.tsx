import React, {useId} from 'react';
import styles from './form-field.module.css';
import {FormFieldContext} from './form-field-context';

interface FormFieldProps {
  label: React.ReactNode;
  /**
   * 关联控件的 id。给了才渲染成 <label>，点标签会转发点击到控件；
   * 不给则渲染成 <span> —— 没有关联对象的 <label> 是无效标记，
   * 只读的值（版本号）和「标题 + 按钮」这种行用它即可。
   */
  htmlFor?: string;
  /** 补充说明，显示在控件下方 */
  description?: React.ReactNode;
  /** 错误信息。给了就取代 description，并以 role="alert" 播报 */
  error?: React.ReactNode;
  /**
   * horizontal：标签在左、控件在右（设置页那种紧凑的一行一行）；
   * vertical：标签在上、控件占满整行。
   */
  orientation?: 'horizontal' | 'vertical';
  className?: string;
  children: React.ReactNode;
}

export const FormField = (props: FormFieldProps): React.ReactElement => {
  const {
    label,
    htmlFor,
    description,
    error,
    orientation = 'horizontal',
    className,
    children
  } = props;

  const labelId = `${useId()}-label`;
  // 错误优先：两者都在时只让错误参与 aria-describedby，
  // 免得读屏把说明和报错连着念一遍
  const messageId = `${labelId}-message`;
  const describedBy = error || description ? messageId : undefined;

  return (
    <FormFieldContext value={{describedBy, labelId, invalid: Boolean(error)}}>
      <div
        className={[styles.field, styles[orientation], className ?? ''].filter(Boolean).join(' ')}
      >
        {htmlFor ? (
          <label id={labelId} htmlFor={htmlFor} className={styles.label}>
            {label}
          </label>
        ) : (
          <span id={labelId} className={styles.label}>
            {label}
          </span>
        )}

        <div className={styles.control}>
          {children}
          {error ? (
            <p id={messageId} role="alert" className={styles.error}>
              {error}
            </p>
          ) : description ? (
            <p id={messageId} className={styles.description}>
              {description}
            </p>
          ) : null}
        </div>
      </div>
    </FormFieldContext>
  );
};
