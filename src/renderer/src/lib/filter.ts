import type {Flow} from '@shared/types';

/** Chrome Network 的资源类型分类 */
export type ResourceType =
  'fetch' | 'doc' | 'css' | 'js' | 'font' | 'img' | 'media' | 'ws' | 'other' | 'tunnel';

export type FilterKey = 'all' | Exclude<ResourceType, 'tunnel'>;

/**
 * 资源类型标签。
 *
 * 刻意不翻译：这是与 Chrome DevTools 对齐的术语，中文版 Chrome 里也是这排英文，
 * 翻成中文反而让用户对不上自己在浏览器里看到的过滤栏。
 */
export const TYPE_FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'fetch', label: 'Fetch/XHR' },
  { key: 'doc', label: 'Doc' },
  { key: 'css', label: 'CSS' },
  { key: 'js', label: 'JS' },
  { key: 'font', label: 'Font' },
  { key: 'img', label: 'Img' },
  { key: 'media', label: 'Media' },
  { key: 'ws', label: 'WS' },
  { key: 'other', label: 'Other' }
];

/** 根据 mime 推断资源类型；没有响应的请求归为 other */
export const resourceTypeOf = (flow: Flow): ResourceType => {
  if (flow.kind === 'connect') return 'tunnel';
  if (flow.status === 101) return 'ws';
  const mime = flow.mimeType ?? '';
  if (mime.includes('html')) return 'doc';
  if (mime.includes('css')) return 'css';
  if (mime.includes('javascript') || mime.includes('ecmascript')) return 'js';
  if (mime.startsWith('image/')) return 'img';
  if (mime.startsWith('font/') || mime.includes('font')) return 'font';
  if (mime.startsWith('audio/') || mime.startsWith('video/')) return 'media';
  if (mime.includes('json') || mime.includes('xml') || mime.startsWith('text/')) return 'fetch';
  return 'other';
};

export interface FilterState {
  type: FilterKey;
  keyword: string;
  invert: boolean;
  hideTunnels: boolean;
  errorsOnly: boolean;
  /** 只看某个应用的请求；null 表示全部应用 */
  app: string | null;
}

export const INITIAL_FILTER: FilterState = {
  type: 'all',
  keyword: '',
  invert: false,
  hideTunnels: true,
  errorsOnly: false,
  app: null
};

/**
 * 反查不到来源的请求在内部都归到这个哨兵名。
 *
 * 它只是个 Map 键，不直接显示 —— 侧栏渲染时要换成 t('sidebar.unknownApp')，
 * 所以这里用中性的英文，免得英文界面下漏翻一处就露出中文。
 */
export const UNKNOWN_APP = 'unknown';

export const appNameOf = (flow: Flow): string => flow.app?.name ?? UNKNOWN_APP;

export interface AppGroup {
  name: string;
  count: number;
}

/** 按应用汇总请求数，数量多的在前；同数量按名字排，保证列表不跳动 */
export const groupByApp = (flows: Flow[]): AppGroup[] => {
  const counts = new Map<string, number>();
  for (const flow of flows) {
    const name = appNameOf(flow);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
};

export const matchesFilter = (flow: Flow, filter: FilterState): boolean => {
  if (filter.app !== null && appNameOf(flow) !== filter.app) return false;
  if (filter.hideTunnels && flow.kind === 'connect') return false;
  if (filter.errorsOnly && flow.error === null && !(flow.status !== null && flow.status >= 400)) {
    return false;
  }

  const keyword = filter.keyword.trim().toLowerCase();
  if (keyword) {
    const text = `${flow.method} ${flow.host} ${flow.url} ${flow.status ?? ''}`.toLowerCase();
    const hit = text.includes(keyword);
    if (filter.invert ? hit : !hit) return false;
  }

  if (filter.type === 'all') return true;
  return resourceTypeOf(flow) === filter.type;
};
