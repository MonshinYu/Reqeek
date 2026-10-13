import {useSyncExternalStore} from 'react';
import type {Flow} from '@shared/types';

/** 渲染进程保留的条数上限，与主进程的历史上限同量级 */
const MAX_FLOWS = 20_000;

/**
 * 流量数据的外部 store。
 *
 * 不用 React state：批量推送一次最多几百条，放进 state 会让每批都触发整树重渲染。
 * 这里用 useSyncExternalStore，快照是不可变数组，只有真的变了才换引用。
 */
let flows: Flow[] = [];
let ready = false;
const listeners = new Set<() => void>();

const notify = (): void => {
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * 合并一批 flow。同一个 id 可能同时出现在历史快照和增量推送里（订阅与拉取之间有
 * 重叠窗口），所以按 id 去重，后到的覆盖先到的。
 */
const merge = (incoming: Flow[]): void => {
  if (incoming.length === 0) return;

  const indexById = new Map<number, number>();
  flows.forEach((flow, index) => indexById.set(flow.id, index));

  const next = flows.slice();
  for (const flow of incoming) {
    const existing = indexById.get(flow.id);
    if (existing === undefined) {
      indexById.set(flow.id, next.length);
      next.push(flow);
    } else {
      next[existing] = flow;
    }
  }

  flows = next.length > MAX_FLOWS ? next.slice(-MAX_FLOWS) : next;
  notify();
};

let started = false;

/** 订阅推送并拉一次历史。幂等，应用启动时调一次即可 */
export const startTrafficStore = (): void => {
  if (started) return;
  started = true;

  // 先订阅再拉快照：反过来的话，两步之间到达的 flow 会丢；重叠部分由 id 去重兜住
  window.api.onTraffic(merge);
  void window.api.getTrafficSnapshot().then((snapshot) => {
    merge(snapshot);
    ready = true;
    notify();
  });
};

export const clearTraffic = async (): Promise<void> => {
  await window.api.clearTraffic();
  flows = [];
  notify();
};

export const useFlows = (): Flow[] =>
  useSyncExternalStore(
    subscribe,
    () => flows,
    () => flows
  );

export const useTrafficReady = (): boolean =>
  useSyncExternalStore(
    subscribe,
    () => ready,
    () => ready
  );
