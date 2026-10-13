import type {HeaderList} from '@shared/types';

/** 单个 body 最多保留的字节数；超出的部分只计数不保存 */
export const BODY_LIMIT_PER_ITEM = 5 * 1024 * 1024;

export interface CapturedBody {
  bytes: Buffer;
  /** 传输上的原始总字节数 */
  size: number;
  truncated: boolean;
}

export interface BodyCapture {
  push: (chunk: Buffer) => void;
  /** 没有任何字节时返回 null */
  finish: () => CapturedBody | null;
}

/**
 * 旁路采集 body：与转发并行，只保存前 limit 字节。
 * 一律拷贝：subarray 会钉住整个 socket chunk，内存会比预算膨胀数十倍。
 */
export const createBodyCapture = (limit: number = BODY_LIMIT_PER_ITEM): BodyCapture => {
  const chunks: Buffer[] = [];
  let kept = 0;
  let size = 0;

  return {
    push: (chunk) => {
      size += chunk.length;
      if (kept >= limit) return;
      const slice = chunk.length <= limit - kept ? chunk : chunk.subarray(0, limit - kept);
      chunks.push(Buffer.from(slice));
      kept += slice.length;
    },
    finish: () =>
      size === 0 ? null : { bytes: Buffer.concat(chunks, kept), size, truncated: size > kept }
  };
};

/** rawHeaders 是 [k1, v1, k2, v2…]，转成保留大小写与顺序的键值对 */
export const rawHeadersToList = (rawHeaders: string[]): HeaderList => {
  const list: HeaderList = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) list.push([rawHeaders[i], rawHeaders[i + 1]]);
  return list;
};

/** Content-Type 取 mime 部分：小写、去参数；没有则 null */
export const mimeOf = (value: string | string[] | undefined): string | null => {
  const text = Array.isArray(value) ? value[0] : value;
  if (!text) return null;
  const mime = text.split(';')[0].trim().toLowerCase();
  return mime === '' ? null : mime;
};
