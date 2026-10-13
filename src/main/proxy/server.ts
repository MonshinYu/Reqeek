import http from 'node:http';
import https from 'node:https';
import type {Socket} from 'node:net';
import net from 'node:net';
import type {Duplex} from 'node:stream';
import tls from 'node:tls';
import type {ClientApp, Flow, HeaderList} from '@shared/types';
import type {ClientResolver} from './client-process';
import {createBodyCapture, mimeOf, rawHeadersToList} from './capture';
import type {StoredDetail} from './detail-store';
import {openTunnel} from './tunnel';
import type {CertificateAuthority} from './ca/types';
import {createTlsLayer} from './mitm/tls-layer';
import {mayFallbackToTunnel, MitmDenylist} from './mitm/exclusions';
import {connectHostHeaderMatches, type FilterOptions, parseConnectTarget, shouldMitm} from './filters';

export interface ProxyServerOptions {
  port: number;
  /** 每条请求 / 每条隧道结束时回调一次 */
  onFlow: (flow: Flow) => void;
  /** 请求头 / 响应头 / body 的采集结果。先于同一条 flow 的 onFlow 调用，界面看到 flow 时详情已就绪 */
  onDetail?: (detail: StoredDetail) => void;
  /**
   * 按客户端源端口反查发起请求的应用。配置后，flow 会等反查完成（最多几百毫秒）再发出；
   * 不配置则 flow.app 恒为 null，flow 同步发出。
   */
  resolveClient?: ClientResolver;
  /** 监听成功之后才可能触发的错误（绑定失败走 Promise reject） */
  onError?: (error: Error) => void;
  /**
   * 连上游的"连接建立"超时（毫秒，默认 10s）。
   *
   * 只覆盖 connect 阶段：上游被防火墙 DROP（只丢包不回 RST）时 TCP 会一直
   * 静默重试 SYN，不给上限的话客户端收不到任何响应，flow 也永远悬着。
   * 连上之后计时就撤了 —— 隧道里的慢速长连接、WebSocket 空闲期都不受影响。
   */
  upstreamConnectTimeoutMs?: number;
  /** Configured CA enables TLS interception for eligible CONNECT targets. */
  authority?: CertificateAuthority;
  filters?: FilterOptions;
  /** 额外信任的上游 CA（PEM）。默认只用系统根证书；主要给测试使用 */
  upstreamCa?: string;
}

export interface ProxyServer {
  /** 实际监听的端口 */
  port: number;
  close: () => Promise<void>;
}

const LISTEN_HOST = '127.0.0.1';

/**
 * 逐跳头（hop-by-hop）：只对"当前这一条连接"有意义，代理转发时必须剥掉，
 * 由 Node 在下一跳重新生成。
 *
 * 最容易踩的是 transfer-encoding —— Node 的 http 客户端会自动把 chunked 解掉，
 * 如果把 transfer-encoding: chunked 原样转给下游，下游会再解一次，body 就烂了。
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

const stripHopByHop = (headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders => {
  const result: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue;
    result[key] = value;
  }
  return result;
};

/** 连上游的默认连接建立超时：被 DROP 的上游会让 connect 永远挂在重试 SYN 上 */
const DEFAULT_UPSTREAM_CONNECT_TIMEOUT_MS = 10_000;

/**
 * 升级响应头的缓冲上限。合法响应头撑死几 KB，攒到 64 KiB 说明对端根本没在发
 * 一个完整的响应头（挂了，或者在灌垃圾），再攒下去就是无界内存。
 */
const MAX_RESPONSE_HEAD_BYTES = 64 * 1024;

/** 响应头与响应头之间的分隔符 */
const HEAD_END = '\r\n\r\n';

/**
 * 判定一次"非 101 升级响应"的 body 何时读完。
 *
 * 升级分支拿到的是裸字节流，Node 不会帮忙收尾；而 HTTP/1.1 的上游发完响应
 * 默认还保持 keep-alive，不能等它自己关连接。只能按报文框架自己数，数满才算
 * 读完、才敢收尾：
 * - Content-Length：转发满 N 字节 body
 * - Transfer-Encoding: chunked：跟完 0 号块（以及可选的 trailer）
 * - 两者都没有：那是"连接关闭即结束"的老式语义，交给上游 close 路径，返回 null
 *
 * 返回的函数喂入 body 字节（含与响应头同一块到达的那一段），喂满时回调 onEnd。
 *
 * headText 必须只包含响应头那一段：body 常与响应头同块到达，正文里出现的
 * "transfer-encoding: chunked" 之类字样会让框架判断整个跑偏（见调用处注释）。
 */
const createBodyEndWatcher = (
  headText: string,
  onEnd: () => void
): ((chunk: Buffer) => void) | null => {
  const lower = headText.toLowerCase();
  // 有 Transfer-Encoding 时 Content-Length 必须忽略（RFC 9112），否则会算错边界
  const chunked = /transfer-encoding:[^\r\n]*chunked/.test(lower);
  const contentLength = chunked ? null : /content-length:\s*(\d+)/.exec(lower);
  if (contentLength !== null) {
    let remaining = Number(contentLength[1]);
    // Content-Length: 0（空 body 的拒绝响应就是典型）在 watcher 建好这一刻就已经
    // "读完"了：后面永远不会有 body 数据来推进 remaining，而 keep-alive 的上游
    // 不会主动关连接，干等下去 flow 和两端 socket 会一直吊着
    if (remaining <= 0) {
      onEnd();
      // 已经收尾，返回空消费者而不是 null —— null 的语义是"认不出报文框架、
      // 交给上游 close 兜底"，这里不该再落到那条路上
      return (): void => undefined;
    }
    return (chunk: Buffer): void => {
      if (remaining <= 0) return;
      remaining -= chunk.length;
      if (remaining <= 0) onEnd();
    };
  }
  if (!chunked) return null;

  // chunked 的最小状态机：size 行 → data → CRLF → 下一个 size 行；
  // 0 号块之后是可选的 trailer，读到空行才算真的结束
  let stage: 'size' | 'data' | 'crlf' | 'trailer' = 'size';
  let remaining = 0;
  let line = '';
  let done = false;

  return (chunk: Buffer): void => {
    if (done) return;
    let offset = 0;
    while (offset < chunk.length) {
      if (stage === 'data') {
        const take = Math.min(remaining, chunk.length - offset);
        offset += take;
        remaining -= take;
        if (remaining === 0) stage = 'crlf';
        continue;
      }
      // 其余三个状态都按"行"推进，行内容只有十六进制长度和可选扩展，正常几字节
      // 就结束；被 TCP 拆开的半行先留在 line 里，等下一块到齐再判断
      const newline = chunk.indexOf(0x0a, offset);
      if (newline === -1) {
        line += chunk.toString('latin1', offset);
        if (line.length > MAX_RESPONSE_HEAD_BYTES) {
          // 一行都超过响应头上限，说明对端已经不讲 HTTP 了：按读完处理，别吊着
          done = true;
          onEnd();
        }
        return;
      }
      line += chunk.toString('latin1', offset, newline);
      offset = newline + 1;
      const content = line.endsWith('\r') ? line.slice(0, -1) : line;
      line = '';
      if (stage === 'crlf') {
        // 数据块后面的 CRLF：内容是什么都无所谓，下一个肯定是 size 行
        stage = 'size';
        continue;
      }
      if (stage === 'trailer') {
        if (content === '') {
          // 空行 = trailer 结束 = 整个响应读完
          done = true;
          onEnd();
          return;
        }
        continue;
      }
      const size = Number.parseInt(content.split(';')[0].trim(), 16);
      if (!Number.isInteger(size) || size < 0) {
        // 长度行都解析不出来，别再等一个永远等不到的结果
        done = true;
        onEnd();
        return;
      }
      if (size === 0) {
        stage = 'trailer';
        continue;
      }
      remaining = size;
      stage = 'data';
    }
  };
};

/**
 * 创建一个显式 HTTP 代理。
 *
 * 这里只依赖 node 内置模块，不 import electron —— 将来要把它搬进
 * utilityProcess 独立进程时，换一个宿主文件即可，这个文件一行不用改。
 */
export const createProxyServer = (options: ProxyServerOptions): Promise<ProxyServer> => {
  const { onFlow, onError, onDetail } = options;
  let nextId = 1;
  const tlsLayer = options.authority ? createTlsLayer(options.authority) : null;
  const denylist = new MitmDenylist();
  const upstreamAgent = new https.Agent({
    keepAlive: true,
    ALPNProtocols: ['http/1.1'],
    ...(options.upstreamCa ? { ca: [...tls.rootCertificates, options.upstreamCa] } : {})
  });

  // 记下所有活着的 socket，close() 时统一销毁。
  // 不这么做的话，keep-alive 连接和 CONNECT 隧道会让 server.close() 一直等下去
  const sockets = new Set<Socket>();
  const track = (socket: Socket): void => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };

  // 实际监听的端口（options.port 可能是 0），反查器要用它在连接表里认出客户端那一端
  let listenPort = options.port;
  // 解密后的 TLS socket 拿不到可靠的源端口，在 CONNECT 阶段记下原始 socket 的端口
  const mitmClientPorts = new WeakMap<Socket, number | undefined>();

  /** 请求一开始就发起反查：此时连接肯定还在，到结束时再查可能已经查不到了 */
  const lookupApp = (clientPort: number | undefined): Promise<ClientApp | null> | null =>
    options.resolveClient && clientPort !== undefined && listenPort !== 0
      ? options.resolveClient(clientPort, listenPort).catch(() => null)
      : null;

  /** 发出 flow：有反查就等它出结果；beforeEmit 用于保证详情先于 flow 提交 */
  const emitFlow = (
    flow: Flow,
    lookup: Promise<ClientApp | null> | null,
    beforeEmit?: () => void
  ): void => {
    const run = (): void => {
      beforeEmit?.();
      onFlow(flow);
    };
    if (!lookup) {
      run();
      return;
    }
    void lookup.then((app) => {
      flow.app = app;
      run();
    });
  };

  interface Recorder {
    requestBody: ReturnType<typeof createBodyCapture>;
    responseBody: ReturnType<typeof createBodyCapture>;
    onResponse: (response: http.IncomingMessage) => void;
    /** 在 onFlow 之前调用：界面看到 flow 时详情必须已经就绪 */
    commit: () => void;
  }

  /** 旁路记录一条 http 请求的头与 body，只读不改，不影响转发路径 */
  const createRecorder = (flow: Flow, startedAt: number, rawRequestHeaders: string[]): Recorder => {
    const requestBody = createBodyCapture();
    const responseBody = createBodyCapture();
    const requestHeaders = rawHeadersToList(rawRequestHeaders);
    let responseHeaders: HeaderList = [];
    return {
      requestBody,
      responseBody,
      onResponse: (response) => {
        responseHeaders = rawHeadersToList(response.rawHeaders);
        flow.mimeType = mimeOf(response.headers['content-type']);
        flow.ttfbMs = Date.now() - startedAt;
      },
      commit: () => {
        onDetail?.({
          id: flow.id,
          requestHeaders,
          responseHeaders,
          requestBody: requestBody.finish(),
          responseBody: responseBody.finish()
        });
      }
    };
  };

  const server = http.createServer();
  const mitmTargets = new WeakMap<Socket, { host: string; port: number }>();
  const mitmServer = http.createServer((req, res) => {
    const targetInfo = mitmTargets.get(req.socket);
    if (!targetInfo) {
      res.writeHead(502);
      res.end();
      return;
    }
    const startedAt = Date.now();
    const flow: Flow = {
      id: nextId++,
      kind: 'http',
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      host: targetInfo.host,
      port: targetInfo.port,
      status: null,
      startedAt,
      durationMs: 0,
      requestBytes: 0,
      responseBytes: 0,
      error: null,
      secure: true,
      mimeType: null,
      ttfbMs: null,
      hasDetail: true,
      app: null
    };
    const lookup = lookupApp(mitmClientPorts.get(req.socket));
    const recorder = createRecorder(flow, startedAt, req.rawHeaders);
    let settled = false;
    const finish = (error: string | null = null): void => {
      if (settled) return;
      settled = true;
      flow.durationMs = Date.now() - startedAt;
      flow.error = error;
      emitFlow(flow, lookup, recorder.commit);
    };
    const upstream = https.request({
      host: targetInfo.host,
      port: targetInfo.port,
      method: req.method,
      path: req.url ?? '/',
      headers: stripHopByHop(req.headers),
      servername: net.isIP(targetInfo.host) ? undefined : targetInfo.host,
      agent: upstreamAgent,
      rejectUnauthorized: true
    });
    upstream.on('response', (response) => {
      flow.status = response.statusCode ?? null;
      recorder.onResponse(response);
      response.on('data', (chunk: Buffer) => {
        flow.responseBytes += chunk.length;
        recorder.responseBody.push(chunk);
      });
      response.on('end', () => finish());
      res.writeHead(response.statusCode ?? 502, stripHopByHop(response.headers));
      response.pipe(res);
    });
    upstream.on('error', (error: Error) => {
      if (!res.headersSent) res.writeHead(502);
      if (!res.writableEnded) res.end();
      finish(error.message);
    });
    req.on('data', (chunk: Buffer) => {
      flow.requestBytes += chunk.length;
      recorder.requestBody.push(chunk);
    });
    req.on('aborted', () => {
      upstream.destroy();
      finish('客户端中断');
    });
    res.on('close', () => {
      if (!settled) {
        upstream.destroy();
        finish('客户端中断');
      }
    });
    req.pipe(upstream);
  });

  // ---------------------------------------------------------------- 明文 HTTP
  server.on('request', (req, res) => {
    const startedAt = Date.now();
    const flow: Flow = {
      id: nextId++,
      kind: 'http',
      method: req.method ?? 'GET',
      url: req.url ?? '',
      host: req.headers.host ?? '',
      port: 80,
      status: null,
      startedAt,
      durationMs: 0,
      requestBytes: 0,
      responseBytes: 0,
      error: null,
      secure: false,
      mimeType: null,
      ttfbMs: null,
      hasDetail: true,
      app: null
    };
    const lookup = lookupApp(req.socket.remotePort);
    const recorder = createRecorder(flow, startedAt, req.rawHeaders);

    let settled = false;
    const finish = (error: string | null = null): void => {
      if (settled) return;
      settled = true;
      flow.durationMs = Date.now() - startedAt;
      flow.error = error;
      emitFlow(flow, lookup, recorder.commit);
    };

    // 代理收到的 request line 里是完整 URL（absolute-form），这是它和普通
    // HTTP 服务器最大的区别。直接用浏览器访问代理本身（http://127.0.0.1:8989/）
    // 时才会是相对路径，那种情况 V0 直接拒绝
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Reqeek 代理：无法解析请求目标');
      finish('无法解析请求目标');
      return;
    }

    flow.host = target.hostname;
    flow.port = Number(target.port) || 80;

    const upstream = http.request({
      host: flow.host,
      port: flow.port,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers: stripHopByHop(req.headers)
    });

    upstream.on('response', (upstreamRes) => {
      flow.status = upstreamRes.statusCode ?? null;
      recorder.onResponse(upstreamRes);
      upstreamRes.on('data', (chunk: Buffer) => {
        flow.responseBytes += chunk.length;
        recorder.responseBody.push(chunk);
      });
      res.writeHead(upstreamRes.statusCode ?? 502, stripHopByHop(upstreamRes.headers));
      upstreamRes.pipe(res);
      upstreamRes.on('end', () => finish());
    });

    upstream.on('error', (error: Error) => {
      if (!res.headersSent && !res.writableEnded) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`Reqeek 代理：上游连接失败 - ${error.message}`);
      } else {
        res.destroy();
      }
      finish(error.message);
    });

    res.on('close', () => {
      // 客户端提前断开时也要收尾，否则这条记录永远停在"进行中"
      if (settled) return;
      upstream.destroy();
      finish('客户端中断');
    });

    // 计数挂在 data 事件上，和 pipe 并行。pipe 的背压会同时暂停这两条路，
    // 所以计数不会因为缓冲而偏大
    req.on('data', (chunk: Buffer) => {
      flow.requestBytes += chunk.length;
      recorder.requestBody.push(chunk);
    });

    req.pipe(upstream);
  });

  // ---------------------------------------------------------------- HTTPS 隧道
  // V0 不解密，只做透明转发；能看到的只有目标域名、流量大小和时长
  server.on('connect', (req, clientSocket, head) => {
    const target = parseConnectTarget(req.url ?? '');
    if (!target) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const { host, port } = target;
    if (!connectHostHeaderMatches(req.headers.host, target)) {
      clientSocket.end('HTTP/1.1 421 Misdirected Request\r\n\r\n');
      return;
    }

    const startedAt = Date.now();
    const flow: Flow = {
      id: nextId++,
      kind: 'connect',
      method: 'CONNECT',
      url: req.url ?? '',
      host,
      port,
      status: null,
      startedAt,
      durationMs: 0,
      requestBytes: head.length,
      responseBytes: 0,
      error: null,
      secure: false,
      mimeType: null,
      ttfbMs: null,
      hasDetail: false,
      app: null
    };
    // CONNECT 的客户端 socket 在运行时就是 net.Socket，只是回调签名写成了 Duplex
    const clientPort = (clientSocket as Socket).remotePort;
    const lookup = lookupApp(clientPort);

    const fallback = (reason: string | null = null): void => {
      if (!clientSocket.destroyed) {
        const tunnel = openTunnel({
          host,
          port,
          clientSocket,
          head,
          onFinish: (result) => {
            flow.requestBytes = result.requestBytes;
            flow.responseBytes = result.responseBytes;
            flow.durationMs = Date.now() - startedAt;
            flow.error = result.error ?? reason;
            emitFlow(flow, lookup);
          },
          upstreamConnectTimeoutMs: options.upstreamConnectTimeoutMs
        });
        track(tunnel.upstream);
      }
    };

    if (!tlsLayer || !shouldMitm(target, options.filters) || denylist.has(host)) {
      fallback();
      return;
    }

    let secureEstablished = false;
    tlsLayer.accept(
      clientSocket,
      head,
      host,
      (clientTls) => {
        secureEstablished = true;
        mitmTargets.set(clientTls, { host, port });
        mitmClientPorts.set(clientTls, clientPort);
        track(clientTls);
        // Feed the decrypted socket into the HTTP parser without opening another port.
        mitmServer.emit('connection', clientTls);
        let settled = false;
        const finish = (error: string | null = null): void => {
          if (settled) return;
          settled = true;
          flow.durationMs = Date.now() - startedAt;
          flow.error = error;
          emitFlow(flow, lookup);
        };
        clientTls.on('data', (chunk: Buffer) => {
          flow.requestBytes += chunk.length;
        });
        clientTls.once('error', (error: Error) => finish(error.message));
        clientTls.once('close', () => finish());
      },
      (error) => {
        if (mayFallbackToTunnel(secureEstablished)) {
          denylist.add(host);
          fallback(error.message);
        } else {
          clientSocket.destroy();
        }
      }
    );
  });

  // ------------------------------------------------------------ 明文 WebSocket
  // stripHopByHop 会剥掉 upgrade 头，对普通请求是对的；但升级请求是唯一例外 ——
  // 它恰恰靠 upgrade / connection 两个头成立。没有这条监听时，Node 会把带 Upgrade
  // 的请求交给 request 分支，剥完头转发出去就退化成普通 GET，对端永远不回 101：
  // 客户端侧表现为 WebSocket 静默失效，而且没有任何报错
  // secureTarget 有值时表示这是 MITM 解密后的 wss 升级：目标来自 CONNECT，
  // 请求行已是 origin-form，上游用 TLS 连接
  const handleUpgrade = (
    req: http.IncomingMessage,
    clientSocket: Duplex,
    head: Buffer,
    secureTarget?: { host: string; port: number }
  ): void => {
    const startedAt = Date.now();

    const flow: Flow = {
      id: nextId++,
      kind: 'http',
      method: req.method ?? 'GET',
      url: req.url ?? '',
      host: secureTarget?.host ?? '',
      port: secureTarget?.port ?? 80,
      status: null,
      startedAt,
      durationMs: 0,
      requestBytes: 0,
      responseBytes: 0,
      error: null,
      secure: secureTarget !== undefined,
      mimeType: null,
      ttfbMs: null,
      hasDetail: false,
      app: null
    };
    const lookup = lookupApp(
      secureTarget ? mitmClientPorts.get(req.socket) : req.socket.remotePort
    );

    let settled = false;
    const finish = (error: string | null = null): void => {
      if (settled) return;
      settled = true;
      flow.durationMs = Date.now() - startedAt;
      flow.error = error;
      emitFlow(flow, lookup);
    };

    // 发给代理的升级请求一般是 absolute-form；少数客户端发 origin-form，
    // 退回用 Host 头补全，别让这类客户端也静默失效
    const urlText = (req.url ?? '').startsWith('/')
      ? `http://${req.headers.host ?? ''}${req.url}`
      : (req.url ?? '');

    let requestPath: string;
    if (secureTarget) {
      requestPath = req.url ?? '/';
    } else {
      let target: URL;
      try {
        target = new URL(urlText);
      } catch {
        clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        finish('无法解析请求目标');
        return;
      }
      flow.host = target.hostname;
      flow.port = Number(target.port) || 80;
      requestPath = `${target.pathname}${target.search}`;
    }

    // 原样重建升级请求：rawHeaders 保住大小写和顺序，且绝不剥 upgrade / connection。
    // 请求行改回 origin-form —— 绝对形式是写给代理看的，源站只认路径
    const lines = [`${flow.method} ${requestPath} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    const requestHead = Buffer.from(`${lines.join('\r\n')}\r\n\r\n`);

    // 计数直接写 flow：finish 可能在任何一步触发（比如 URL 解析失败那次，那时
    // 局部变量还没初始化），攒在局部变量里再回写既容易漏又容易踩 TDZ。
    // 字节口径按 types.ts 的冻结契约：kind 仍是 'http'，就只算 body。升级通道
    // 里 body 是请求头之后的裸字节 —— head（常常就是第一批帧）和 101 之后的
    // 帧都算，重建出来的请求头属于头部、不算。同一个 kind 的两类 flow 在展示层
    // 是同一套格式化，口径必须一致
    flow.requestBytes = head.length;
    let established = false;
    // 握手阶段先把上游响应攒着：响应头没攒全之前一个字节都不能漏给客户端，
    // WebSocket 客户端在等一个完整的 101
    let handshake: Buffer = Buffer.alloc(0);
    // 下一块从哪个偏移开始找头结束符：结束符只有 4 字节，最远会跨 3 个字节的
    // 边界，从上次扫到的尾部回退 3 字节接着扫就够，不必每块全量重扫（O(n²)）
    let scanned = 0;

    clientSocket.pause();
    clientSocket.once('error', () => clientSocket.destroy());

    const upstream: Socket = secureTarget
      ? tls.connect({
          host: flow.host,
          port: flow.port,
          servername: net.isIP(flow.host) ? undefined : flow.host,
          ALPNProtocols: ['http/1.1'],
          rejectUnauthorized: true,
          ...(options.upstreamCa ? { ca: [...tls.rootCertificates, options.upstreamCa] } : {})
        })
      : net.connect(flow.port, flow.host);
    track(upstream);

    // 上游被防火墙 DROP（只丢包不回 RST）时 connect 会一直挂着重试 SYN：客户端
    // 既等不到 101 也等不到 502，flow 也永远悬着。计时只覆盖"连接建立"这一段，
    // 连上就撤 —— 隧道里 WebSocket 的空闲长连接不受影响
    let connected = false;
    const connectTimer = setTimeout(() => {
      if (connected || established) return;
      finish('上游连接超时');
      // 还没往外发过任何响应字节，按连接失败补 502 是安全的
      if (clientSocket.writable) {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      } else {
        clientSocket.destroy();
      }
      upstream.destroy();
    }, options.upstreamConnectTimeoutMs ?? DEFAULT_UPSTREAM_CONNECT_TIMEOUT_MS);

    upstream.on('connect', () => {
      connected = true;
      clearTimeout(connectTimer);
      upstream.write(requestHead);
      if (head.length > 0) upstream.write(head);
    });
    upstream.once('close', () => clearTimeout(connectTimer));

    const onHandshake = (chunk: Buffer): void => {
      handshake = Buffer.concat([handshake, chunk]);
      const end = handshake.indexOf(HEAD_END, scanned);
      if (end === -1) {
        if (handshake.length > MAX_RESPONSE_HEAD_BYTES) {
          // 上游一直在发却给不出头结束符（挂了，或者在灌垃圾）：缓冲不能再涨，
          // 按失败收尾并拆掉两端，别把这条连接和 flow 一起吊死
          upstream.off('data', onHandshake);
          finish('上游响应头超出上限');
          if (clientSocket.writable) {
            clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
          } else {
            clientSocket.destroy();
          }
          upstream.destroy();
          return;
        }
        // 下次从尾部回退 3 字节续扫，覆盖结束符被 TCP 拆到两块里的情况
        scanned = Math.max(0, handshake.length - (HEAD_END.length - 1));
        return;
      }
      upstream.off('data', onHandshake);

      // 响应头齐了，先原样交给客户端，再从里面读出状态码。
      // headText 只取响应头那一段：body 常与响应头同块到达，整块拿去识别的话，
      // 正文里出现的 "transfer-encoding: chunked" 之类字样会被当成响应头，
      // 报文框架判错，body 被拦腰截断（见 createBodyEndWatcher）
      established = true;
      const headText = handshake.toString('latin1', 0, end + HEAD_END.length);
      const status = /^HTTP\/\d\.\d (\d{3})/.exec(headText);
      flow.status = status ? Number(status[1]) : null;
      // 字节口径按 types.ts 的冻结契约：kind 是 'http' 就只算 body。handshake 里
      // 头部之后可能已经夹带了 body（101 后立刻到的帧、拒绝响应的首段 body），
      // 头部本身不计数 —— 展示层对同一 kind 的 flow 是同一套格式化
      flow.responseBytes += handshake.length - (end + HEAD_END.length);
      clientSocket.write(handshake);

      // 计数挂 data、转发走 pipe，两者背压一致，不会算进还没发出去的缓冲
      upstream.on('data', (chunk: Buffer) => {
        flow.responseBytes += chunk.length;
      });
      upstream.pipe(clientSocket);

      if (flow.status !== 101) {
        // 升级被上游拒绝（404 / 426 / 401…）：这是一次普通的 HTTP 响应，绝不能
        // 把两端接成隧道。HTTP/1.1 的上游默认 keep-alive，发完响应不会自己关
        // 连接，必须认出 body 的结束并主动收尾，否则 flow 永远发不出去、
        // 两端 socket 一直吊着
        const bodyAlready = handshake.subarray(end + HEAD_END.length);
        handshake = Buffer.alloc(0);
        const watchBodyEnd = createBodyEndWatcher(headText, () => {
          finish();
          // 先让客户端把已转发的 body 收干净，再拆上游：上游的 close 回调负责
          // 收掉客户端 socket，并且会等它自己的写缓冲排空（见下面的 close 处理器）
          clientSocket.end();
          upstream.destroy();
        });
        // 没有可识别的报文框架时是"连接关闭即结束"，交给上游 close 路径
        if (watchBodyEnd !== null) {
          upstream.on('data', watchBodyEnd);
          watchBodyEnd(bodyAlready);
        }
        return;
      }

      handshake = Buffer.alloc(0);

      // 101 之后就是裸字节流了：两端双向对拷，head 之后的数据走这里
      clientSocket.on('data', (chunk: Buffer) => {
        flow.requestBytes += chunk.length;
      });
      clientSocket.pipe(upstream);
      clientSocket.resume();
    };

    upstream.on('data', onHandshake);

    upstream.on('error', (error: Error) => {
      // 响应头一旦发出（established），就再也不能补 502 —— 那会污染字节流
      if (!established && clientSocket.writable) {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      } else {
        clientSocket.destroy();
      }
      finish(error.message);
    });

    // 任一端断开，这条连接就结束了
    upstream.once('close', () => {
      finish();
      // 非 101 路径已经给客户端 end() 过：慢客户端 + 大 body 时，写缓冲里还有
      // 没交给内核的字节，直接 destroy 会把它们丢掉，客户端看到的响应被截断 ——
      // 与 onEnd 里"先让客户端把已转发的 body 收干净"的意图正相反。
      // 等写缓冲排空（'finish'）再销毁。net.Socket 的 destroySoon 就是干这个的，
      // 但它不在 Duplex 的类型里，所以把等价语义显式写出来。
      // 隧道场景（没 end() 过的 clientSocket）仍按原样立即拆。
      if (!clientSocket.writableEnded || clientSocket.writableFinished) {
        clientSocket.destroy();
      } else {
        clientSocket.once('finish', () => clientSocket.destroy());
      }
    });
    clientSocket.once('close', () => {
      finish();
      upstream.destroy();
    });
  };

  server.on('upgrade', (req, clientSocket, head) => handleUpgrade(req, clientSocket, head));
  mitmServer.on('upgrade', (req, clientSocket, head) => {
    const targetInfo = mitmTargets.get(req.socket);
    if (!targetInfo) {
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      return;
    }
    handleUpgrade(req, clientSocket, head, targetInfo);
  });

  // CONNECT 的客户端 socket 也走这里，所以不用在 connect 回调里重复 track
  server.on('connection', track);

  return new Promise<ProxyServer>((resolve, reject) => {
    const onListenError = (error: Error): void => {
      server.removeListener('listening', onListening);
      reject(error);
    };

    const onListening = (): void => {
      server.removeListener('error', onListenError);
      // 监听之后再挂一个 handler，避免运行期错误把主进程带崩
      server.on('error', (error: Error) => onError?.(error));

      const address = server.address();
      if (typeof address === 'object' && address !== null) listenPort = address.port;
      resolve({
        port: typeof address === 'object' && address !== null ? address.port : options.port,
        close: () => {
          tlsLayer?.close();
          upstreamAgent.destroy();
          return new Promise<void>((done) => {
            server.close(() => done());
            for (const socket of sockets) socket.destroy();
            sockets.clear();
          });
        }
      });
    };

    server.once('error', onListenError);
    server.once('listening', onListening);
    server.listen(options.port, LISTEN_HOST);
  });
};
