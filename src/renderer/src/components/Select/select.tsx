import React, {useCallback, useEffect, useId, useLayoutEffect, useState} from 'react';
import {createPortal} from 'react-dom';
import styles from './select.module.css';
import {Icon} from '../Icon';
import {useFormField} from '../FormField/form-field-context';
import {useMergedRef} from '@/lib/refs';
import {useSelectPosition} from './use-select-position';

export interface SelectOption<T extends string> {
  value: T;
  /** 已经翻好的文案。组件不碰 i18n —— 语言项的 key 是 `languages.${code}` 拼出来的，
   *  把 key 传进来反而要在组件里对动态字符串调 t() */
  label: string;
  disabled?: boolean;
}

interface SelectProps<T extends string> {
  options: readonly SelectOption<T>[];
  /** 受控，只有一个真相来源 */
  value: T;
  onChange: (value: T) => void;
  /** 触发器的 id：给 label 的 htmlFor 用，同时作为面板内各元素 id 的前缀 */
  id?: string;
  /** 外部 label 的 id。给了才用 aria-labelledby 命名，理由见下方注释 */
  labelId?: string;
  className?: string;
  disabled?: boolean;
  'aria-label'?: string;
  'aria-describedby'?: string;
  ref?: React.Ref<HTMLButtonElement>;
}

/**
 * 自定义下拉选择。不复用原生 <select>：macOS 上它的弹层是系统 NSMenu，
 * 跟随的是**系统外观**而不是页面的 color-scheme —— 用户在应用里选了深色、
 * 系统却是浅色时，界面暗着、下拉列表亮着，靠 CSS 修不了。
 *
 * ARIA 用 combobox + aria-activedescendant，DOM 焦点全程留在触发器上：
 * 面板 portal 到 body、排在 #root 之后，若把焦点移进面板，Tab 就会跳出 React 树，
 * 还得再写一套焦点陷阱。焦点不动则 Tab 顺序天然正确，面板里连 tabindex 都不需要。
 *
 * 注意：aria-activedescendant 只在支持它的 role 上生效，而 <button> 的默认 role 是
 * button —— 下面那行 role="combobox" 是必需的，不是装饰。
 */
export function Select<T extends string>(props: SelectProps<T>): React.ReactElement {
  const {
    options,
    value,
    onChange,
    id,
    labelId,
    className,
    disabled,
    'aria-label': ariaLabel,
    'aria-describedby': ariaDescribedBy,
    ref
  } = props;

  const reactId = useId();
  const baseId = id ?? `select-${reactId}`;
  const listboxId = `${baseId}-listbox`;
  const valueId = `${baseId}-value`;

  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const {triggerRef, panelRef, listRef, pos} = useSelectPosition(open);
  const attachTrigger = useMergedRef(triggerRef, ref);
  const field = useFormField();

  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = options[selectedIndex];

  /** 展开时高亮谁：当前值优先，值不在选项里（或那一项被禁用）就退到第一个可用项 */
  const initialIndex = (): number => {
    if (selectedIndex >= 0 && !options[selectedIndex]?.disabled) return selectedIndex;
    return Math.max(
      0,
      options.findIndex((option) => !option.disabled)
    );
  };

  const openPanel = (): void => {
    setActiveIndex(initialIndex());
    setOpen(true);
  };

  const commit = (index: number): void => {
    const option = options[index];
    setOpen(false);
    // 值没变就别回调：commit() 会立刻 IPC 落盘并广播，白写一次盘是有代价的
    if (!option || option.disabled || option.value === value) return;
    onChange(option.value);
  };

  /** 手写倒序而不是 findLastIndex：那个要 ES2023 的 lib，本项目的 target 够不着 */
  const lastEnabled = (): number => {
    for (let index = options.length - 1; index >= 0; index -= 1) {
      if (!options[index]?.disabled) return index;
    }
    return 0;
  };

  /** 上下移动，跳过禁用项；撞到两端就停在原地 */
  const move = (delta: number): void => {
    setActiveIndex((current) => {
      for (let next = current + delta; next >= 0 && next < options.length; next += delta) {
        if (!options[next]?.disabled) return next;
      }
      return current;
    });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    // 输入法组合期间会发出 keyCode 229 的伪按键事件，不能当成真实操作
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;

    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        // 收起态只展开、不改值：commit() 会立刻落盘并广播，方向键不能隐式改设置
        event.preventDefault();
        if (open) move(event.key === 'ArrowDown' ? 1 : -1);
        else openPanel();
        return;

      case 'Home':
        if (!open) return;
        event.preventDefault();
        setActiveIndex(Math.max(0, options.findIndex((option) => !option.disabled)));
        return;

      case 'End':
        if (!open) return;
        event.preventDefault();
        setActiveIndex(lastEnabled());
        return;

      case 'Enter':
      case ' ':
        event.preventDefault();
        if (open) commit(activeIndex);
        else openPanel();
        return;

      case 'Escape':
        if (!open) return;
        event.preventDefault();
        setOpen(false);
        // 焦点本来就没离开过触发器，兜个底
        triggerRef.current?.focus();
        return;

      case 'Tab':
        // 不 preventDefault：面板里没有任何可聚焦元素，拦住 Tab 等于把用户困在这一个 tab stop 上
        if (open) setOpen(false);
        return;

      default:
    }
  };

  /*
   * 点外关闭用 mousedown 而不是 click：click 在"按下与抬起不在同一个元素"时根本不触发，
   * 从面板拖到外面就永远关不掉；mousedown 还能赶在底层元素处理这次点击之前先把面板收掉。
   * capture 阶段是为了抢在其它处理器前头。
   */
  useEffect(() => {
    if (!open) return;

    const onDocumentMouseDown = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (!target) return;
      // 触发器自己按下不算"外部"：交给它的 onClick 去切换，否则会先关后开
      if (triggerRef.current?.contains(target)) return;
      // 面板是 portal 出去的，只能看 DOM 包含关系，看不了 React 树
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };

    document.addEventListener('mousedown', onDocumentMouseDown, true);
    return () => document.removeEventListener('mousedown', onDocumentMouseDown, true);
  }, [open, panelRef, triggerRef]);

  /** 让高亮项留在可视区里。不用 scrollIntoView —— 它会连带滚动所有可滚动祖先 */
  useLayoutEffect(() => {
    if (!open) return;
    const list = listRef.current;
    const item = list?.children[activeIndex] as HTMLElement | undefined;
    if (!list || !item) return;

    const listRect = list.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    if (itemRect.top < listRect.top) list.scrollTop -= listRect.top - itemRect.top;
    else if (itemRect.bottom > listRect.bottom) list.scrollTop += itemRect.bottom - listRect.bottom;
  }, [open, activeIndex, listRef]);

  /*
   * 面板内按下时保住焦点：portal 出去以后，点面板里的任何东西都会把焦点交给 body，
   * 随后键盘与 aria-activedescendant 一起失效。但命中滚动条时不能拦，拦了就拖不动。
   */
  const onListMouseDown = useCallback((event: React.MouseEvent<HTMLUListElement>): void => {
    const list = event.currentTarget;
    const onScrollbar = event.target === list && event.nativeEvent.offsetX >= list.clientWidth;
    if (!onScrollbar) event.preventDefault();
  }, []);

  /*
   * 鼠标划过也把高亮挪过去，高亮始终只有一个来源。
   *
   * 用 mousemove 而不是给每个选项挂 mouseenter：后者在面板正好开在光标底下时会立刻触发，
   * 高亮无缘无故跳一格。mousemove 只认真实的移动。
   * 禁用项跳过，和方向键保持一致 —— 否则回车会选中一个本该点不动的项。
   */
  const onListMouseMove = useCallback(
    (event: React.MouseEvent<HTMLUListElement>): void => {
      const list = event.currentTarget;
      const option = (event.target as Element).closest('[role="option"]');
      if (!option) return;

      const index = Array.prototype.indexOf.call(list.children, option);
      if (index < 0 || index === activeIndex || options[index]?.disabled) return;
      setActiveIndex(index);
    },
    [activeIndex, options]
  );

  /*
   * combobox 不在 ARIA 的 name-from-content 名单里，光靠 <label htmlFor> 只能念出字段名、
   * 念不出当前选的是哪一项。把 label 的 id 和值节点的 id 一起放进 aria-labelledby，
   * 名字就是两段的拼接，读作「语言 中文，组合框」。
   * （<button> 本身是 labelable element，所以 htmlFor 那半边照常工作，点标签会转发点击。）
   */
  const effectiveLabelId = labelId ?? field?.labelId;
  const labelledBy =
    [effectiveLabelId, effectiveLabelId ? valueId : undefined].filter(Boolean).join(' ') ||
    undefined;

  const panel = (
    <div
      ref={panelRef}
      className={styles.panel}
      hidden={!open}
      style={
        pos
          ? {
              top: pos.top,
              left: pos.left,
              minWidth: pos.minWidth,
              // 从贴着触发器的那条边展开：向下开就从顶边长，翻转向上开就从底边长
              transformOrigin: pos.flip ? 'bottom' : 'top'
            }
          : // 位置还没算出来时先藏起来，否则会先在左上角闪一下
            {visibility: 'hidden'}
      }
    >
      <ul
        ref={listRef}
        id={listboxId}
        role="listbox"
        className={styles.list}
        aria-labelledby={effectiveLabelId}
        aria-label={effectiveLabelId ? undefined : ariaLabel}
        style={pos ? {maxHeight: pos.maxHeight} : undefined}
        onMouseDown={onListMouseDown}
        onMouseMove={onListMouseMove}
      >
        {options.map((option, index) => (
          <li
            key={option.value}
            // id 用下标而不是值：值里可能含空格或斜杠，会破坏 IDREF
            id={`${baseId}-option-${index}`}
            role="option"
            className={styles.option}
            aria-selected={option.value === value}
            aria-disabled={option.disabled || undefined}
            // 键盘高亮由 aria-activedescendant 指向本身表达，这个只作 CSS 钩子
            data-active={index === activeIndex || undefined}
            onClick={() => commit(index)}
          >
            <Icon name="check" size={14} className={styles.check} />
            <span className={styles.optionLabel}>{option.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );

  return (
    <>
      <button
        ref={attachTrigger}
        id={id}
        type="button"
        role="combobox"
        className={[styles.trigger, className ?? ''].filter(Boolean).join(' ')}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open ? `${baseId}-option-${activeIndex}` : undefined}
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : ariaLabel}
        aria-describedby={ariaDescribedBy ?? field?.describedBy}
        aria-invalid={field?.invalid || undefined}
        onClick={() => (open ? setOpen(false) : openPanel())}
        onKeyDown={onKeyDown}
      >
        <span id={valueId} className={styles.value}>
          {selected?.label ?? ''}
        </span>
        <Icon name="chevron-down" size={14} className={styles.arrow} />
      </button>
      {createPortal(panel, document.body)}
    </>
  );
}
