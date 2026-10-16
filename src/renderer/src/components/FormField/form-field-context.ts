import {createContext, useContext} from 'react';

interface FormFieldContextValue {
  /** 描述或错误信息的元素 id，控件直接接给 aria-describedby */
  describedBy: string | undefined;
  /**
   * 标签元素的 id。Select 要拿它拼 aria-labelledby ——
   * combobox 读不出自己的可见文字，必须靠外部标签命名。
   * 由 FormField 统一发，调用方就不用自己对齐两处 id。
   */
  labelId: string;
  invalid: boolean;
}

/*
 * 表单字段与控件之间的约定：FormField 负责生成 id 与呈现标签/描述/错误，
 * Input、Select 负责把这些接到自己的 aria-* 上。
 *
 * 用 context 而不是让调用方手写 aria-describedby / aria-labelledby，
 * 是为了让二者不可能写岔：文案和 id 是同一个来源生成的，
 * 不会再出现「错误显示了但屏幕阅读器不知道」。
 */
const FormFieldContext = createContext<FormFieldContextValue | null>(null);

/** 不在 FormField 里时返回 null，控件按「没有标签也没有描述」处理即可 */
export const useFormField = (): FormFieldContextValue | null => useContext(FormFieldContext);

export {FormFieldContext};
