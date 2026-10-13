import type {Socket} from 'node:net';
import net from 'node:net';
import type {Duplex} from 'node:stream';

/**
 * 一条 CONNECT 隧道的终局数据。
 *
 * 三个值一起交出去是有意的：字节数要能独立于"隧道怎么结束的"被信任，
 * error 则回答"为什么结束"。
 */
export interface TunnelResult {
  /** 客户端 → 上游。含 CONNECT 之后已读到的 head（TLS ClientHello 常在这里） */
  requestBytes: number;
  /** 上游 → 客户端 */
  responseBytes: number;
  /** 失败原因；两端正常收尾为 null */
  error: string | null;
}

export interface TunnelOptions {
  host: string;
  port: number;
  /**
   * 已经从 HTTP server 接管过来的客户端 socket。
   * Node 给的类型是 Duplex，运行时就是 net.Socket —— 升级之后它不再有 HTTP 语义
   */
  clientSocket: Duplex;
  /**
   * CONNECT 请求头之后已经读到的隧道数据。
   * 转发和计数都不能漏掉它，否则第一个 TLS 包就丢了，表现是"连上了但一直挂住"
   */
  head: Buffer;
  /**
   * 连上游的"连接建立"超时（毫秒，默认 10s，与 server.ts 的 upgrade 分支对齐）。
   *
   * 上游被防火墙 DROP（只丢包不回 RST）时 connect 会一直静默重试 SYN：客户端
   * 既等不到 200 也等不到 502，这条隧道和它的 flow 就永远悬着。计时只覆盖
   * 建立阶段、连上即撤 —— 隧道里的 WebSocket / SSE 空闲长连接不受影响。
   */
  upstreamConnectTimeoutMs?: number;
  /** 隧道结束时的回调，恰好一次 */
  onFinish: (result: TunnelResult) => void;
}

export interface TunnelHandle {
  /**
   * 上游 socket。暴露出来是给调用方纳管用：close() 要能把活着的隧道一起切断，
   * 否则 server.close() 会被隧道吊住
   */
  readonly upstream: Socket;
}

/**
 * 连接建立超时的默认值，与 server.ts 的 upgrade 分支对齐：同一类黑洞场景，
 * 两条路径给客户端的上限应当一致（10 秒）。
 */
const DEFAULT_UPSTREAM_CONNECT_TIMEOUT_MS = 10_000;

/**
 * 建立一条 CONNECT 隧道：上游 TCP 连通后回 200，之后两端原样对拷。
 *
 * 不解密 —— 这是 V0 的取舍，代价是这里只能看到目标、流量和时长。
 */
export const openTunnel = (options: TunnelOptions): TunnelHandle => {
  const { host, port, clientSocket, head, onFinish, upstreamConnectTimeoutMs } = options;

  let requestBytes = head.length;
  let responseBytes = 0;
  let settled = false;

  const finish = (error: string | null = null): void => {
    if (settled) return;
    settled = true;
    onFinish({ requestBytes, responseBytes, error });
  };

  // 上游连上之前先别读客户端。不 pause 的话，任何提前挂上的 data 监听都会
  // 把这一段数据吃掉，而那时它还没有去处 —— 这一段正是 TLS ClientHello 的常客
  clientSocket.pause();
  clientSocket.once('error', () => clientSocket.destroy());

  const upstream = net.connect(port, host);
  let established = false;

  // 上游是黑洞（防火墙只 DROP、不回 RST）时 connect 会一直静默重试 SYN：客户端
  // 既等不到 200 也等不到 502，隧道和 flow 永远悬着。计时只覆盖"连接建立"这一段，
  // 连上立即撤销 —— 有意不用 socket.setTimeout：那是空闲计时，会把建立之后的
  // WebSocket / SSE 长连接也一起误杀
  const connectTimer = setTimeout(() => {
    if (established) return;
    // 还没往客户端写过任何响应字节，按连接失败补 502 是安全的（与 error 路径同款）
    if (clientSocket.writable) {
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    } else {
      clientSocket.destroy();
    }
    finish('上游连接超时');
    upstream.destroy();
  }, upstreamConnectTimeoutMs ?? DEFAULT_UPSTREAM_CONNECT_TIMEOUT_MS);

  upstream.on('connect', () => {
    established = true;
    clearTimeout(connectTimer);
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) upstream.write(head);

    // 计数挂在 data 事件上，和 pipe 并行。pipe 的背压会同时暂停这两条路，
    // 所以计数不会因为缓冲而偏大
    clientSocket.on('data', (chunk: Buffer) => {
      requestBytes += chunk.length;
    });
    upstream.on('data', (chunk: Buffer) => {
      responseBytes += chunk.length;
    });

    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
    clientSocket.resume();
  });

  upstream.on('error', (error: Error) => {
    clearTimeout(connectTimer);
    // 已经回过 200 就不能再补 502 —— 隧道里的字节流已经开始，补进去的任何东西
    // 都会被对端当成隧道数据，是污染而不是报错
    if (!established && clientSocket.writable) {
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    } else {
      clientSocket.destroy();
    }
    finish(error.message);
  });

  // 任一端断开，这条隧道就结束了
  upstream.once('close', () => {
    clearTimeout(connectTimer);
    finish();
    clientSocket.destroy();
  });
  clientSocket.once('close', () => {
    clearTimeout(connectTimer);
    finish();
    upstream.destroy();
  });

  return { upstream };
};
