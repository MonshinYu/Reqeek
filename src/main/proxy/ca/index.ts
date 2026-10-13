/**
 * 证书的上层：单例、落盘、缓存。
 *
 * 磁盘上的 ca.pem / ca.key 是「用户系统信任库」那一侧的对端 —— 只要这两个文件
 * 还在，用户已经装进系统的根证书就还有效。所以本文件里每条"重新生成"的路径
 * 都必须先证明旧的那份确实用不了：
 * - 两个文件都不在 → 全新，生成；
 * - 只剩一个 → 残骸（单独半个文件连一次握手都完不成），生成；
 * - 两个都在但不配对 → **拒绝启动**，绝不覆盖 —— 那可能是用户从备份里还原了
 *   一半，覆盖就等于把他还能救回来的根证书作废掉。
 *
 * 目录由调用方注入（不 import electron）：这层要能在纯 node 环境里单测，
 * 将来整个 ca/ 搬进 utilityProcess 时换个来源即可。
 */
import {randomBytes} from 'node:crypto';
import type {FileHandle} from 'node:fs/promises';
import {chmod, mkdir, open, readdir, readFile, rename, stat, unlink} from 'node:fs/promises';
import {join} from 'node:path';

import type {CertificateAuthority, CertificateInfo, LeafMaterial, LeafRequest} from './types';
import {CertificateError} from './types';
import type {RootCa} from './x509';
import {createLeafCertificate, createRootCa, exportPrivateKeyPem, rootCaFromPem, toCertificateInfo} from './x509';

/** 根证书的文件名。安装引导、导出功能都从这里取，避免各处自己拼字符串拼岔 */
export const CA_CERT_FILE_NAME = 'ca.pem';

/** 根私钥的文件名。和证书分开两个文件：证书是要交给用户的，私钥绝不能跟着走 */
export const CA_KEY_FILE_NAME = 'ca.key';

/** 目录 0700 / 私钥 0600：同机其他用户不该看得见根私钥 */
const DIR_MODE = 0o700;
const KEY_FILE_MODE = 0o600;
/** 证书是公开信息，随常规文件的权限 */
const CERT_FILE_MODE = 0o644;

/**
 * mode 位只在 POSIX 平台有真实语义。
 * Windows 的 stat 返回的是合成值（普通文件基本是 0666），照着它做权限检查
 * 只会得到假阳性、并把警告刷满日志；那边的访问控制归 NTFS ACL 管，不在这一层。
 */
const POSIX_FILE_MODES = process.platform !== 'win32';

/**
 * LRU 容量。
 * 512 个域名足够覆盖一次会话里的常用站点；每条缓存只是两段 PEM 文本，
 * 内存开销可忽略。
 */
export const DEFAULT_LEAF_CACHE_SIZE = 512;

/**
 * 超过这个年龄的临时文件视为硬崩溃残留。
 *
 * 活跃写入的临时文件只活毫秒级；而 open 与 rename 之间被 SIGKILL 留下的那份
 * 里是**私钥明文**，不该一直躺在用户目录里。阈值取得远大于任何真实写入，
 * 是为了绝不错删一个别处正在写盘的文件（宁可让垃圾多留一小时，也不能把
 * 并发写入写到一半的文件抽走）。
 */
const STALE_TMP_MAX_AGE_MS = 60 * 60 * 1000;

const escapeForRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 临时文件命名规则：<文件名>.<pid>.<随机 hex>.tmp，与 writeFileAtomic 里拼的保持一致 */
const TMP_FILE_PATTERN = new RegExp(
  `^(?:${escapeForRegExp(CA_CERT_FILE_NAME)}|${escapeForRegExp(CA_KEY_FILE_NAME)})\\.\\d+\\.[0-9a-f]+\\.tmp$`
);

/** 一次底层签发的产物。是否命中缓存是上层的事，不往下掺杂 */
export type IssuedLeafMaterial = Omit<LeafMaterial, 'cached'>;

/**
 * 底层签发函数。默认走 x509.ts；测试注入假实现来数"到底签了几次"。
 * 这层抽象存在的唯一理由是让 in-flight 去重可被观测 —— 否则"并发只签一次"
 * 只能靠读代码相信。
 */
export type LeafIssuer = (request: LeafRequest) => Promise<IssuedLeafMaterial>;

export interface CertificateAuthorityOptions {
  /** CA 文件的落盘目录，由宿主注入 */
  baseDir: string;
  /** 写进根证书 CN 的机器名，默认本机 hostname */
  hostname?: string;
  /** 时钟，测试注入以获得确定的时间断言 */
  now?: () => Date;
  /** LRU 容量，默认 DEFAULT_LEAF_CACHE_SIZE；测试调小以验证淘汰顺序 */
  cacheSize?: number;
  /** 底层签发实现，默认走 x509.ts */
  issue?: LeafIssuer;
}

const toMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * 缓存键 = host + isIp。
 *
 * 带上 isIp 的理由：同一个字符串在 dns / ip 两种解读下会签出不同的 SAN，
 * 混用会让"某次调用把标志传错了"这个错误被缓存固化，之后一直错下去。
 * 这里不做 host 归一化 —— 那是主流程里另一个模块的职责，本层如实使用。
 */
const leafCacheKeyOf = (request: LeafRequest): string =>
  `${request.isIp ? 'ip' : 'dns'}\u0000${request.host}`;

/**
 * 读文件；只有 ENOENT 才返回 null。
 *
 * 关键在"只有"：EACCES / EIO 之类的失败如果也被当成"文件不存在"，接下来就是
 * 重新生成 —— 把用户已经装进系统的根证书覆盖掉，这是本模块最不能发生的事。
 * 宁可把错误原样抛出去，让用户看见真正的问题。
 */
const readIfExists = async (filePath: string): Promise<string | null> => {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

/**
 * 删文件；只有 ENOENT 当成功（本来就不在 = 目的已经达成）。
 * EACCES / EIO 之类的失败原样上抛：宁可启动时报错，也不带着不确定的磁盘状态硬写。
 */
const unlinkIfExists = async (filePath: string): Promise<void> => {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
};

/**
 * 原子写文件：先写同目录下的临时文件，fsync 之后再 rename 顶上。
 *
 * 为什么要这么绕：直接写目标文件的话，进程在任何一刻被杀，用户目录里就留下
 * 半个文件 —— 私钥文件写了一半尤其糟，它看起来"存在"，加载时才发现是坏的。
 * rename 在同目录内是原子的：盘上要么是完整的旧内容，要么是完整的新内容。
 */
const writeFileAtomic = async (filePath: string, content: string, mode: number): Promise<void> => {
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;

  let handle: FileHandle | null = await open(tmpPath, 'wx', mode);
  try {
    await handle.writeFile(content, 'utf8');
    // umask 会削减 open 时给的 mode，这里显式再设一次（私钥必须真的是 0600）
    await handle.chmod(mode);
    // 先 fsync 再 rename：否则断电后 rename 出来的可能是一个"空壳"文件。
    // 目录本身不 fsync —— 代价远大于收益，真丢了也只是下次启动重新生成
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tmpPath, filePath);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(tmpPath).catch(() => undefined);
    throw error;
  }
};

/** 建目录并保证权限不比 0700 宽（只收紧、不放宽） */
const ensureDirectory = async (dirPath: string): Promise<void> => {
  await mkdir(dirPath, { recursive: true, mode: DIR_MODE });
  if (!POSIX_FILE_MODES) return;

  const info = await stat(dirPath);
  // mkdir 的 mode 会被 umask 削，已存在的目录更是原样保留 —— 两种情况下目录都
  // 可能比预期更开放，而私钥就住在里面。任何 group/other 位存在就收回 0700；
  // 本来就比 0700 更严（比如用户自己设了 0500）则不动它
  if ((info.mode & 0o077) !== 0) await chmod(dirPath, DIR_MODE);
};

/** 私钥权限必须收在 0600：被改宽了就修回去 */
const ensurePrivateKeyMode = async (keyPath: string): Promise<void> => {
  if (!POSIX_FILE_MODES) return;

  const info = await stat(keyPath);
  const mode = info.mode & 0o777;
  if ((mode & 0o077) === 0) return;

  // 选择"修回来"而不是"拒绝加载"：拒绝会让应用直接起不来，而用户手上那份
  // 已经装进系统的根证书正等着这份私钥配合；修复只把权限收回，密钥本身没变
  console.error(
    `[Reqeek] CA 私钥权限是 ${mode.toString(8)}（同机其他用户可见），已修回 ${KEY_FILE_MODE.toString(8)}：${keyPath}`
  );
  await chmod(keyPath, KEY_FILE_MODE);
};

/** 清掉硬崩溃留下的临时文件。尽力而为，但绝不误删刚写的 */
const removeStaleTempFiles = async (baseDir: string): Promise<void> => {
  const entries = await readdir(baseDir);
  const now = Date.now();

  await Promise.all(
    entries
      .filter((name) => TMP_FILE_PATTERN.test(name))
      .map(async (name) => {
        const tmpPath = join(baseDir, name);
        try {
          const info = await stat(tmpPath);
          if (now - info.mtimeMs < STALE_TMP_MAX_AGE_MS) return;
          await unlink(tmpPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      })
  );
};

/**
 * 加载磁盘上已有的根 CA。
 * 返回 null = 磁盘上没有（或只剩一半），可以生成新的；抛错 = 有，但不能用。
 */
const loadRootCa = async (certPath: string, keyPath: string): Promise<RootCa | null> => {
  const [certificatePem, privateKeyPem] = await Promise.all([
    readIfExists(certPath),
    readIfExists(keyPath)
  ]);

  if (!certificatePem && !privateKeyPem) return null;

  if (!certificatePem || !privateKeyPem) {
    // 只剩一半 = 崩溃残骸，或用户手动删了一个。单独任何一个都签不出 leaf，
    // 这份残骸也不可能真的在为用户服务（装进系统的只有证书，但没有私钥的
    // 证书一次握手都完不成），所以重建不会作废任何还能用的东西
    console.error(
      `[Reqeek] CA 文件不完整（缺 ${certificatePem ? CA_KEY_FILE_NAME : CA_CERT_FILE_NAME}），将重新生成：${keyPath}`
    );
    return null;
  }

  await ensurePrivateKeyMode(keyPath);

  try {
    return await rootCaFromPem(certificatePem, privateKeyPem);
  } catch (error) {
    // 带上路径：用户要能知道该去看哪个目录（很可能需要手动处理），
    // 而不是对着一句"私钥不匹配"发愣
    throw new CertificateError(`加载已存在的根 CA 失败（${certPath}）：${toMessage(error)}`);
  }
};

interface CreateRootCaOptions {
  certPath: string;
  keyPath: string;
  hostname?: string;
  now: Date;
}

const createAndPersistRootCa = async (options: CreateRootCaOptions): Promise<RootCa> => {
  const rootCa = await createRootCa({ hostname: options.hostname, now: options.now });
  const certificatePem = rootCa.certificate.toString('pem');
  const privateKeyPem = await exportPrivateKeyPem(rootCa.privateKey);

  // 写序分两步，崩溃安全就靠它：
  //
  // 1. 先删掉旧的两份（走到这里时旧文件最多只剩一个残骸，单独任何一个都签不出
  //    leaf，删掉不会作废任何还能用的东西）。**必须先删**：直接覆盖「有 cert
  //    无 key」的残骸会先 rename 新 key，经过一瞬「旧 cert + 新 key」；此刻被
  //    SIGKILL，下次启动看到的就是"两个都在但不配对"——那是被明确设计为**拒绝
  //    启动**的形态，一次本可自动恢复的残骸就此升级成需要人工介入的故障。
  // 2. 再按「先私钥、后证书」落新文件：这样任何崩溃点留下的都只会是「什么都没有」
  //    或「有 key 无 cert」，两者都落在 loadRootCa 的自动重建分支里 —— 磁盘上
  //    任何时刻都保持"有 ca.pem 必有配套私钥"。
  await unlinkIfExists(options.certPath);
  await unlinkIfExists(options.keyPath);
  await writeFileAtomic(options.keyPath, privateKeyPem, KEY_FILE_MODE);
  await writeFileAtomic(options.certPath, certificatePem, CERT_FILE_MODE);

  return rootCa;
};

/**
 * 建一个证书权威：加载已有的根 CA，没有就生成并落盘。
 *
 * 返回的实例持有 CA 私钥的内存引用，getLeaf 的缓存与去重都挂在它身上；
 * 进程内应当只保留一份（用 getCertificateAuthority），用完 dispose。
 *
 * 单写者假设：同一个 baseDir 同一时刻只由一个进程初始化（app 层用
 * requestSingleInstanceLock 保证，见 src/main/index.ts），所以首次生成不做
 * 跨进程互斥。哪天要允许两个进程共用同一个目录，必须在这里补上真正的互斥协议，
 * 而不是顺手加个锁文件 —— 过期锁会把"偶发竞态"换成"重启后起不来"，更糟。
 */
export const createCertificateAuthority = async (
  options: CertificateAuthorityOptions
): Promise<CertificateAuthority> => {
  const { baseDir } = options;
  const now = options.now ?? ((): Date => new Date());

  await ensureDirectory(baseDir);
  await removeStaleTempFiles(baseDir);

  const certPath = join(baseDir, CA_CERT_FILE_NAME);
  const keyPath = join(baseDir, CA_KEY_FILE_NAME);

  const initial =
    (await loadRootCa(certPath, keyPath)) ??
    (await createAndPersistRootCa({ certPath, keyPath, hostname: options.hostname, now: now() }));

  // dispose 之后这里会被置空：所有签发都必须经过这个引用，绝不另存一份私钥副本，
  // 否则 dispose 就只是个摆设
  let material: RootCa | null = initial;

  const root: CertificateInfo = await toCertificateInfo(initial.certificate);

  const issue: LeafIssuer =
    options.issue ??
    (async (request) => {
      const current = material;
      if (!current) {
        throw new CertificateError(
          '证书权威已 dispose：内存里不再持有 CA 私钥，需要重新创建实例才能签发'
        );
      }

      const leaf = await createLeafCertificate({
        host: request.host,
        isIp: request.isIp,
        issuer: current,
        now: now()
      });
      return { key: leaf.privateKeyPem, cert: leaf.certificate.toString('pem') };
    });

  const capacity = options.cacheSize ?? DEFAULT_LEAF_CACHE_SIZE;
  const cache = new Map<string, IssuedLeafMaterial>();
  const inFlight = new Map<string, Promise<IssuedLeafMaterial>>();

  /**
   * dispose 一旦发生就置 true，永不回退。
   * 存在的唯一理由是拦住「跨 dispose 的在途签发」：那个任务的 .then 会晚于 dispose
   * 执行，没有这个标志就会把结果回填进已经清空的缓存（见 getLeaf 里的检查）。
   */
  let disposed = false;

  /**
   * LRU 直接用 Map 的迭代顺序实现：Map 按键的插入顺序迭代，所以"命中时删了再插"
   * 就是移到队尾，队尾最近使用、队首最久未用。删除和插入都是 O(1)，
   * 不必再维护一条双向链表。
   */
  const remember = (key: string, leaf: IssuedLeafMaterial): void => {
    cache.delete(key);
    cache.set(key, leaf);

    if (cache.size <= capacity) return;
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  };

  /**
   * 取一份 leaf。
   *
   * cached 的语义统一为「这次调用有没有走到复用这条路」：命中已完成缓存，
   * 或者 join 到一次正在进行的签发，都算复用（这张证书不是为它签的）；
   * 只有真正自己发起签发的那一次是 false。这样 types.ts 里
   * 「观测缓存到底有没有起作用」才能在并发场景下也读得出来。
   */
  const getLeaf = async (request: LeafRequest): Promise<LeafMaterial> => {
    const key = leafCacheKeyOf(request);

    const hit = cache.get(key);
    if (hit) {
      // 命中也要 remember 一次：把它挪到队尾，否则 LRU 会把刚用过的条目先淘汰掉
      remember(key, hit);
      return { ...hit, cached: true };
    }

    const pending = inFlight.get(key);
    if (pending) {
      // 同一个 host 正在签：等同一份结果。并发发起 N 次，底层只落一次笔。
      // 对调用方来说这就是复用：它没有让底层多签一次
      return { ...(await pending), cached: true };
    }

    const task = issue(request)
      .then((leaf) => {
        // 在途签发可能跨过一次 dispose：结果绝不能回填，否则同一个 host 反而能
        // 命中一个"已被释放"的私钥（其他 host 却一律报 dispose 错误，行为不一致），
        // 而且 dispose 声称放掉的那份私钥引用仍然可达
        if (!disposed) remember(key, leaf);
        return leaf;
      })
      .finally(() => {
        // 成败都要清：失败的去重项留在表里，后续请求会被永远钉在同一个 rejected
        // promise 上 —— 一次瞬时故障就变成"这个域名再也签不出证书"。
        // 只删自己那一项：期间可能已经有新一轮请求往表里放了新的 promise
        if (inFlight.get(key) === task) inFlight.delete(key);
      });

    inFlight.set(key, task);

    return { ...(await task), cached: false };
  };

  const dispose = (): void => {
    // 只放掉内存引用；磁盘上的文件是用户系统信任的锚点，任何情况下都不在这里删
    material = null;
    disposed = true;
    cache.clear();
    inFlight.clear();
  };

  return { root, certPath, getLeaf, dispose };
};

/**
 * 进程内单例：CA 私钥只该有一份内存引用，重复初始化既没意义也不安全。
 * 并发调用共享同一个初始化 Promise，只建一次。
 */
let sharedAuthority: Promise<CertificateAuthority> | null = null;

/**
 * 取进程内共享的证书权威。
 *
 * 初始化失败**不留毒丸**：失败的 Promise 不能一直挂在单例上，否则一次瞬时失败
 * （磁盘短暂不可写之类）会让整个进程余生都拿到同一个失败，用户只能重启应用。
 */
export const getCertificateAuthority = (
  options: CertificateAuthorityOptions
): Promise<CertificateAuthority> => {
  sharedAuthority ??= createCertificateAuthority(options).catch((error: unknown) => {
    sharedAuthority = null;
    throw error;
  });
  return sharedAuthority;
};

/** 释放单例（应用退出时调用）。下次 getCertificateAuthority 会重新从磁盘加载 */
export const disposeCertificateAuthority = async (): Promise<void> => {
  const pending = sharedAuthority;
  sharedAuthority = null;
  if (!pending) return;

  // 初始化本身就失败过的话，这里没有东西需要释放（也不能把它的失败再抛一次，
  // 退出路径不该被一个早就报过的错打断）
  const authority = await pending.catch(() => null);
  authority?.dispose();
};
