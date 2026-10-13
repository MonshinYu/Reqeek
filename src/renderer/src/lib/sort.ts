import type {Flow} from '@shared/types';
import {flowName, typeLabel} from './format';

export type SortKey = 'time' | 'name' | 'status' | 'type' | 'size' | 'duration';

export interface SortState {
  key: SortKey;
  dir: 'asc' | 'desc';
}

export const DEFAULT_SORT: SortState = { key: 'time', dir: 'asc' };

const compareText = (a: string, b: string): number => a.localeCompare(b);

const compareBy = (key: SortKey, a: Flow, b: Flow): number => {
  switch (key) {
    case 'name':
      return compareText(flowName(a), flowName(b));
    case 'status':
      return (a.status ?? -1) - (b.status ?? -1);
    case 'type':
      return compareText(typeLabel(a), typeLabel(b));
    case 'size':
      return a.responseBytes - b.responseBytes;
    case 'duration':
      return a.durationMs - b.durationMs;
    default:
      return a.startedAt - b.startedAt;
  }
};

/** 返回新数组;相等时按开始时间、再按 id 兜底,保证排序稳定且可预期 */
export const sortFlows = (flows: Flow[], sort: SortState): Flow[] => {
  const sign = sort.dir === 'asc' ? 1 : -1;
  return flows.slice().sort((a, b) => {
    const primary = compareBy(sort.key, a, b);
    if (primary !== 0) return primary * sign;
    return a.startedAt - b.startedAt || a.id - b.id;
  });
};
