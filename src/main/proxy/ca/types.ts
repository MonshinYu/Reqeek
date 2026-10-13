/**
 * MITM 证书体系的契约。
 *
 * 这一层存在的理由：想做 HTTPS 解密，就必须在客户端面前冒充目标服务器，
 * 而冒充需要一个被系统信任的根 CA。于是有三件事要拆开：
 *
 * 1. 生成（x509.ts）—— 造根 CA、按域名现签 leaf
 * 2. 缓存（index.ts）—— 同一个域名不能每次握手都重签
 * 3. 信任（trust/）—— 把根证书装进系统信任库、检测装没装上、能卸干净
 *
 * 第 3 件事和系统代理一样是平台强相关的（macOS 走 Keychain，Windows 走证书存储），
 * 所以照 system-proxy 的样子做成 driver 接口。
 */

/** 证书的公开信息 —— 展示、落盘、跨进程传输都用它；私钥不在其中 */
export interface CertificateInfo {
  /** 主体通用名，形如 `Reqeek CA (MonshinYu-MacBook)` */
  commonName: string;
  /** SHA-256 指纹：十六进制**大写**、无分隔符，与 security / certutil 的输出对齐 */
  fingerprint256: string;
  /** PEM 编码的证书 */
  pem: string;
  notBefore: number;
  notAfter: number;
}

/** 要签一张 leaf 时的输入 */
export interface LeafRequest {
  /** 目标主机名或 IP 字面量 */
  host: string;
  /**
   * host 是不是 IP 字面量。
   *
   * 这个标志必须由调用方给出且必须准确：SAN 里 IP 要用 iPAddress 类型、
   * 域名要用 dNSName 类型。填错的话证书照样能签发，但客户端一律不认 ——
   * 而且失败现象是"握手莫名失败"，很难往回查到 SAN 类型上。
   */
  isIp: boolean;
}

export interface LeafMaterial {
  /** PEM 编码的私钥 */
  key: string;
  /** PEM 编码的证书 */
  cert: string;
  /** 是否命中缓存。用来观测缓存到底有没有起作用 */
  cached: boolean;
}

export interface CertificateAuthority {
  readonly root: CertificateInfo;
  /** 根证书 PEM 的落盘路径 —— 导出和安装引导都要用它 */
  readonly certPath: string;
  /** 取一份 leaf（含私钥）。同一 host 重复调用应命中缓存 */
  getLeaf: (request: LeafRequest) => Promise<LeafMaterial>;
  /** 释放内存里持有的私钥引用 */
  dispose: () => void;
}

/**
 * 信任状态 —— **三态而不是布尔**。
 *
 * 「证书在证书库里」和「系统信任这张证书」是两件不同的事：用户手动双击
 * 导入一张 .crt 时，默认是「不信任」的，还要再手动设成「始终信任」。
 * 用布尔表示的话，这两种情况都会显示成"装好了"，然后用户会发现解密
 * 还是失败却不知道为什么。
 */
export type TrustState =
  /** 在证书库里，且被系统信任 —— 只有这个状态解密才能工作 */
  | 'trusted'
  /** 在证书库里，但没有被信任（典型的：导入了但没设「始终信任」） */
  | 'installed'
  /** 不在证书库里 */
  | 'not-installed'
  /** 当前平台还没实现 */
  | 'unsupported';

export interface CertificateTrustDriver {
  readonly platform: 'darwin' | 'win32' | 'linux';
  /** 查我们这根 CA 的信任状态 */
  inspect: (info: CertificateInfo) => Promise<TrustState>;
  /** 装进**用户**信任库（不需要管理员权限） */
  install: (certPath: string) => Promise<void>;
  /** 从信任库移除。必须幂等：没装过也要当成功 */
  uninstall: (info: CertificateInfo) => Promise<void>;
}

export class CertificateError extends Error {
  readonly stderr: string;

  constructor(message: string, stderr = '') {
    super(message);
    this.name = 'CertificateError';
    this.stderr = stderr;
  }
}
