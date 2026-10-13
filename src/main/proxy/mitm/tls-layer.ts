import tls, {type TLSSocket} from 'node:tls';
import type {Duplex} from 'node:stream';
import type {CertificateAuthority} from '../ca/types';
import {normalizeHost} from '../ca/host';

export interface TlsLayer {
  accept: (
    socket: Duplex,
    head: Buffer,
    host: string,
    onSecure: (socket: TLSSocket) => void,
    onFailure: (error: Error) => void
  ) => void;
  close: () => void;
}

export const createTlsLayer = (authority: CertificateAuthority): TlsLayer => {
  const contexts = new Map<string, tls.SecureContext>();
  let closed = false;

  /** 取（或生成）某个主机的证书上下文，按主机缓存 */
  const contextFor = async (
    normalized: NonNullable<ReturnType<typeof normalizeHost>>
  ): Promise<tls.SecureContext> => {
    const cached = contexts.get(normalized.host);
    if (cached) return cached;
    const leaf = await authority.getLeaf(normalized);
    const context = tls.createSecureContext({ key: leaf.key, cert: leaf.cert });
    contexts.set(normalized.host, context);
    return context;
  };

  return {
    accept(socket, head, host, onSecure, onFailure) {
      socket.pause();
      const normalized = normalizeHost(host);
      if (!normalized) {
        onFailure(new Error('无法规范化 CONNECT 主机名'));
        return;
      }
      void contextFor(normalized).then((context) => {
        if (closed) {
          socket.destroy();
          return;
        }
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) socket.unshift(head);

        // 每条连接各自握手、各自挂回调。不能共用一个 tls.Server 再用 once('secureConnection')
        // 去认领：并发的多条 CONNECT 会让同一个事件被所有监听者收到，
        // 除第一条外全部被误判成「SNI 与 CONNECT 主机名不一致」，退化成不可见的隧道
        let settled = false;
        const secureSocket = new tls.TLSSocket(socket as never, {
          isServer: true,
          ALPNProtocols: ['http/1.1'],
          // 没带 SNI 的客户端用 CONNECT 声明的主机证书
          secureContext: context,
          SNICallback: (servername, callback) => {
            const requested = normalizeHost(servername);
            if (!requested) return callback(new Error('Invalid SNI'));
            contextFor(requested).then(
              (sniContext) => callback(null, sniContext),
              (error: Error) => callback(error)
            );
          }
        });

        const fail = (error: Error): void => {
          if (settled) return;
          settled = true;
          secureSocket.destroy();
          onFailure(error);
        };

        secureSocket.once('secure', () => {
          if (settled) return;
          if (
            secureSocket.servername &&
            normalizeHost(secureSocket.servername)?.host !== normalized.host
          ) {
            fail(new Error('SNI 与 CONNECT 主机名不一致'));
            return;
          }
          settled = true;
          secureSocket.removeListener('error', fail);
          onSecure(secureSocket);
        });
        // 握手完成前的错误走 onFailure；完成后由调用方自己挂的 error 处理
        secureSocket.on('error', fail);
        socket.resume();
      }, onFailure);
    },
    close() {
      closed = true;
      contexts.clear();
      authority.dispose();
    }
  };
};
