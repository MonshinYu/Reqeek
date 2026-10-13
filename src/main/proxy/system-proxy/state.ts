import {randomBytes, randomUUID} from 'node:crypto';
import type {FileHandle} from 'node:fs/promises';
import {mkdir, open, readdir, readFile, rename, stat, unlink} from 'node:fs/promises';
import {join} from 'node:path';
import type {PersistedSystemProxyState, ProxyEntry, ProxyKind, ProxySnapshot, WriteOwnership} from './types';

/**
 * 系统代理写入状态的落盘。
 *
 * 为什么要落盘：只放内存里的"改过什么、原样是什么"活不过一次崩溃，下次启动
 * 一旦不知道原样，就只能把系统代理盲目关掉 —— 那正是会抹掉用户 bypass 列表的
 * 做法。这份文件是用户原始配置的唯一副本，所以本模块每条路径都围绕
 * "盘上要么是完整的旧状态、要么是完整的新状态"来设计。
 *
 * 目录由调用方注入（不 import electron）：这一层要能在纯 node 环境里单测，
 * 也要能被将来的 utilityProcess 直接复用。
 *
 * 所有权模型：盘上状态同一时刻只属于一个主人（pid + token）。自己的记录随便写；
 * 别人的记录只有一条正道 —— 先 restore（快照的使命是还原）、再 adopt() 接管。
 * 任何"直接覆盖别人记录"的路径都被门禁挡住：盖掉的可能是系统正被改着时留下的
 * 原始配置唯一副本。
 */

/** 状态文件名。读写双方都从这里取，避免两边各自拼字符串拼岔 */
export const STATE_FILE_NAME = 'system-proxy-state.json';

/**
 * 落盘格式的版本。读到别的值一律当损坏处理 ——
 * 未来格式的迁移是未来代码的事，现在的代码去猜只会猜错。
 */
const STATE_VERSION = 1;

/** 状态里有用户的代理配置，目录 0700 / 文件 0600 不给同机其他用户看 */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * 超过这个年龄的临时文件视为硬崩溃残留。
 *
 * 活跃写入者的临时文件只活毫秒级，正常路径永远碰不到这个阈值；而 SIGKILL /
 * 断电在 open 与 rename 之间留下的那份 tmp 含用户代理配置的快照明文，没人清
 * 它就会一直躺在用户目录里。阈值取得远大于任何真实写入，是为了绝不错删一个
 * 正在写盘的文件（宁可让垃圾多留一小时，也不能让并发写入写到一半被抽走）。
 */
const STALE_TMP_MAX_AGE_MS = 60 * 60 * 1000;

const PROXY_KINDS: readonly ProxyKind[] = ['web', 'secureWeb', 'socks', 'pac'];

/** 临时文件命名规则：<状态文件名>.<pid>.<随机 hex>.tmp，与 persist 里拼的保持一致 */
const TMP_FILE_PATTERN = new RegExp(
  `^${STATE_FILE_NAME.replace(/\./g, '\\.')}\\.\\d+\\.[0-9a-f]+\\.tmp$`
);

/**
 * 所有权不符时抛出。
 *
 * 单独一个类型是为了让调用方能区分"你无权动这条记录"（协调问题：该先接管再写）
 * 和"磁盘出错了"（重试或上报用户），这两种情况的处理方式完全不同。
 */
export class StateOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateOwnershipError';
  }
}

/**
 * 状态在盘上但读不出来（IO 失败 / JSON 损坏 / 字段不合法）时抛出。
 *
 * 为什么和"没有记录"分开：文件不存在是合法状态（首次运行），而读失败或损坏是
 * 异常状态 —— 塌缩成 null 会被 clear 当成"没有记录可保护"直接覆盖成墓碑，把
 * 一份可能属于别的进程、正等着被恢复的记录连同它的字节一起抹掉。
 * 损坏只能由知情的人处理（备份/删除后重来），代码不许替用户猜。
 */
export class StateCorruptError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StateCorruptError';
  }
}

/**
 * 写入前的参数校验失败时抛出：调用方（多半是 driver）递来了不合法的值。
 *
 * 单独一个类型是为了让调用方能区分"这次写入的参数不对"（代码 bug，当场要修）
 * 和"盘上记录不是自己的"（协调问题，走 adopt）以及"磁盘出错了"（重试）。
 */
export class StateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateValidationError';
  }
}

/**
 * 生成本次进程的所有权证明。
 *
 * 一个进程生命周期里只该生成一次，之后传给所有写入/清理路径 ——
 * 每调一次就换 token 的话，同一个进程自己写下的记录自己都认领不回来。
 */
export const createOwnership = (): WriteOwnership => ({
  pid: process.pid,
  token: randomUUID(),
  startedAt: Date.now()
});

/**
 * 判定一条落盘状态是不是这份所有权写下的。
 *
 * pid 和 token 必须**同时**对上：
 * - 只看 pid：系统会复用 PID，重启后可能把别人（或自己上一轮）的记录认成自己的
 * - 只看 token：同一个进程换了 token 就认不出自己的记录
 * 两个都看，才同时覆盖"是同一个进程"和"是同一段生命周期"。
 */
export const isOwnedBy = (state: PersistedSystemProxyState, ownership: WriteOwnership): boolean =>
  state.owner.pid === ownership.pid && state.owner.token === ownership.token;

/**
 * 只有 committed 阶段的快照才允许拿去还原。
 *
 * - intent：快照记下了但系统还没被改 —— 照它还原等于用一份从未生效的状态去覆盖
 *   用户在这个窗口里自己做的代理修改
 * - cleared：已经还原过，快照作废
 * - committed 但 snapshot 为 null：不构成合法组合，同样不能还原（这种文件在
 *   load 时已按损坏拒收，这个条件兜住内存里直接构造出来的值）
 *
 * 写成类型谓词而不是裸 boolean：调用方拿到 true 就能直接取 snapshot，
 * 不用再补一次 null 断言。
 */
export const canRestore = (
  state: PersistedSystemProxyState | null
): state is PersistedSystemProxyState & { phase: 'committed'; snapshot: ProxySnapshot } =>
  state !== null && state.phase === 'committed' && state.snapshot !== null;

// ---------------------------------------------------------------- 运行时校验
// load() 拿到的永远是外部字节：可能是写到一半崩溃留下的、被手工改坏的、旧版本
// 遗留的。逐字段校验而不是 as —— 这些值接下来会被拼进 networksetup / 注册表的
// 写入命令，字段类型错了不是"类型问题"，是会真写坏用户系统配置的。

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 从 catch 到的错误里取 errno code（readFile 的 ENOENT 是唯一合法的"没有记录"） */
const errorCode = (error: unknown): string | undefined => {
  if (!isRecord(error)) return undefined;
  const { code } = error;
  return typeof code === 'string' ? code : undefined;
};

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** NaN、Infinity 和小数在这里一并挡掉：它们过不了任何一次真实写入 */
const isIntegerInRange = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

const isOwnershipShape = (value: unknown): value is WriteOwnership =>
  isRecord(value) &&
  isIntegerInRange(value.pid, 1, Number.MAX_SAFE_INTEGER) &&
  typeof value.token === 'string' &&
  value.token.length > 0 &&
  isIntegerInRange(value.startedAt, 0, Number.MAX_SAFE_INTEGER);

const isProxyEntryShape = (value: unknown): value is ProxyEntry =>
  isRecord(value) &&
  typeof value.enabled === 'boolean' &&
  typeof value.host === 'string' &&
  isIntegerInRange(value.port, 0, 65535);

const isProxySnapshotShape = (value: unknown): value is ProxySnapshot => {
  if (!isRecord(value)) return false;
  if (typeof value.target !== 'string') return false;
  if (!isIntegerInRange(value.capturedAt, 0, Number.MAX_SAFE_INTEGER)) return false;
  if (!Array.isArray(value.bypassDomains)) return false;
  if (!value.bypassDomains.every((domain) => typeof domain === 'string')) return false;

  const entries = value.entries;
  if (!isRecord(entries)) return false;
  // 四个 ProxyKind 一个都不能少：缺项的快照拿去还原，等于在那类代理上留空，
  // 而"还原时漏掉一项"和"本来就没有这一项"在系统里长得一模一样
  return PROXY_KINDS.every((kind) => isProxyEntryShape(entries[kind]));
};

const isPersistedStateShape = (value: unknown): value is PersistedSystemProxyState => {
  if (!isRecord(value)) return false;
  if (value.version !== STATE_VERSION) return false;
  if (value.phase !== 'intent' && value.phase !== 'committed' && value.phase !== 'cleared') {
    return false;
  }
  if (!isOwnershipShape(value.owner)) return false;
  // 只有 cleared 允许没有快照。committed + null 是"阶段说谎"：声称可还原却没有
  // 快照；intent + null 同理记不下原样 —— 都不能当成可用记录放过去，否则阶段
  // 字段本身就失去意义（这正是"clear 后迟到的 commit"写出来的形状）。
  if (value.phase === 'cleared')
    return value.snapshot === null || isProxySnapshotShape(value.snapshot);
  return value.snapshot !== null && isProxySnapshotShape(value.snapshot);
};

/**
 * 写入前的自校验：与读取侧用**同一组**判别函数，"写得进去"和"读得回来"永远
 * 是同一套标准。
 *
 * 为什么必须在这里大声失败：driver 递来的值（port 越界、空 token、缺一项
 * entries……）如果原样落盘，这一次写入看起来完全成功，直到下一次 load() 才
 * 判损坏 —— 崩溃恢复时那份快照就静默没了，而它是用户原始配置的唯一副本。
 * 宁可让 bug 在写入调用处当场暴露，也不留一颗下次启动才炸的雷。
 */
const assertWritable = (next: PersistedSystemProxyState): void => {
  if (next.phase !== 'cleared' && next.snapshot === null) {
    throw new StateValidationError(
      `拒绝写入系统代理状态：phase=${next.phase} 却没有快照（只有 cleared 允许空快照）`
    );
  }
  if (!isOwnershipShape(next.owner)) {
    throw new StateValidationError(
      '拒绝写入系统代理状态：ownership 不合法（pid/startedAt 需为有效整数，token 不能为空）'
    );
  }
  if (next.snapshot !== null && !isProxySnapshotShape(next.snapshot)) {
    throw new StateValidationError(
      '拒绝写入系统代理状态：快照不合法（target / 四个 entries / bypassDomains / capturedAt 与落盘格式不符）'
    );
  }
};

/**
 * adopt() 的显式声明。
 *
 * 接管会把快照作废，所以前提只剩一条：调用方已经用这条记录完成系统还原（或确认
 * 无需还原）。这件事进程内无法验证，就用签名逼调用方显式写出来 ——
 * `restored: true` 是个字面量类型，顺手传个变量或漏写都过不了编译；
 * 运行时也会再挡一道，防止 JS 调用方绕过类型。
 */
export interface AdoptOptions {
  /** 调用方声明：已用这条记录的快照完成还原（或确认无需还原）。错报 = 快照被作废而系统仍指向本地代理 */
  restored: true;
}

export interface SystemProxyStateStore {
  /**
   * 读回落盘状态。
   *
   * - 文件不存在 → null（首次运行是合法状态，绝不抛）
   * - 读不动 / JSON 损坏 / 字段不合法 → 抛 StateCorruptError
   *
   * 两者必须分开：把"损坏"当成"没有"，会让 clear 在所有权检查缺位的情况下
   * 覆盖掉一份可能还属于别人的记录。
   */
  load: () => Promise<PersistedSystemProxyState | null>;
  /**
   * 记下"打算改"和原始快照。必须在动系统之前完成，否则崩溃后原样无从追溯。
   *
   * 盘上已有不属于本 ownership 的记录时**拒绝**（StateOwnershipError）：
   * 那条记录里可能是"系统正被改着"的原始配置唯一副本。要接管它，先 restore，
   * 再 adopt()。
   */
  beginWrite: (snapshot: ProxySnapshot, ownership: WriteOwnership) => Promise<void>;
  /** 系统已按快照改完，把阶段推进到 committed。记录里没有快照时拒绝（不许写出"阶段说谎"的记录） */
  commit: (ownership: WriteOwnership) => Promise<void>;
  /** 系统已还原，标记 cleared，快照作废。任何情况下都先校验所有权，读不动/损坏时拒绝而不是覆盖 */
  clear: (ownership: WriteOwnership) => Promise<void>;
  /**
   * 显式接管一条不属于自己的记录（崩溃后由新进程恢复的唯一正道）。
   *
   * 顺序永远是：先 driver.restore（用这条记录里的快照把系统还原），再
   * adopt(ownership, { restored: true }) —— 接管会换主并把快照作废，之后
   * 本进程的 beginWrite / commit / clear 才走得通。
   */
  adopt: (ownership: WriteOwnership, options: AdoptOptions) => Promise<void>;
}

/**
 * 创建状态存储。
 *
 * 目录**懒创建**（第一次写的时候才 mkdir）：load() 是崩溃恢复路径的第一步，
 * 在一台从没运行过 Reqeek 的机器上它必须安静地返回 null，
 * 而不是因为"目录不存在"再崩一次。
 */
export const createStateStore = (dir: string): SystemProxyStateStore => {
  const filePath = join(dir, STATE_FILE_NAME);

  // 写操作串行化。commit / clear 都是"读-改-写"，两条同时跑会互相盖：
  // clear 刚写完 cleared，一条早先发起、手里还攥着旧记录的 commit 会把 phase
  // 改回 committed 并带回旧快照，盘上就出现"明明已还原、却仍能还原"的假状态。
  // 多条退出路径有可能同时触发，这件事不能指望调用方自觉。
  let tail: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const result = tail.then(task);
    // 队列尾巴不能因为某次失败断掉（否则后续写入全被卡死），失败原样由 result
    // 抛给真正的调用方，尾巴自己换成一条吞掉结果的链
    tail = result.catch(() => undefined);
    return result;
  };

  /**
   * 清理硬崩溃残留的临时文件。
   *
   * persist 的失败路径只覆盖"进程还活着"的情况；SIGKILL / 断电发生在 open 与
   * rename 之间时，那份含用户代理配置快照明文的 tmp 就没人收了。每次 load()
   * 顺手扫一遍本目录即可覆盖：下一次启动就是清理时机。
   *
   * 只按 mtime 判定、不按 pid：PID 会被复用，而且没有可移植的办法判断"那个 pid
   * 还活着"；阈值远大于任何正常写入的存活时间，正在写盘的进程不会被误伤。
   * 这是卫生工作而非正确性路径，任何失败都吞掉（清不掉的垃圾不该再断一条恢复路径）。
   */
  const sweepStaleTmpFiles = async (): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return; // 目录不存在（首次运行）或读不动：没有可清理的东西
    }
    const now = Date.now();
    await Promise.all(
      names
        .filter((name) => TMP_FILE_PATTERN.test(name))
        .map(async (name) => {
          const tmpPath = join(dir, name);
          try {
            const info = await stat(tmpPath);
            if (now - info.mtimeMs <= STALE_TMP_MAX_AGE_MS) return;
            await unlink(tmpPath);
          } catch {
            // 与别的清理者抢同一个文件、权限不足……都不值得打断恢复流程
          }
        })
    );
  };

  /**
   * rename 之后 fsync 所在目录，让目录项（新文件名）本身也落盘。
   *
   * 只 fsync 文件保证的是"数据块"落盘；rename 改的是目录里的条目，断电时条目
   * 可能还留在缓存里 —— 恢复出来读到的还是旧文件。macOS / Linux 都能对目录拿
   * fd 做 fsync（darwin 上实测 open(dir)+fsync 成功），所以这里真的做，而不是
   * 只嘴上说防断电。Windows 打不开目录句柄，个别文件系统也会报 EINVAL/ENOTSUP
   * —— 那些平台上放弃这一步：数据块已经 fsync 过，最坏是断电后回退到旧状态，
   * 而不是留下半截写坏的文件。
   */
  const syncDirectory = async (): Promise<void> => {
    if (process.platform === 'win32') return;
    let handle: FileHandle | null = null;
    try {
      handle = await open(dir, 'r');
      await handle.sync();
    } catch {
      // 尽力而为：目录 fsync 失败不能反过来把一次已经成功的写入变成失败
    } finally {
      if (handle !== null) await handle.close().catch(() => undefined);
    }
  };

  /**
   * 原子落盘：先写同目录的临时文件，fsync 之后再 rename 覆盖目标，最后 fsync 目录。
   *
   * 直接 writeFile 目标文件的话，写到一半崩溃就留下半截 JSON，而这份状态是用户
   * 原始代理配置的唯一副本，读不回来等于永久丢失。rename 在同一文件系统内是原子
   * 的，任何时刻读到的要么是完整旧内容、要么是完整新内容。
   */
  const persist = async (next: PersistedSystemProxyState): Promise<void> => {
    // 写入侧校验先于一切：非法值连临时文件都不该产生
    assertWritable(next);

    // 序列化放在创建临时文件之前：快照不可序列化时（理论上不该发生）连临时文件
    // 都不会产生
    const payload = `${JSON.stringify(next, null, 2)}\n`;

    // mode 只在目录**被创建**时生效；已存在的目录不动权限 ——
    // 传进来的可能是调用方自己的目录（如 userData），改它的权限是越界
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
    // 临时文件必须和目标同目录：跨目录 / 跨文件系统的 rename 不保证原子
    const tmpPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;

    let handle: FileHandle | null = null;
    try {
      handle = await open(tmpPath, 'w', FILE_MODE);
      await handle.writeFile(payload, 'utf8');
      // rename 之前必须 fsync：否则系统崩溃后可能出现"文件名已更新、内容是空的"
      // ——那既不是旧状态也不是新状态，是一份谁都读不出来的垃圾
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(tmpPath, filePath);
      // rename 之后 fsync 目录：上面那次 fsync 管的是内容，新文件名本身靠这一次
      // 才落盘（否则断电后可能回退到旧名字，见 syncDirectory 注释）
      await syncDirectory();
    } catch (error) {
      if (handle !== null) await handle.close().catch(() => undefined);
      // 失败路径也要把临时文件收干净，不然每崩一次就在用户目录里留一颗垃圾
      await unlink(tmpPath).catch(() => undefined);
      throw error;
    }
  };

  const load = async (): Promise<PersistedSystemProxyState | null> => {
    // 清理先于读取：即使这次读到的是损坏文件（下面会抛），崩溃留下的 tmp
    // 也已经处理掉了 —— 清理不该依赖主状态可读
    await sweepStaleTmpFiles();

    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (error) {
      // 只有 ENOENT 才是"合法地没有记录"；其余读失败（权限、被占成目录……）
      // 都是异常状态，不能塌缩成"没有"让调用方接着覆盖写
      if (errorCode(error) === 'ENOENT') return null;
      throw new StateCorruptError(`系统代理状态读取失败（${filePath}）：${describeError(error)}`, {
        cause: error
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new StateCorruptError(`系统代理状态不是合法 JSON（${filePath}）`, { cause: error });
    }

    if (!isPersistedStateShape(parsed)) {
      throw new StateCorruptError(`系统代理状态字段不合法（${filePath}）`);
    }
    return parsed;
  };

  /**
   * commit / clear / adopt 遇到所有权不符时**抛错**，不返回 false。
   *
   * 为什么选抛错：这几个操作是"我们究竟对系统做过什么"的账本，调用方一旦漏看
   * 返回值（最典型的就是 void 掉一个 Promise），就会以为账已经记好；而漏记的
   * 后果是崩溃恢复时找不到该还原的快照 —— 正是本模块要防的数据丢失。抛错没有
   * "看了却没处理"的中间状态；磁盘 IO 失败本来就会抛，两条错误路径统一成一条，
   * 调用方不必既 try/catch 又检查返回值。
   *
   * 调用方若确实要接管一条不属于自己的记录（崩溃后由新进程恢复），正确做法是
   * adopt()：先 restore，再换主。**绝不要**用 beginWrite 覆盖别人的记录 ——
   * 那条路径会把对方尚未还原的快照（用户原始配置的唯一副本）整个盖掉，接管方
   * 再崩溃，原配置就永久没了。
   */
  const assertOwned = (
    state: PersistedSystemProxyState,
    ownership: WriteOwnership,
    action: string
  ): void => {
    if (isOwnedBy(state, ownership)) return;
    throw new StateOwnershipError(
      `拒绝${action}系统代理状态：记录属于 pid ${state.owner.pid}，调用方是 pid ${ownership.pid}`
    );
  };

  const beginWrite = (snapshot: ProxySnapshot, ownership: WriteOwnership): Promise<void> =>
    enqueue(async () => {
      const existing = await load();
      // 所有权门禁：盘上已有一条别人的记录时拒绝覆盖。那条记录可能是
      // committed 的 —— 系统正指向本地代理、原始配置只存在于它的快照里；
      // 直接盖掉再崩溃，用户原配置就永久丢失。接管走 adopt()（先 restore 再换主）
      if (existing !== null && !isOwnedBy(existing, ownership)) {
        throw new StateOwnershipError(
          `拒绝写入系统代理状态：盘上已有 pid ${existing.owner.pid} 的记录（阶段 ${existing.phase}）。` +
            '要接管它，请先完成还原再调用 adopt()'
        );
      }
      await persist({ version: STATE_VERSION, phase: 'intent', snapshot, owner: ownership });
    });

  const commit = (ownership: WriteOwnership): Promise<void> =>
    enqueue(async () => {
      const state = await load();
      if (state === null) {
        // 没有记录可提交：说明调用方跳过了 beginWrite，或记录刚被别的路径清掉。
        // 静默通过的话，"系统改了、盘上没账"这种最坏状态会无声成立 ——
        // 崩溃恢复时谁也说不清该还原成什么
        throw new Error('系统代理状态提交失败：盘上没有可提交的记录');
      }
      assertOwned(state, ownership, '提交');
      if (state.snapshot === null) {
        // 记录已被 clear（快照作废）。放行的话会写出 committed + snapshot:null——
        // 一条"声称能还原却没有快照"的谎，下一次 load 只能把它当损坏或误信它
        throw new Error(
          '系统代理状态提交失败：记录里没有可提交的快照（是否已经还原并 clear 过？）'
        );
      }
      // 快照与 owner 原样保留：commit 只推进阶段，不改内容
      await persist({
        version: STATE_VERSION,
        phase: 'committed',
        snapshot: state.snapshot,
        owner: state.owner
      });
    });

  const clear = (ownership: WriteOwnership): Promise<void> =>
    enqueue(async () => {
      // load() 只有"文件不存在"才返回 null；读失败/损坏会抛。那种情况绝不能当成
      // "没有记录可保护"直接写墓碑 —— 损坏的字节也可能是一条不属于本进程、还等着
      // 被恢复的记录，覆盖它会跳过所有权校验（这正是本模块最不该有的捷径）
      const state = await load();
      if (state !== null) assertOwned(state, ownership, '清除');
      await persist({
        version: STATE_VERSION,
        phase: 'cleared',
        snapshot: null,
        owner: ownership
      });
    });

  const adopt = (ownership: WriteOwnership, options: AdoptOptions): Promise<void> =>
    enqueue(async () => {
      // 运行时再挡一道：接管把快照作废，restore 是唯一的安全前提，不能让漏写声明的
      // JS 调用方悄悄走这条路径
      if (!options || options.restored !== true) {
        throw new StateValidationError(
          '拒绝接管系统代理状态：接管会作废快照，前提是已经用它完成系统还原 —— ' +
            '请在参数里显式声明 restored: true'
        );
      }

      const state = await load();
      if (state === null) {
        // 没有记录就没有可接管的账；新进程直接用 beginWrite 开自己的记录即可
        throw new Error('接管系统代理状态失败：盘上没有可接管的记录');
      }
      if (isOwnedBy(state, ownership)) {
        // 自己的记录谈不上"接管"；还原完成后该走 clear()，走到这里说明调用方搞混了路径
        throw new Error('接管系统代理状态失败：记录本就属于当前所有权（还原完成后应调用 clear()）');
      }

      // 换主 + 作废快照并写 cleared：restore 已完成，快照使命结束，继续留着只会让
      // 下一次启动拿着过期快照再还原一遍。写成 cleared 是唯一诚实的阶段
      await persist({
        version: STATE_VERSION,
        phase: 'cleared',
        snapshot: null,
        owner: ownership
      });
    });

  return { load, beginWrite, commit, clear, adopt };
};
