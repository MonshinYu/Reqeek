/**
 * 系统代理的平台抽象。
 *
 * 为什么需要这一层：系统代理**不是一个开关**，而是 web / secureWeb / socks / pac
 * 四组彼此独立的配置，各有各的开关和地址。V0 把它们当成一个整体开关来读写，
 * 结果是「用户只开了 secureWeb 时，我们停止时会把 secureWeb 一起关掉」—— 抹掉
 * 用户自己的代理配置。这个抽象存在的首要目的就是杜绝这类事。
 *
 * 同时 macOS 和 Windows 的读写方式、目标粒度完全不同：
 * - macOS 是 per-网络服务（Wi-Fi / 以太网 / USB 共享…），命令走 networksetup
 * - Windows 是注册表全局（HKCU\\...\\Internet Settings），且 ProxyServer 用
 *   "http=...;https=...;socks=..." 这种单字符串承载多协议
 *
 * 上层只认 SystemProxyDriver，不认 networksetup 也不认注册表。加一个平台 = 加一个文件。
 */

/** 四类代理，各自独立开关、独立地址 */
export type ProxyKind = 'web' | 'secureWeb' | 'socks' | 'pac';

export interface ProxyEntry {
  enabled: boolean;
  /** pac 类型下这里是 PAC 脚本 URL，port 无意义（0） */
  host: string;
  port: number;
}

/**
 * 写入前的完整原样。
 *
 * 还原时必须**逐项比对回填**，绝不能走「整体关掉」的捷径 —— 用户可能只用其中
 * 一两项，整体关闭就等于抹掉他的配置。
 */
export interface ProxySnapshot {
  /** 平台内的目标标识：macOS 是网络服务名（如 "Wi-Fi"），Windows 是连接名或 "Default" */
  target: string;
  entries: Record<ProxyKind, ProxyEntry>;
  bypassDomains: string[];
  capturedAt: number;
}

/** driver.read() 的返回形：不含 identity 字段，由调用方补全 */
export type TargetState = Omit<ProxySnapshot, 'capturedAt' | 'target'>;

export interface SystemProxyDriver {
  readonly platform: 'darwin' | 'win32' | 'linux';

  /**
   * 列出候选目标，**当前活跃的排在第一个**。
   * - macOS: `networksetup -listallnetworkservices`，活跃服务靠默认路由反查接口再匹配
   * - Windows: 只有一个目标，返回 ['Default']
   */
  listTargets(): Promise<string[]>;

  read(target: string): Promise<TargetState>;

  /**
   * 把 target 的代理指向本地端口。
   *
   * bypassDomains 由调用方传入**合并后的完整列表** —— 合并逻辑放在状态层是为了
   * 可单测，driver 只负责如实写入。
   *
   * 实现要求：只动 web + secureWeb 两项，socks / pac 保持原样不碰。
   */
  apply(target: string, host: string, port: number, bypassDomains: string[]): Promise<void>;

  /** 逐项还原到快照。对应每个 ProxyKind 逐项写回，不做任何整体开关的捷径 */
  restore(snapshot: ProxySnapshot): Promise<void>;
}

/**
 * 系统代理写入的落盘状态。
 *
 * 为什么要落盘：只放内存的话，app 崩溃后没人知道"我们改过什么、原样是什么"，
 * 下次启动只能盲目清空 —— 而那正是会永久抹掉用户 bypass 列表的做法。
 */
export type SystemProxyPhase =
  /** 已决定要改、快照已落盘，但还没写进系统 */
  | 'intent'
  /** 已写进系统，快照有效，退出/崩溃时按它还原 */
  | 'committed'
  /** 已还原，快照作废 */
  | 'cleared';

/**
 * 所有权证明。
 *
 * 只有写出这份状态的进程才有权恢复系统代理。
 * token 每次启动重新生成 —— 只靠 PID 会在 PID 复用后误判成"这是我们的残留"，
 * 从而去动一个其实属于别人的配置。
 */
export interface WriteOwnership {
  pid: number;
  /** 每次进程启动随机生成的 uuid，防止 PID 复用导致误判 */
  token: string;
  startedAt: number;
}

export interface PersistedSystemProxyState {
  version: 1;
  phase: SystemProxyPhase;
  snapshot: ProxySnapshot | null;
  owner: WriteOwnership;
}

/** 命令执行失败时抛出，带上原始 stderr 便于归因 */
export class SystemProxyError extends Error {
  readonly stderr: string;

  constructor(message: string, stderr = '') {
    super(message);
    this.name = 'SystemProxyError';
    this.stderr = stderr;
  }
}
