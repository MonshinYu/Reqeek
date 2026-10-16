import React from 'react';
import styles from './input.module.css';
import {useFormField} from '../FormField/form-field-context';

// 'prefix' 一并 Omit：HTMLAttributes 上那个是 RDFa 的 prefix?: string，
// 和这里的插槽同名不同义，不摘掉就没法声明成 ReactNode
interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size' | 'prefix'> {
  /** sm 用于标题栏这类紧凑工具条，md 用于表单 */
  size?: 'sm' | 'md';
  /** 错误态。放在 FormField 里时由字段自动带出，不用手写 */
  invalid?: boolean;
  prefix?: React.ReactNode;
  suffix?: React.ReactNode;
  ref?: React.Ref<HTMLInputElement>;
}

/**
 * 统一输入框。边框、底色、圆角、焦点环都画在外层容器上，前后缀因此落在边框之内。
 *
 * 输入法相关的组合事件一律不拦截：组件只透传 props，
 * compositionstart/end、文本选择、复制粘贴都保持浏览器原生行为。
 */
export const Input = (props: InputProps): React.ReactElement => {
  const {
    size = 'md',
    invalid,
    prefix,
    suffix,
    className,
    disabled,
    'aria-describedby': ariaDescribedBy,
    'aria-invalid': ariaInvalid,
    ...rest
  } = props;

  const field = useFormField();
  // 显式传入的优先，其次才轮到 FormField —— 不然单独用 Input 时就没法覆盖字段的判定
  const describedBy = ariaDescribedBy ?? field?.describedBy;
  const isInvalid = (invalid ?? ariaInvalid ?? field?.invalid) || undefined;

  return (
    <div className={[styles.root, styles[size], className ?? ''].filter(Boolean).join(' ')}>
      {prefix != null && <span className={styles.affix}>{prefix}</span>}
      <input
        className={styles.input}
        disabled={disabled}
        aria-invalid={isInvalid}
        aria-describedby={describedBy}
        {...rest}
      />
      {suffix != null && <span className={styles.affix}>{suffix}</span>}
    </div>
  );
};
