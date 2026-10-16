import React, {useEffect, useRef} from 'react';
import styles from './checkbox.module.css';
import {Icon} from '../Icon';
import {useFormField} from '../FormField/form-field-context';
import {useMergedRef} from '@/lib/refs';

interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: React.ReactNode;
  /** 半选态 */
  indeterminate?: boolean;
  ref?: React.Ref<HTMLInputElement>;
}

/**
 * 复选框。原生 input 只做视觉隐藏，仍留在布局与可访问性树里 ——
 * Space 键切换、点标签联动、读屏播报全靠它，自绘的只是那层皮。
 *
 * 因此也不用 accent-color 那条路子：它只能改颜色，尺寸、圆角、勾形、焦点环
 * 在三个平台上各不相同，而这正是要消掉的东西。
 */
export const Checkbox = (props: CheckboxProps): React.ReactElement => {
  const {
    label,
    indeterminate = false,
    className,
    disabled,
    'aria-describedby': ariaDescribedBy,
    // ref 必须显式摘出来：留在 rest 里的话，下面 {...rest} 会排在 ref={mergedRef} 之后
    // 把它整个盖掉，组件内部那个 ref 永远是 null，indeterminate 也就设不上去
    ref,
    ...rest
  } = props;

  const inputRef = useRef<HTMLInputElement>(null);
  const mergedRef = useMergedRef(inputRef, ref);
  const field = useFormField();

  // 半选态没有对应的 HTML 属性，只能写 DOM property
  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <label
      className={[styles.root, className ?? ''].filter(Boolean).join(' ')}
      data-disabled={disabled || undefined}
    >
      <input
        ref={mergedRef}
        type="checkbox"
        className={styles.input}
        disabled={disabled}
        aria-describedby={ariaDescribedBy ?? field?.describedBy}
        {...rest}
      />
      <span className={styles.box} aria-hidden="true">
        <Icon name={indeterminate ? 'dash' : 'check'} className={styles.mark} />
      </span>
      <span className={styles.label}>{label}</span>
    </label>
  );
};
