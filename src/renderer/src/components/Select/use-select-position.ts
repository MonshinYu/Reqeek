import {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';

/** 触发器与面板之间的间隙，同时兼作翻转时的余量 */
const GAP = 4;
/** 面板离视口边缘至少留这么多 */
const VIEWPORT_MARGIN = 8;
/** 再挤也给列表留这么高，否则不如不开 */
const MIN_LIST_HEIGHT = 96;
/** .panel 的上下边框 */
const PANEL_CHROME = 2;

export interface SelectPosition {
  top: number;
  left: number;
  /** 面板至少要和触发器一样宽 */
  minWidth: number;
  maxHeight: number;
  /** 空间不够、面板改为向上开。入场动画的缩放原点要跟着它走 */
  flip: boolean;
}

interface SelectPositionRefs {
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  panelRef: React.RefObject<HTMLDivElement | null>;
  listRef: React.RefObject<HTMLUListElement | null>;
  pos: SelectPosition | null;
}

/**
 * 量触发器、算面板该放哪儿。面板是 portal 出去 + position: fixed，
 * 所以这里全程用视口坐标（getBoundingClientRect），不需要减任何祖先的偏移。
 */
export const useSelectPosition = (open: boolean): SelectPositionRefs => {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const [pos, setPos] = useState<SelectPosition | null>(null);

  const update = useCallback((): void => {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    const list = listRef.current;
    if (!trigger || !panel || !list) return;

    const anchor = trigger.getBoundingClientRect();

    // scrollHeight 是内容的自然高度，不受已生效的 max-height 影响 ——
    // 正好拿它判断"理想高度放不放得下"，反复调用也不会越量越小
    const desired = list.scrollHeight;
    const roomBelow = window.innerHeight - anchor.bottom - GAP - VIEWPORT_MARGIN - PANEL_CHROME;
    const roomAbove = anchor.top - GAP - VIEWPORT_MARGIN - PANEL_CHROME;

    // 下面装不下、且上面确实更宽裕才翻；两边都装不下就挑大的那边截断
    const flip = desired > roomBelow && roomAbove > roomBelow;
    const maxHeight = Math.max(MIN_LIST_HEIGHT, flip ? roomAbove : roomBelow);
    const panelHeight = Math.min(desired, maxHeight) + PANEL_CHROME;
    const top = flip ? anchor.top - GAP - panelHeight : anchor.bottom + GAP;

    // 水平先左对齐，右边缘越界就整体左推，再越界就贴住左边
    const width = Math.max(panel.offsetWidth, anchor.width);
    const left = Math.min(
      Math.max(anchor.left, VIEWPORT_MARGIN),
      Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN)
    );

    setPos({top, left, minWidth: anchor.width, maxHeight, flip});
  }, []);

  /*
   * 打开的那一帧"先量后画"。用 useLayoutEffect 是因为位置必须在浏览器绘制之前算好，
   * 否则面板会先在左上角闪一下再跳到位。闭合时把 pos 清掉，下次打开从零量。
   */
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    update();
  }, [open, update]);

  useEffect(() => {
    if (!open) return;

    // 滚动/缩放期间每帧只算一次
    let frame = 0;
    const schedule = (): void => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    };

    // scroll 不冒泡，但捕获阶段收得到元素自己的滚动 —— 设置页 .content 滚动时面板才跟得上
    window.addEventListener('scroll', schedule, {capture: true, passive: true});
    window.addEventListener('resize', schedule);

    // 面板内容变高（换语言后德语更长）、触发器变宽，都走这里
    const observer = new ResizeObserver(schedule);
    if (panelRef.current) observer.observe(panelRef.current);
    if (triggerRef.current) observer.observe(triggerRef.current);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule, {capture: true});
      window.removeEventListener('resize', schedule);
      observer.disconnect();
    };
  }, [open, update]);

  return {triggerRef, panelRef, listRef, pos};
};
