import {createProxyServer, type ProxyServer} from './server';
import {getCertificateAuthority} from './ca';
import {join} from 'node:path';
import {createSystemProxyController, type SystemProxyController, toMessage} from './system-proxy/controller';
import {createDarwinTrustDriver} from './ca/trust/darwin';
import {Win32CertificateTrustDriver} from './ca/trust/win32';
import type {CertificateTrustDriver} from './ca/types';
import {decodeBody} from './body-decode';
import {createClientResolver} from './client-process';
import {DetailStore} from './detail-store';
import type {CaStatus, FlowDetail, ProxyEvent, ProxyStatus} from '@shared/types';

/** 所有请求的头与 body 都存在这里，按总预算整条淘汰最旧的 */
const details = new DetailStore();

const headerValue = (headers: [string, string][], name: string): string | null =>
  headers.find(([key]) => key.toLowerCase() === name)?.[1] ?? null;

/** 按需取一条详情；响应体在这里才解压，列表推送路径上不做任何解码 */
export const getFlowDetail = async (id: number): Promise<FlowDetail | null> => {
  const stored = details.get(id);
  if (!stored) return null;
  return {
    id: stored.id,
    requestHeaders: stored.requestHeaders,
    responseHeaders: stored.responseHeaders,
    requestBody: await decodeBody(
      stored.requestBody,
      headerValue(stored.requestHeaders, 'content-encoding')
    ),
    responseBody: await decodeBody(
      stored.responseBody,
      headerValue(stored.responseHeaders, 'content-encoding')
    )
  };
};

export const clearFlowDetails = (): void => details.clear();

let current: ProxyServer | null = null;
let stateDir: string | null = null;
let systemProxy: SystemProxyController | null = null;
let recovery: Promise<boolean> | null = null;

/**
 * 系统代理和监听端口是一组不可分割的外部状态。启动、停止与换端口若交叠，
 * 就可能在用户已经点了停止后才完成启动，或让两次重启互相覆盖。
 */
let lifecycleTail: Promise<void> = Promise.resolve();

const serializeLifecycle = <T>(task: () => Promise<T>): Promise<T> => {
  const result = lifecycleTail.then(task, task);
  lifecycleTail = result.then(
    () => undefined,
    () => undefined
  );
  return result;
};

const listeners = new Set<(event: ProxyEvent) => void>();

export const onProxyEvent = (listener: (event: ProxyEvent) => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const emit = (event: ProxyEvent): void => {
  for (const listener of listeners) listener(event);
};

/**
 * 最近一次广播出去的状态。
 *
 * 查询接口返回它而不是现算：错误只存在于发生的那一瞬间，等渲染进程刷新时再算已经算不出来了，
 * 用户会只看到「未在抓包」而不知道刚才失败过。
 */
let lastStatus: ProxyStatus = { running: false, port: null, error: null };

const emitStatus = (status: ProxyStatus): void => {
  lastStatus = status;
  emit({ type: 'status', status });
};

export const isRunning = (): boolean => current !== null;

/** 状态快照：渲染进程刷新或晚于代理启动时用来对齐。含最近一次的错误 */
export const getProxyStatus = (): ProxyStatus => lastStatus;

/**
 * 从 IPC 层上报一次失败。
 *
 * 必须走这里而不是直接往窗口 broadcast：状态要落到 lastStatus 上，才经得起渲染进程刷新。
 * 调用它的都是「代理已经被停下」的场合（启动失败、换端口失败），所以状态就是未运行 + 这条错误。
 */
export const reportProxyFailure = (message: string): void => {
  emitStatus({ running: false, port: null, error: message });
};

// ------------------------------------------------------------------ CA 管理

/** 其余平台没有信任驱动：状态恒为 unsupported，安装/卸载给出明确报错 */
const unsupportedDriver: CertificateTrustDriver = {
  platform: 'linux',
  inspect: async () => 'unsupported',
  install: async () => {
    throw new Error('当前平台暂不支持自动安装根证书，请手动导出后安装');
  },
  uninstall: async () => {
    throw new Error('当前平台暂不支持自动卸载根证书');
  }
};

let trustDriver: CertificateTrustDriver | null = null;

const getTrustDriver = (): CertificateTrustDriver => {
  trustDriver ??=
    process.platform === 'darwin'
      ? createDarwinTrustDriver()
      : process.platform === 'win32'
        ? new Win32CertificateTrustDriver()
        : unsupportedDriver;
  return trustDriver;
};

const loadAuthority = async (): ReturnType<typeof getCertificateAuthority> => {
  if (!stateDir) throw new Error('代理核心尚未注入 stateDir（应先调用 configureProxy）');
  return getCertificateAuthority({ baseDir: join(stateDir, 'ca') });
};

/** 根证书的公开信息 + 当前信任状态 */
export const getCaStatus = async (): Promise<CaStatus> => {
  const authority = await loadAuthority();
  const trust = await getTrustDriver().inspect(authority.root);
  return {
    commonName: authority.root.commonName,
    fingerprint256: authority.root.fingerprint256,
    notAfter: authority.root.notAfter,
    certPath: authority.certPath,
    trust
  };
};

/** 装进用户信任库。macOS 可能弹出授权对话框，等用户处理完才会返回 */
export const installCa = async (): Promise<CaStatus> => {
  const authority = await loadAuthority();
  await getTrustDriver().install(authority.certPath);
  return getCaStatus();
};

/** 从信任库移除（幂等）。只动信任库，不删磁盘上的 CA 文件 */
export const uninstallCa = async (): Promise<CaStatus> => {
  const authority = await loadAuthority();
  await getTrustDriver().uninstall(authority.root);
  return getCaStatus();
};

/**
 * 注入 userData 目录。
 *
 * 路径由宿主传进来而不是在这里读 app.getPath —— 代理核心不 import electron，
 * 将来要整体搬进 utilityProcess 时，换一个来源即可。
 */
export const configureProxy = (options: { stateDir: string }): void => {
  stateDir = options.stateDir;
};

const systemProxyController = (): SystemProxyController => {
  if (!systemProxy) {
    if (!stateDir) throw new Error('代理核心尚未注入 stateDir（应先调用 configureProxy）');
    systemProxy = createSystemProxyController(stateDir);
  }
  return systemProxy;
};

/**
 * 启动代理。
 *
 * 顺序是这个函数存在的唯一理由：**先绑定端口，成功了再改系统代理**。
 * 反过来如果端口没绑上就改了系统代理，用户会在那一瞬间断网。
 */
const startProxyInternal = async (port: number): Promise<void> => {
  if (current) {
    emitStatus({ running: true, port: current.port, error: null });
    return;
  }

  const proxy = systemProxyController();

  // 残留清理没跑完就开始新一轮写入的话，可能会被上一轮的记录反过来还原掉
  if (recovery) await recovery.catch(() => undefined);

  const authority = await loadAuthority();

  // 门禁放在主进程而不是只靠界面禁用按钮：根证书不受信任时 HTTPS 无法解密，
  // 抓到的只有不透明的隧道，而且这时去改系统代理只会让用户白白断一次网
  const trust = await getTrustDriver().inspect(authority.root);
  if (trust !== 'trusted') {
    throw new Error('根证书尚未安装并受信任，请先在引导页完成 CA 证书安装');
  }

  const server = await createProxyServer({
    port,
    authority,
    onDetail: (detail) => details.add(detail),
    resolveClient: createClientResolver(),
    onFlow: (flow) => emit({ type: 'flow', flow }),
    onError: (error) => console.error('[Reqeek] 代理运行错误:', error.message)
  });

  try {
    await proxy.enable(server.port);
  } catch (error) {
    // 系统代理没设上，这个服务器就不能留着占端口
    await server.close();
    throw error;
  }

  current = server;
  emitStatus({ running: true, port: server.port, error: null });
};

/**
 * 停止代理。
 *
 * 顺序同样要紧：**先撤系统代理，再关服务器**。反过来会有一个短暂的窗口，
 * 系统代理指向一个已经死掉的端口 —— 那个窗口里用户是断网的。
 */
const stopProxyInternal = async (): Promise<boolean> => {
  if (!current) {
    emitStatus({ running: false, port: null, error: null });
    return true;
  }

  const server = current;
  current = null;

  let error: string | null = null;
  try {
    await systemProxyController().disable();
  } catch (cause) {
    // 撤不掉也得说清楚，不能让用户对着一个上不了网的机器猜
    error = `还原系统代理失败：${toMessage(cause)}。可在「系统设置 → 网络 → 代理」里手动关闭。`;
    console.error('[Reqeek]', error);
  }

  await server.close();
  emitStatus({ running: false, port: null, error });
  return error === null;
};

/**
 * 清理上次异常退出留下的系统代理残留。
 *
 * 只认自己落盘的那份记录 —— 不再像 V0 那样「看到系统代理指着我们的端口就清」，
 * 那种做法既会误伤别人，也会用空快照把用户的 bypass 列表抹掉。
 *
 * 幂等：重复调用只会重复还原同一份快照。
 */
export const recoverStaleSystemProxy = (): Promise<boolean> => {
  recovery ??= systemProxyController()
    .recoverStale()
    .catch((error: unknown) => {
      console.error('[Reqeek] 清理系统代理残留失败：', error);
      return false;
    });
  return recovery;
};

/** 启动、停止和换端口共用同一条队列，避免任意两次外部状态变更交叠。 */
export const startProxy = (port: number): Promise<void> =>
  serializeLifecycle(() => startProxyInternal(port));

export const stopProxy = (): Promise<void> =>
  serializeLifecycle(async () => {
    await stopProxyInternal();
  });

/** 在同一条生命周期任务中完成「停止旧代理 → 启动新端口」，中途不允许插队。 */
export const restartProxy = (port: number): Promise<void> =>
  serializeLifecycle(async () => {
    if (!lastStatus.running) return;
    // 还原失败时，系统代理的真实状态未知；绝不能继续启动一个看似运行、实际接不到流量的服务器。
    if (!(await stopProxyInternal())) return;
    await startProxyInternal(port);
  });
