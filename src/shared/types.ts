/**
 * 抓包数据模型。
 *
 * 字段是照着"以后要展示、要持久化"设计的，不是照着 V0 的终端打印设计的 ——
 * 比如 timings 那一组，现在采一点不费事，等有了时间轴视图再想补就补不回来了。
 */

import type {SupportedLanguage} from './i18n';

/** 发起请求的本机应用 */
export interface ClientApp {
  pid: number;
  /** 用户认得的应用名，如 "Google Chrome"；同一应用的多个子进程名字相同 */
  name: string;
}

/** 一条请求/记录的完整生命周期 */
export interface Flow {
  id: number;
  /** http = 明文 HTTP 转发；connect = HTTPS 隧道（V0 不解密，只能看到域名） */
  kind: 'http' | 'connect';
  method: string;
  /** 明文 HTTP 是完整 URL；隧道是 host:port */
  url: string;
  host: string;
  port: number;
  /** 响应状态码；隧道没有，为 null */
  status: number | null;
  startedAt: number;
  durationMs: number;
  /**
   * 客户端 → 上游的字节数。
   *
   * 两种 kind 的口径不同，用的时候要心里有数：
   * - `http`：只算 body，不含请求头
   * - `connect`：隧道里的一切都算，含 TLS 握手
   */
  requestBytes: number;
  /** 上游 → 客户端。口径同上，与 requestBytes 对称 */
  responseBytes: number;
  /** 失败原因；成功为 null */
  error: string | null;
  /** 是否是经 TLS 解密的 https 请求；明文 http 与隧道为 false */
  secure: boolean;
  /** 响应 Content-Type 的 mime 部分（小写、不含参数）；没有响应或没有该头为 null */
  mimeType: string | null;
  /** 从开始到收到响应头的耗时（TTFB）；没收到响应为 null */
  ttfbMs: number | null;
  /** 是否采集了请求头 / 响应头 / body，隧道与升级连接为 false */
  hasDetail: boolean;
  /** 发起请求的应用；没有配置反查器、连接已消失或属于其他用户的进程时为 null */
  app: ClientApp | null;
}

export type HeaderList = [string, string][];

/** 渲染进程拿到的 body：已按 Content-Encoding 解码（解不了则保留原始字节并带 decodeError） */
export interface BodyData {
  bytes: Uint8Array;
  /** 传输上的原始总字节数（未解码、未截断） */
  size: number;
  /** 超过单项上限，bytes 只是前一部分 */
  truncated: boolean;
  /** 解码失败或无法解码的原因；成功为 null */
  decodeError: string | null;
}

/** 一条 flow 的详情，按需通过 IPC 拉取，不随列表推送 */
export interface FlowDetail {
  id: number;
  requestHeaders: HeaderList;
  responseHeaders: HeaderList;
  requestBody: BodyData | null;
  responseBody: BodyData | null;
}

export interface ProxyStatus {
  running: boolean;
  port: number | null;
  /** 最近一次操作的错误，成功后清空 */
  error: string | null;
}

/** 根 CA 的展示信息：不含私钥，可以安全地跨进程传输 */
export interface CaStatus {
  commonName: string;
  /** SHA-256 指纹，十六进制大写、无分隔符 */
  fingerprint256: string;
  notAfter: number;
  /** 根证书 PEM 的磁盘路径 */
  certPath: string;
  /** 信任状态；只有 trusted 时 HTTPS 解密才能工作 */
  trust: 'trusted' | 'installed' | 'not-installed' | 'unsupported';
}

/** 代理往外发的事件。V0 只有一个订阅者（终端打印），以后是渲染进程 */
export type ProxyEvent = { type: 'flow'; flow: Flow } | { type: 'status'; status: ProxyStatus };

/** CA 类操作的统一返回：失败时带可读原因，不让异常穿过 IPC */
export type CaResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** 菜单触发、由渲染进程执行的动作。渲染进程持有门禁 / 选中项等状态，所以交给它判断 */
export type MenuAction = 'toggle-capture' | 'clear' | 'open-ca' | 'focus-search' | 'open-settings';

/**
 * 应用设置。
 *
 * 只放真正被消费的字段 —— 没有实现的选项不进这里。存一份没人读的配置比不存更糟：
 * 它会让界面显示一个并不生效的值，用户以为自己改动了什么。
 */
export interface AppSettings {
  /** 收窄成受支持的语言：settings.json 是纯文本，手改出来的 'fr' 不该流进 i18n */
  language: SupportedLanguage;
  theme: 'light' | 'dark' | 'auto';
  proxy: {
    port: number;
  };
}

/**
 * 检查更新失败的原因。
 *
 * 分开是因为「失败」这一个词对用户没有任何指导意义 —— 该查网络、还是做什么都没用只能等，
 * 两者的下一步动作完全不同，一句话答不了。
 */
export type UpdateFailureReason =
  /** 连不上：DNS 失败、超时。用户能自己做点什么 */
  | 'network'
  /** 连上了，但响应不是我们能认的东西（非 2xx、不是 JSON、版本号格式非法）。
   *  用户做什么都没用，只能等我们修 */
  | 'server';

/**
 * 检查更新的结果，只查版本号，不含下载与安装。
 *
 * 判别字段叫 phase 而不是 status，是为了让渲染进程能把界面自己的 'idle' / 'checking'
 * 并进同一个联合类型里 —— 判别字段相同，TS 才能一路窄化下去而不必写类型断言。
 */
export type UpdateCheckResult =
  | { phase: 'up-to-date' }
  /** version 必然是归一化后的 \d+(\.\d+)*，可以直接插进文案 */
  | { phase: 'available'; version: string }
  | { phase: 'failed'; reason: UpdateFailureReason };
