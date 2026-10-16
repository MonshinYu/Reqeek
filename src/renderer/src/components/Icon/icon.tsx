import React from 'react';

export type IconName =
  | 'check'
  | 'chevron-down'
  | 'chevron-right'
  | 'chevron-up'
  | 'clear'
  | 'close'
  | 'dash'
  | 'record'
  | 'stop';

/*
 * 全部按 16×16 画，靠 width/height 缩放。三个约定抄自 TitleBar 原来那几个内联 SVG：
 * viewBox 0 0 16 16、颜色一律 currentColor（由使用方的 color 决定）、装饰性元素不参与无障碍。
 *
 * 用 SVG 而不是 ▾ ▸ ▲ × 这类字形：字形在不同语言的字体下基线和粗细都会飘，
 * 而这里好几个要跟着状态做旋转动画，字形一转就露馅。
 */
const PATHS: Record<IconName, React.ReactNode> = {
  record: <circle cx="8" cy="8" r="5" fill="currentColor" />,
  stop: <rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" />,
  clear: (
    <>
      <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4.5 11.5l7-7" stroke="currentColor" strokeWidth="1.4" />
    </>
  ),
  close: (
    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  ),
  check: (
    <path
      d="M3.5 8.5l3 3 6-6"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  dash: <path d="M4 8h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />,
  'chevron-down': (
    <path
      d="M4 6l4 4 4-4"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  'chevron-up': (
    <path
      d="M4 10l4-4 4 4"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  'chevron-right': (
    <path
      d="M6 4l4 4-4 4"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  )
};

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
}

/**
 * 装饰性图标，一律 aria-hidden：语义由使用方承担（按钮的 aria-label、选项的可见文字）。
 * 需要单独表达含义时请给使用方加 aria-label，不要试图给图标加。
 */
export const Icon = (props: IconProps): React.ReactElement => {
  const { name, size = 16, className } = props;

  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
};
