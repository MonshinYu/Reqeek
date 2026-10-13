import {promisify} from 'node:util';
import {brotliDecompress, gunzip, inflate, inflateRaw} from 'node:zlib';
import type {CapturedBody} from './capture';
import type {BodyData} from '@shared/types';

/** 解压后的上限，防止小体积压缩炸弹把主进程内存吃光 */
export const MAX_DECODED_BYTES = 20 * 1024 * 1024;

const gunzipAsync = promisify(gunzip);
const inflateAsync = promisify(inflate);
const inflateRawAsync = promisify(inflateRaw);
const brotliAsync = promisify(brotliDecompress);

const options = { maxOutputLength: MAX_DECODED_BYTES };

const decodeOne = async (encoding: string, data: Buffer): Promise<Buffer> => {
  switch (encoding) {
    case 'gzip':
    case 'x-gzip':
      return gunzipAsync(data, options);
    case 'deflate':
      // 规范要求 zlib 封装，但不少服务器发裸 deflate，两种都试
      return inflateAsync(data, options).catch(() => inflateRawAsync(data, options));
    case 'br':
      return brotliAsync(data, options);
    default:
      throw new Error(`不支持的 Content-Encoding：${encoding}`);
  }
};

const toBodyData = (bytes: Buffer, body: CapturedBody, decodeError: string | null): BodyData => ({
  // 拷贝成独立的 Uint8Array：Buffer 可能是池化切片，结构化克隆会带上整个底层 ArrayBuffer
  bytes: new Uint8Array(bytes),
  size: body.size,
  truncated: body.truncated,
  decodeError
});

/**
 * 按 Content-Encoding 解码 body。解不了不抛错：返回原始字节并带上 decodeError，
 * 让界面能说明原因而不是空白。
 */
export const decodeBody = async (
  body: CapturedBody | null,
  contentEncoding: string | null
): Promise<BodyData | null> => {
  if (!body) return null;

  const encodings = (contentEncoding ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== '' && item !== 'identity');

  if (encodings.length === 0) return toBodyData(body.bytes, body, null);

  if (body.truncated) {
    // 被截断的压缩流解不出完整内容
    return toBodyData(body.bytes, body, '响应体超过单项上限且已压缩，无法解码预览');
  }

  try {
    let current = body.bytes;
    // Content-Encoding 列出的是编码的施加顺序，解码要倒着来
    for (const encoding of encodings.reverse()) current = await decodeOne(encoding, current);
    return toBodyData(current, body, null);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return toBodyData(body.bytes, body, `解码失败：${message}`);
  }
};
