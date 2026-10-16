import {type Ref, useCallback} from 'react';

/** 只用到 current 这一个字段，写成结构类型就不必跟着 React 的 RefObject 定义改动跑 */
interface RefSlot<T> {
  current: T | null;
}

/**
 * 把组件内部要用的 ref 和调用方传进来的 ref 合成一个回调。
 *
 * 必须用 useCallback 固定引用：React 判断「ref 变了」看的是回调标识，
 * 每次渲染都新建函数的话，它会先以 null 调旧的、再以节点调新的，
 * 组件内部那个 ref 就被反复置空。React 19 还会把回调的返回值当成卸载函数，
 * 所以函数体写成语句块、不要有隐式返回。
 */
export const useMergedRef = <T>(
  internal: RefSlot<T>,
  external: Ref<T> | undefined
): ((node: T | null) => void) =>
  useCallback(
    (node: T | null): void => {
      internal.current = node;
      if (typeof external === 'function') external(node);
      else if (external) external.current = node;
    },
    [internal, external]
  );
