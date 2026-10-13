import {execFile} from 'node:child_process';
import type {ClientApp} from '@shared/types';

/** 单次系统命令（lsof / ps / netstat）的超时 */
const EXEC_TIMEOUT_MS = 2000;
/** 同一个客户端端口的反查结果缓存多久。keep-alive 连接会反复复用同一个端口 */
const PORT_CACHE_TTL_MS = 3000;
/** 收到第一个待查端口后，等多久再发起查询，用来把同一批到达的端口合并 */
const BATCH_DELAY_MS = 5;
/** pid → 应用名的缓存时长。pid 被系统回收复用需要很久，一分钟足够安全 */
const NAME_CACHE_TTL_MS = 60_000;

/** 给定"客户端的源端口"，返回发起连接的应用；查不到为 null */
export type ClientResolver = (clientPort: number, proxyPort: number) => Promise<ClientApp | null>;

export interface ClientLookupDeps {
  /** 本机所有连到 proxyPort 的连接：客户端源端口 → 进程 pid */
  connections: (proxyPort: number) => Promise<Map<number, number>>;
  /** pid → 应用名 */
  names: (pids: number[]) => Promise<Map<number, string>>;
}

const portOf = (endpoint: string): number | null => {
  const index = endpoint.lastIndexOf(':');
  if (index === -1) return null;
  const port = Number(endpoint.slice(index + 1));
  return Number.isInteger(port) ? port : null;
};

/**
 * 解析 `lsof -Fpn` 的输出。
 *
 * lsof 会把连接的两端都列出来：客户端那一端是 `本地:客户端端口->本地:代理端口`，
 * 代理自己那一端是 `本地:代理端口->本地:客户端端口`。只要远端端口等于代理端口的，
 * 才是客户端。
 */
export const parseLsofConnections = (output: string, proxyPort: number): Map<number, number> => {
  const result = new Map<number, number>();
  let pid: number | null = null;
  for (const line of output.split('\n')) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') {
      pid = Number(value);
    } else if (tag === 'n' && pid !== null) {
      const [local, remote] = value.split('->');
      if (remote === undefined || portOf(remote) !== proxyPort) continue;
      const clientPort = portOf(local);
      if (clientPort !== null) result.set(clientPort, pid);
    }
  }
  return result;
};

/** 解析 Windows `netstat -ano -p tcp`：`TCP 本地:端口 远端:端口 状态 PID` */
export const parseNetstatConnections = (output: string, proxyPort: number): Map<number, number> => {
  const result = new Map<number, number>();
  for (const line of output.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[0].toUpperCase() !== 'TCP') continue;
    if (portOf(parts[2]) !== proxyPort) continue;
    const clientPort = portOf(parts[1]);
    const pid = Number(parts[4]);
    if (clientPort !== null && Number.isInteger(pid)) result.set(clientPort, pid);
  }
  return result;
};

/**
 * 从可执行文件路径得到"用户认得的应用名"。
 *
 * macOS 上浏览器的网络请求来自 `Google Chrome.app/.../Google Chrome Helper.app/...`
 * 这样的子进程，取路径里最外层的 .app，才能把所有子进程归到同一个应用下。
 */
export const appNameFromPath = (path: string): string => {
  const segments = path.replace(/\\/g, '/').split('/').filter(Boolean);
  const bundle = segments.find((segment) => segment.toLowerCase().endsWith('.app'));
  if (bundle) return bundle.slice(0, -4);
  const last = segments[segments.length - 1] ?? path;
  return last.replace(/\.exe$/i, '');
};

/** 解析 `ps -p … -o pid=,comm=`：每行 `pid 路径或命令名` */
export const parsePsNames = (output: string): Map<number, string> => {
  const result = new Map<number, string>();
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (match) result.set(Number(match[1]), appNameFromPath(match[2]));
  }
  return result;
};

/** 解析 Windows `tasklist /FO CSV /NH`：`"映像名","PID",…` */
export const parseTasklistNames = (output: string, pids: Set<number>): Map<number, string> => {
  const result = new Map<number, string>();
  for (const line of output.split('\n')) {
    const match = /^"([^"]+)","(\d+)"/.exec(line.trim());
    if (match && pids.has(Number(match[2])))
      result.set(Number(match[2]), appNameFromPath(match[1]));
  }
  return result;
};

const run = (file: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        // lsof 没有匹配项时退出码是 1 但 stdout 为空，这是正常结果；
        // 命令不存在或超时被杀才算真正失败
        if (error && ((error as NodeJS.ErrnoException).code === 'ENOENT' || error.killed)) {
          reject(error);
          return;
        }
        resolve(String(stdout));
      }
    );
  });

const posixDeps: ClientLookupDeps = {
  connections: async (proxyPort) =>
    parseLsofConnections(
      await run('lsof', ['-nP', `-iTCP:${proxyPort}`, '-sTCP:ESTABLISHED', '-Fpn']),
      proxyPort
    ),
  names: async (pids) => parsePsNames(await run('ps', ['-p', pids.join(','), '-o', 'pid=,comm=']))
};

const windowsDeps: ClientLookupDeps = {
  connections: async (proxyPort) =>
    parseNetstatConnections(await run('netstat', ['-ano', '-p', 'tcp']), proxyPort),
  names: async (pids) =>
    parseTasklistNames(await run('tasklist', ['/FO', 'CSV', '/NH']), new Set(pids))
};

/**
 * 创建"客户端端口 → 应用"的反查器。
 *
 * 浏览器会同时开很多条连接，每条都单独跑一次 lsof 会把机器拖慢，所以同一时刻
 * 排队的端口合并成一次查询；查询期间新来的端口等下一轮。结果按端口短暂缓存，
 * keep-alive 连接复用同一端口时不用重复查。
 */
export const createClientResolver = (
  deps: ClientLookupDeps = process.platform === 'win32' ? windowsDeps : posixDeps
): ClientResolver => {
  const portCache = new Map<number, { app: ClientApp | null; at: number }>();
  const nameCache = new Map<number, { name: string; at: number }>();
  const waiting = new Map<number, Promise<ClientApp | null>>();
  const resolvers = new Map<number, (app: ClientApp | null) => void>();
  let running = false;

  const namesFor = async (pids: number[]): Promise<Map<number, string>> => {
    const now = Date.now();
    const names = new Map<number, string>();
    const missing: number[] = [];
    for (const pid of pids) {
      const cached = nameCache.get(pid);
      if (cached && now - cached.at < NAME_CACHE_TTL_MS) names.set(pid, cached.name);
      else missing.push(pid);
    }
    if (missing.length > 0) {
      const fetched = await deps.names(missing).catch(() => new Map<number, string>());
      for (const [pid, name] of fetched) {
        names.set(pid, name);
        nameCache.set(pid, { name, at: now });
      }
    }
    return names;
  };

  const drain = async (proxyPort: number): Promise<void> => {
    try {
      while (resolvers.size > 0) {
        const batch = new Map(resolvers);
        resolvers.clear();

        const connections = await deps
          .connections(proxyPort)
          .catch(() => new Map<number, number>());
        const pids = [
          ...new Set(
            [...batch.keys()]
              .map((port) => connections.get(port))
              .filter((pid): pid is number => pid !== undefined)
          )
        ];
        const names = pids.length > 0 ? await namesFor(pids) : new Map<number, string>();

        const now = Date.now();
        for (const [port, settle] of batch) {
          const pid = connections.get(port);
          const name = pid === undefined ? undefined : names.get(pid);
          const app = pid !== undefined && name !== undefined ? { pid, name } : null;
          portCache.set(port, { app, at: now });
          waiting.delete(port);
          settle(app);
        }
      }
    } finally {
      running = false;
    }
  };

  return (clientPort, proxyPort) => {
    const cached = portCache.get(clientPort);
    if (cached && Date.now() - cached.at < PORT_CACHE_TTL_MS) return Promise.resolve(cached.app);

    const pending = waiting.get(clientPort);
    if (pending) return pending;

    const promise = new Promise<ClientApp | null>((resolve) => {
      resolvers.set(clientPort, resolve);
    });
    waiting.set(clientPort, promise);
    if (!running) {
      running = true;
      // 稍等一下再查：浏览器常常在几毫秒内连开一批连接，立即开始的话
      // 第一条会独占一次查询，后面的全得等下一轮
      setTimeout(() => void drain(proxyPort), BATCH_DELAY_MS);
    }
    return promise;
  };
};
