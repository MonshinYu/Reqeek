import type {BodyData, HeaderList} from '@shared/types';

/** 文本预览的字符上限,避免几 MB 的文本把渲染进程卡住 */
export const MAX_TEXT_CHARS = 200_000;

export type BodyView =
  | { kind: 'empty' }
  /** JSON：value 是解析结果，pretty 是缩进后的文本，raw 是原文 */
  | { kind: 'json'; value: unknown; pretty: string; raw: string }
  | { kind: 'html'; raw: string }
  | { kind: 'xml'; raw: string }
  /** application/x-www-form-urlencoded：已做 URL 解码的键值对 */
  | { kind: 'form'; pairs: [string, string][]; raw: string }
  | { kind: 'text'; raw: string; clipped: boolean }
  | { kind: 'image'; dataUrl: string }
  | { kind: 'binary'; hex: string };

const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
};

/** 前 256 字节的十六进制转储:每行 16 字节,偏移 + hex + ASCII */
const hexPreview = (bytes: Uint8Array): string => {
  const lines: string[] = [];
  const limit = Math.min(bytes.length, 256);
  for (let offset = 0; offset < limit; offset += 16) {
    const row = bytes.subarray(offset, Math.min(offset + 16, limit));
    const hex = Array.from(row, (byte) => byte.toString(16).padStart(2, '0')).join(' ');
    const ascii = Array.from(row, (byte) =>
      byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.'
    ).join('');
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  ${ascii}`);
  }
  return lines.join('\n');
};

const looksBinary = (bytes: Uint8Array): boolean => {
  const sample = bytes.subarray(0, 4000);
  for (const byte of sample) if (byte === 0) return true;
  return false;
};

/** 取某个头的 mime 部分（小写、去参数）；用于从请求头里拿 Content-Type */
export const mimeFromHeaders = (headers: HeaderList, name: string): string | null => {
  const wanted = name.toLowerCase();
  const value = headers.find(([key]) => key.toLowerCase() === wanted)?.[1];
  if (!value) return null;
  const mime = value.split(';')[0].trim().toLowerCase();
  return mime === '' ? null : mime;
};

const isJsonMime = (mime: string): boolean => /(?:^|[/+])json$/.test(mime);
const isXmlMime = (mime: string): boolean => /(?:^|[/+])xml$/.test(mime);

/** 没有明确类型时才允许靠内容猜 JSON，避免把明确声明为别的类型的内容误判 */
const mayBeSniffedAsJson = (mime: string | null): boolean =>
  mime === null || mime === 'text/plain' || mime === 'application/octet-stream';

const tryParseJson = (text: string): { value: unknown; pretty: string } | null => {
  try {
    const value: unknown = JSON.parse(text);
    return { value, pretty: JSON.stringify(value, null, 2) };
  } catch {
    return null;
  }
};

/** 把采集到的 body 按数据格式分类，供 Preview 用对应的方式展示 */
export const describeBody = (body: BodyData | null, mime: string | null): BodyView => {
  if (!body || body.bytes.length === 0) return { kind: 'empty' };

  if (mime?.startsWith('image/') && body.decodeError === null && !body.truncated) {
    return { kind: 'image', dataUrl: `data:${mime};base64,${toBase64(body.bytes)}` };
  }

  // 声明为图片却没法渲染（被截断或解码失败）：残缺的图片字节当文本只会是乱码
  if (mime?.startsWith('image/') || body.decodeError !== null || looksBinary(body.bytes)) {
    return { kind: 'binary', hex: hexPreview(body.bytes) };
  }

  const decoded = new TextDecoder('utf-8').decode(body.bytes);
  // 大量替换字符说明不是 UTF-8 文本(多半是未识别的二进制)
  const replacements = decoded.split('\ufffd').length - 1;
  if (replacements > decoded.length * 0.02) return { kind: 'binary', hex: hexPreview(body.bytes) };

  const clipped = decoded.length > MAX_TEXT_CHARS;
  const raw = clipped ? decoded.slice(0, MAX_TEXT_CHARS) : decoded;
  // 被截断的文本解析不出完整结构，一律按纯文本显示
  if (clipped) return { kind: 'text', raw, clipped };

  const type = mime ?? '';
  if (isJsonMime(type)) {
    const parsed = tryParseJson(raw);
    if (parsed) return { kind: 'json', raw, ...parsed };
  } else if (mayBeSniffedAsJson(mime)) {
    const trimmed = raw.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const parsed = tryParseJson(raw);
      if (parsed) return { kind: 'json', raw, ...parsed };
    }
  }

  if (type === 'application/x-www-form-urlencoded') {
    return { kind: 'form', pairs: [...new URLSearchParams(raw)], raw };
  }
  if (type.includes('html')) return { kind: 'html', raw };
  if (isXmlMime(type)) return { kind: 'xml', raw };

  return { kind: 'text', raw, clipped };
};
