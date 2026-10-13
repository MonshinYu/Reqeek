import type {Flow} from '@shared/types';
import {type ResourceType, resourceTypeOf} from './filter';

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

export const formatTime = (timestamp: number): string =>
  new Date(timestamp).toTimeString().slice(0, 8);

export const formatDuration = (ms: number): string =>
  ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;

/** 完整路径（含 query）；明文 HTTP 的 url 是绝对地址，解密请求是 origin-form */
export const flowPath = (flow: Flow): string => {
  if (flow.kind === 'connect') return `${flow.host}:${flow.port}`;
  if (flow.url.startsWith('/')) return flow.url;
  try {
    const url = new URL(flow.url);
    return `${url.pathname}${url.search}`;
  } catch {
    return flow.url;
  }
};

/** Name 列的主标题：路径最后一段，没有就用 "/" */
export const flowName = (flow: Flow): string => {
  if (flow.kind === 'connect') return flow.host;
  const path = flowPath(flow).split('?')[0];
  const last = path.split('/').filter(Boolean).pop();
  return last ? decodeSafe(last) : '/';
};

const decodeSafe = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

/** 完整的 https/http URL，用于详情的 Request URL 行 */
export const flowFullUrl = (flow: Flow): string => {
  if (flow.kind === 'connect') return flow.url;
  if (!flow.url.startsWith('/')) return flow.url;
  const scheme = flow.secure ? 'https' : 'http';
  const defaultPort = flow.secure ? 443 : 80;
  const host = flow.port === defaultPort ? flow.host : `${flow.host}:${flow.port}`;
  return `${scheme}://${host}${flow.url}`;
};

const TYPE_LABEL: Record<ResourceType, string> = {
  fetch: 'fetch',
  doc: 'document',
  css: 'stylesheet',
  js: 'script',
  font: 'font',
  img: 'image',
  media: 'media',
  ws: 'websocket',
  other: 'other',
  tunnel: 'tunnel'
};

export const typeLabel = (flow: Flow): string => TYPE_LABEL[resourceTypeOf(flow)];

export const typeIcon = (flow: Flow): string => {
  const type = resourceTypeOf(flow);
  const icons: Record<ResourceType, string> = {
    fetch: '📄',
    doc: '🌐',
    css: '🎨',
    js: '⚙️',
    font: '🔤',
    img: '🖼️',
    media: '🎬',
    ws: '🔌',
    other: '❓',
    tunnel: '🔗'
  };
  return icons[type];
};

/** 状态码的语义分类，用来给状态列着色 */
export type StatusTone = 'ok' | 'redirect' | 'error' | 'none';

export const statusTone = (flow: Flow): StatusTone => {
  if (flow.error) return 'error';
  if (flow.status === null) return 'none';
  if (flow.status >= 400) return 'error';
  if (flow.status >= 300) return 'redirect';
  return 'ok';
};

export const statusText = (flow: Flow): string => {
  if (flow.error && flow.status === null) return '(failed)';
  if (flow.kind === 'connect') return '(tunnel)';
  return flow.status === null ? '(pending)' : String(flow.status);
};
