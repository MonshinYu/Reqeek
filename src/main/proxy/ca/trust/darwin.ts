import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {CertificateError, type CertificateInfo, type CertificateTrustDriver, type TrustState} from '../types';

/**
 * macOS 的证书信任 driver —— 把根 CA 装进钥匙串、查它到底处于哪种信任状态、以及卸干净。
 *
 * 三态是本文件的核心。security 能直接回答的只有两个是/否问题：
 * 「证书在不在钥匙串里」（find-certificate）和「系统信不信它」（verify-cert），
 * 而契约要的三态正是这两个问题的组合：
 * - not-installed：不在（信不信无从谈起）
 * - installed：在，但没被信任（双击导入 .crt 的默认结果，还要再手动设「始终信任」）
 * - trusted：在，且被信任（只有这个状态 HTTPS 解密才能工作）
 * 把两者压成一个布尔，就会出现「界面显示装好了、解密却全失败且用户不知道为什么」——
 * 这正是 types.ts 里 TrustState 注释警告的那类事故。
 *
 * 所有命令都走可注入的 runner（默认 execFile）：测试换成假实现，既能逐条断言命令，
 * 又绝不会真的改动跑测试这台机器的信任设置。
 *
 * ── 命令与退出码的实测语义（macOS 26.7.1，只读命令实跑核对；文案随手会变，只信退出码）──
 * - `security find-certificate -c <CN> -Z` 找不到 → 退出码 44（stderr: The specified item
 *   could not be found in the keychain.）；找到 → 0。
 * - `security find-certificate -a -c <CN> -Z` **找不到时不是 44，而是「退出码 0 + 空输出」**：
 *   加上 -a 会把这个信号从退出码挪到「输出里有没有 SHA-256 行」。所以判据必须是
 *   「退出码 0 且解析结果里没有我们的指纹」= 没装，44 也按没找到兼容处理。
 * - 不带 -a 时只打印**第一个**匹配（实测：同一钥匙串里两张同名证书，不带 -a 只出一条
 *   SHA-256），同名旧证书排在前面时我们的证书会被整个漏掉 —— 这是必须带 -a 的原因。
 * - `-c` 是子串、大小写不敏感匹配（实测 "Same CN"、全小写都能命中），所以
 *   「有 CN 匹配」不能作为判据，唯一的判据是与 info.fingerprint256 逐位相等。
 * - `security verify-cert -c <certPath> -p ssl` 只看退出码：0 = 可信，非 0 = 不可信。
 *   实测：受用户信任的根 CA → 0（stdout "...certificate verification successful."）；
 *   未安装的自签证书 → 1（stderr "Cert Verify Result: CSSMERR_TP_NOT_TRUSTED"）；
 *   文件不存在 → 1（"***Error reading file" 打在 **stdout**）。
 *   ⚠️ 有一条边界极易误判，主流程用只读命令实测澄清过：`-p ssl` 对**已被信任**的根也可能
 *   退出 1，决定因素是**信任是怎么建立的**，不是根证书带不带 EKU：
 *     · 靠系统默认信任的公共根（SystemRootCertificates）→ 走严格策略检查，无 EKU 即失败
 *       （实测 DigiCert Global Root CA：无 EKU，退出 1）
 *     · 靠**用户或管理员显式信任设置**装出来的根（即 add-trusted-cert -r trustRoot 的产物）
 *       → 该信任设置豁免策略检查，无 EKU 也通过
 *       （实测 Reqable CA 与 CursorFree Local CA：两者都无 EKU，都退出 0）
 *   我们走的正是后者，所以 **x509.ts 不需要、也不应该给根证书加 EKU** ——
 *   给根证书加 EKU 是坏实践。细节见 verifyCert 的注释。
 * - `security delete-certificate -Z <sha256> <keychain>` 只删指纹相符的那一张（实测：
 *   同名兄弟证书原样保留）；删一个已经不存在的指纹 → 退出码 1（stderr
 *   "Unable to delete certificate matching ..."），所以幂等不能「删了再说」，
 *   必须先按指纹确认存在再删。
 * - `-t`（连同用户信任设置一起删）对没有信任设置的证书也是退出码 0（实测），可以无条件带上。
 * - find-certificate 对坏掉的钥匙串路径（不存在、不是钥匙串）也一律报「没找到」，
 *   它无法区分「路径错」和「证书不存在」；我们的两个钥匙串是固定标准路径，盲区落不到实处。
 */

/** 命令执行的输出。为什么只留 stdout/stderr：driver 只用输出文本，失败一律以抛错表达 */
export interface CommandResult {
  stdout: string;
  stderr: string;
}

/**
 * 命令执行器。默认实现是 promisify(execFile)，测试注入假实现。
 * 约定：命令非零退出时抛出的 Error 上挂着 code（数字退出码）与 stdout / stderr（execFile 的行为），
 * 进程级失败（起不来）code 是 'ENOENT' 这类字符串；超时则抛不带任何流的 CertificateError。
 */
export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

const execFileAsync = promisify(execFile);

/**
 * 只读命令（find-certificate / verify-cert）的超时上限（毫秒）。
 *
 * 为什么必须有：inspect 会被启动流程或界面直接等待，一条卡住的 security 命令不设超时
 * 就是永久挂起 —— 用户看到的是应用毫无反应，而不是一条可以重试的错误。
 * 为什么是 10 秒：本机实测这些命令都在几十毫秒量级，两个数量级余量；verify-cert 还带
 * SSL 策略校验，偶尔要补链（不带 -L 时会尝试走网络），10 秒不至于把这些正常耗时误杀。
 */
export const COMMAND_TIMEOUT_MS = 10_000;

/**
 * 可能弹系统授权对话框的命令（add-trusted-cert / delete-certificate）的超时上限（毫秒）。
 *
 * 为什么单独一档：man security 明写「修改用户级信任设置需要认证对话框」，也就是说
 * 这条命令的耗时取决于用户什么时候点。用只读命令那档 10 秒，等于用户还没读完弹窗，
 * 安装就被我们自己的超时打断 —— 而被打断的 add-trusted-cert 结果是不明的（可能已经写入一半）。
 * 2 分钟够用户看完弹窗做决定，也不至于让「用户点了取消或再也没点」变成永久挂起。
 */
export const INTERACTIVE_TIMEOUT_MS = 120_000;

/**
 * runner 工厂：超时时长可注入，测试用几十毫秒验证超时路径，生产走默认值。
 *
 * 不用 shell：CN 里带括号、空格、逗号（`Reqeek CA (MonshinYu-MacBook)`），
 * 路径由调用方注入，直接进 argv 才不会被 shell 再解释一遍。
 *
 * 超时用 AbortSignal 而不是「race 一个定时 Promise」：race 只是调用方不再等，
 * 挂住的子进程还活着、事件循环仍被它钉住。这里持一个定时器，到点 abort，
 * execFile 会真的把子进程杀掉。是否超时用本函数自己的 timedOut 标记判定，
 * 不去猜错误对象上的 killed / signal 字段（别的失败形态也会带这些字段）。
 */
export const createCommandRunner = (timeoutMs: number = COMMAND_TIMEOUT_MS): CommandRunner => {
  return async (command, args) => {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const { stdout, stderr } = await execFileAsync(command, args, { signal: controller.signal });
      return { stdout: String(stdout), stderr: String(stderr) };
    } catch (cause) {
      if (timedOut) {
        throw new CertificateError(
          `${command} ${args.join(' ')} 执行超时：超过 ${timeoutMs}ms 没有返回，已终止该命令`,
          ''
        );
      }
      throw cause;
    } finally {
      clearTimeout(timer);
    }
  };
};

/** 生产路径用的 runner：只读命令档 */
export const defaultCommandRunner: CommandRunner = createCommandRunner();

/** 生产路径用的 runner：可能弹授权对话框的命令档 */
export const defaultInteractiveRunner: CommandRunner = createCommandRunner(INTERACTIVE_TIMEOUT_MS);

const SECURITY = 'security';

/**
 * find-certificate 的「没找到」退出码。
 *
 * 实测（macOS 26.7.1）：不带 -a 时找不到就是 44；带 -a 时改用「退出码 0 + 空输出」表达。
 * 两个入口都认：44 按没找到处理，空输出同样按没找到处理，其余非 0 一律抛错 ——
 * 「命令挂了」和「证书不存在」必须分开：前者是错误，后者才是正常的 not-installed，
 * 把前者当后者会让用户看到一个假的「没装过」。
 */
const ITEM_NOT_FOUND_EXIT_CODE = 44;

/** 系统钥匙串。我们只往登录钥匙串装，但旧版本/管理员权限装过会落在这里，卸载与检查必须一并查 */
export const SYSTEM_KEYCHAIN_PATH = '/Library/Keychains/System.keychain';

/** 登录钥匙串相对家目录的位置。security 不展开 ~，所以要由我们拼出完整路径 */
const LOGIN_KEYCHAIN_RELATIVE_PATH = 'Library/Keychains/login.keychain-db';

/** 错误对象上的数字退出码；进程级失败（字符串 code、或压根没有 code）返回 null */
const readExitCode = (cause: unknown): number | null => {
  if (typeof cause !== 'object' || cause === null) return null;
  const code = (cause as Record<string, unknown>).code;
  return typeof code === 'number' ? code : null;
};

const pickStreamText = (cause: unknown, key: 'stdout' | 'stderr'): string => {
  if (typeof cause !== 'object' || cause === null) return '';
  const value = (cause as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : '';
};

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * 把命令失败整理成 CertificateError。
 *
 * security 的错误两个流都会出现（实测：find-certificate 的错误在 stderr，
 * verify-cert 的 "***Error reading file" 在 stdout），所以 stderr 为空时回落 stdout ——
 * 否则这条错误就没有任何可归因的线索。
 */
const toCommandError = (args: readonly string[], cause: unknown): CertificateError => {
  if (cause instanceof CertificateError) return cause;

  const detail = pickStreamText(cause, 'stderr') || pickStreamText(cause, 'stdout');
  const reason = detail || messageOf(cause);
  return new CertificateError(`${SECURITY} ${args.join(' ')} 执行失败：${reason}`, detail);
};

/**
 * 指纹归一：去掉分隔符、统一大写。
 *
 * 契约已经规定指纹是「大写、无分隔符」，归一只是为了对同一个值容忍大小写差异；
 * 比较仍然是逐位相等 —— 任何一位不同都算「另一张证书」。
 */
const normalizeFingerprint = (value: string): string =>
  value.replace(/[^0-9a-fA-F]/g, '').toUpperCase();

/** 从 find-certificate -Z 的输出里取出所有 SHA-256 指纹（带 -a 时每张证书各一条） */
const parseSha256Hashes = (output: string): Set<string> => {
  const hashes = new Set<string>();
  for (const match of output.matchAll(/^SHA-256 hash:\s*([0-9a-fA-F]{64})\s*$/gm)) {
    hashes.add(normalizeFingerprint(match[1]));
  }
  return hashes;
};

/** 收拢到本应用支持的三种平台；其余平台落到 linux，只要结论是「不是 darwin」就够拒绝执行 */
const resolvePlatform = (): CertificateTrustDriver['platform'] => {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'win32') return 'win32';
  return 'linux';
};

export interface DarwinTrustDriverOptions {
  /** 注入只读命令（find-certificate / verify-cert）的执行器。测试传假实现，绝不真的动系统 */
  run?: CommandRunner;
  /** 注入可能要弹授权对话框的命令（add-trusted-cert / delete-certificate）的执行器；不传则沿用 run */
  runInteractive?: CommandRunner;
  /**
   * 覆盖家目录，用来拼登录钥匙串路径。默认取 os.homedir()。
   * 测试注入固定值，让命令可以逐字断言 —— 核心模块不依赖 electron，路径由调用方给出。
   */
  homeDir?: string;
  /**
   * 判断钥匙串文件是否存在。默认用 node:fs 的 existsSync。
   *
   * 之所以做成可注入：测试注入的是假的钥匙串路径（磁盘上并不存在），
   * 直接调 existsSync 会让「路径不存在」这条守卫在所有用例里误触发。
   * 和 run / runInteractive 是同一个思路 —— 一切与外界接触的点都可替换。
   */
  keychainExists?: (path: string) => boolean;
  /**
   * 覆盖平台判定。仅供测试验证非 darwin 的报错分支，
   * 生产代码不要传 —— 默认取 process.platform。
   */
  platform?: CertificateTrustDriver['platform'];
}

export class DarwinCertificateTrustDriver implements CertificateTrustDriver {
  /** 契约里的平台标识：这个 driver 天生就是 darwin 的实现 */
  readonly platform: CertificateTrustDriver['platform'] = 'darwin';

  private readonly run: CommandRunner;

  private readonly runInteractive: CommandRunner;

  private readonly homeDir: string;

  private readonly os: CertificateTrustDriver['platform'];

  private readonly keychainExists: (path: string) => boolean;

  constructor(options: DarwinTrustDriverOptions = {}) {
    this.run = options.run ?? defaultCommandRunner;
    // 测试只注入 run 时两档都用同一个假实现 —— 单测要验的是发什么命令，不是超时档位
    this.runInteractive = options.runInteractive ?? options.run ?? defaultInteractiveRunner;
    this.homeDir = options.homeDir ?? homedir();
    this.os = options.platform ?? resolvePlatform();
    this.keychainExists = options.keychainExists ?? existsSync;
  }

  /** 要检查/清理的钥匙串：登录的排前面（我们自己安装的目标，最常见命中） */
  private get keychainPaths(): string[] {
    return [this.loginKeychain, SYSTEM_KEYCHAIN_PATH];
  }

  private get loginKeychain(): string {
    return join(this.homeDir, LOGIN_KEYCHAIN_RELATIVE_PATH);
  }

  /**
   * 查我们这根 CA 的信任状态。
   *
   * 顺序是「先在不在，再信不信」—— 不是省命令，是语义：不在钥匙串里时「信不信」没有意义
   * （用户信任设置里可能还残留着同名旧证书的条目，但它不是我们的证书），契约也把
   * 这种情况定义为 not-installed。
   */
  async inspect(info: CertificateInfo): Promise<TrustState> {
    this.assertDarwin();

    if (!(await this.isInstalled(info))) return 'not-installed';

    // 在，就只剩「信不信」这一问。与 install 的复查用的是同一个判据（verify-cert 的退出码）
    const { trusted } = await this.withCertFile(info.pem, (certPath) => this.verifyCert(certPath));
    return trusted ? 'trusted' : 'installed';
  }

  /**
   * 装进**用户**登录钥匙串（不需要管理员权限）。
   *
   * 参数的确切含义（man security 核对过）：
   * - `-r trustRoot`：把这本证书当作信任链的**根**（而不是叶子）—— 我们装的本来就是根 CA；
   * - `-p ssl`：信任设置只对 SSL 策略生效。这是最小授权：不限定的话这张 CA 会在
   *   代码签名等所有策略上获得信任，对 HTTPS 解密毫无必要；
   * - `-k <登录钥匙串>`：证书进哪个钥匙串。不给 `-d` 就是用户域（不需要管理员，
   *   代价是修改用户信任设置时系统会弹一次认证对话框，所以这条命令走交互超时档）。
   *
   * 装完必须重新验证一次：**导入 ≠ 已信任**。add-trusted-cert 退出 0 只说明「写进去了」，
   * 信任是否真的生效（用户级信任设置可能被禁用、证书可能不满足 SSL 策略）要回到
   * verify-cert 的退出码上复查。契约给的 install 只有 certPath、没有 CertificateInfo，
   * 所以复查在同一份文件上重跑同一个判据 —— 不变量正是「装完的结果必须是这个文件里的证书被信任」。
   */
  async install(certPath: string): Promise<void> {
    this.assertDarwin();

    await this.execInteractive([
      'add-trusted-cert',
      '-r',
      'trustRoot',
      '-p',
      'ssl',
      '-k',
      this.loginKeychain,
      certPath
    ]);

    const { trusted, detail } = await this.verifyCert(certPath);
    if (!trusted) {
      throw new CertificateError(
        '证书已加入登录钥匙串，但系统仍未信任它（verify-cert 的 SSL 策略校验未通过）——' +
          '可能是用户级信任设置被禁用，或证书不满足 SSL 策略要求；可在「钥匙串访问」里核对该证书的信任设置',
        detail
      );
    }
  }

  /**
   * 从信任库移除，**幂等**：两个钥匙串里都没有就等于已经清干净，不发任何删除命令。
   *
   * 为什么必须先按**指纹**定位：用户可能装过我们旧版本生成的同名证书（CN 相同、密钥不同），
   * 只按 CN 删会删错一张 —— 旧证书被误删，或者我们的证书因为排在后面而没被删掉。
   *
   * 为什么要查**两个**钥匙串：我们自己装进登录钥匙串，但旧版本或用管理员权限装过的版本
   * 会落在系统钥匙串里；只查一个就会出现「卸不干净，用户下次看仍是 installed」。
   *
   * 为什么先全部定位、再动手删：某把钥匙串读不动时要在任何删除发生之前失败，
   * 否则会留下「卸了一半」的状态。
   *
   * 为什么带 `-t`：删掉证书本体还不够，用户域里那条信任设置要一起清掉，
   * 否则残留设置可能在下次装同名证书时复活。实测 `-t` 对没有信任设置的证书也是退出码 0，
   * 所以可以无条件带上。
   */
  async uninstall(info: CertificateInfo): Promise<void> {
    this.assertDarwin();

    const fingerprint = normalizeFingerprint(info.fingerprint256);
    const targets: string[] = [];

    for (const keychain of this.keychainPaths) {
      // 不存在的钥匙串里不可能有我们的证书，跳过而不是当成错误 ——
      // existsInKeychain 对缺失路径是抛错的（那是 inspect 要的语义），
      // 但在这里抛会让系统钥匙串缺失连带把登录钥匙串也清不掉
      if (!this.keychainExists(keychain)) continue;
      if (await this.existsInKeychain(keychain, info)) targets.push(keychain);
    }

    for (const keychain of targets) {
      try {
        await this.execInteractive(['delete-certificate', '-t', '-Z', fingerprint, keychain]);
      } catch (cause) {
        // 删除失败有两种可能：真失败（比如系统钥匙串要管理员权限），
        // 或者并发的另一次 uninstall 刚刚把它删掉了。后者最终状态是对的，
        // 报成错误会让调用方以为没清干净、反复重试。
        // 判据用"重新查一次"而不是 stderr 文案 —— 文案随系统版本变，靠不住。
        if (await this.existsInKeychain(keychain, info)) throw cause;
      }
    }
  }

  private async isInstalled(info: CertificateInfo): Promise<boolean> {
    for (const keychain of this.keychainPaths) {
      if (await this.existsInKeychain(keychain, info)) return true;
    }
    return false;
  }

  /**
   * 这个钥匙串里有没有**我们的**证书。
   *
   * 命令形态的每一条都有实测依据：
   * - `-a` 必须带：不带的话只打印第一个匹配，同名旧证书排在前面就会把我们的证书整个遮住；
   * - `-Z` 打印 SHA-256 指纹；`-c` 是子串、大小写不敏感匹配，所以判据只能是
   *   指纹逐位相等，而不是「有 CN 命中」；
   * - 找不到时（实测 -a 下）是「退出码 0 + 空输出」，因此「没装」= 退出码 0 且
   *   输出里没有我们的指纹；44 按没找到兼容（不带 -a 的语义）。
   * - 其余非 0 退出码 = 命令真的失败（钥匙串打不开、参数错等），抛错；
   *   绝不能把这种失败当成「没装」—— 那会让用户看到一个假的 not-installed。
   */
  private async existsInKeychain(keychain: string, info: CertificateInfo): Promise<boolean> {
    // 必须先挡一道：`security find-certificate -a -c <CN> <keychain>` 对**不存在的钥匙串**
    // 返回退出码 0 + 空输出，和「证书不在这个库里」完全同形。不挡的话，环境异常
    // （比如 homeDir 传错、钥匙串被删）会被静默报成"没装过" —— 而那是用户最不该看到的
    // 假信息：他会以为证书没装，反复去装，却怎么都装不好。
    if (!this.keychainExists(keychain)) {
      throw new CertificateError(
        `钥匙串不存在：${keychain}。无法据此判断证书是否已安装，因此不给出结论`
      );
    }

    const args = ['find-certificate', '-a', '-c', info.commonName, '-Z', keychain];

    let result: CommandResult;
    try {
      result = await this.run(SECURITY, args);
    } catch (cause) {
      // runner 整理过的失败（超时就是这种形态）原样冒泡，不被二次包装
      if (cause instanceof CertificateError) throw cause;
      if (readExitCode(cause) === ITEM_NOT_FOUND_EXIT_CODE) return false;
      throw toCommandError(args, cause);
    }

    return parseSha256Hashes(result.stdout).has(normalizeFingerprint(info.fingerprint256));
  }

  /**
   * 信任判据只有一条：`security verify-cert -c <certPath> -p ssl` 的**退出码**。
   *
   * 为什么不解析输出：文案随系统版本变（成功是 "...certificate verification successful."，
   * 失败详情两个流都出现过：CSSMERR_TP_NOT_TRUSTED 在 stderr、"***Error reading file" 在
   * stdout），拿文案当判据的代码迟早被系统更新打脸；退出码是唯一稳定的信号。
   *
   * 为什么非 0 一律算「不可信」而不是错误：verify-cert 把「不信任」「不满足策略」
   * 都表达成非 0，driver 层无法、也不该替它细分。真正「命令没跑起来」的形态
   * （ENOENT、被信号杀死、超时）没有数字退出码，走抛错 —— 两条路互不混淆。
   *
   * ⚠️ 已知边界（主流程只读实测，macOS 26.7.1）：`-p ssl` 对**已被信任**的根也可能退出 1，
   * 但决定因素是**信任的来源**，不是 EKU：
   *   · 系统默认信任的公共根 → 走严格策略检查，无 EKU 即失败
   *     （实测 DigiCert Global Root CA：无 EKU，退出 1，"Invalid Extended Key Usage for policy"）
   *   · 用户或管理员显式信任设置装出来的根 → 该设置豁免策略检查，无 EKU 也通过
   *     （实测 Reqable CA、CursorFree Local CA：两者都无 EKU，都退出 0）
   * 我们走 add-trusted-cert -r trustRoot，属于后一类，因此**不需要给根证书加 EKU**。
   *
   * 这条边界必须写准：踩错方向会让人去给根证书乱加 EKU，而那是坏实践。
   */
  private async verifyCert(certPath: string): Promise<{ trusted: boolean; detail: string }> {
    const args = ['verify-cert', '-c', certPath, '-p', 'ssl'];

    try {
      await this.run(SECURITY, args);
      return { trusted: true, detail: '' };
    } catch (cause) {
      if (cause instanceof CertificateError) throw cause;
      if (readExitCode(cause) === null) throw toCommandError(args, cause);
      return {
        trusted: false,
        detail: pickStreamText(cause, 'stderr') || pickStreamText(cause, 'stdout')
      };
    }
  }

  /**
   * 把 PEM 落到临时文件再交给需要文件路径的命令（verify-cert 只接受文件）。
   * 临时目录每条命令现建现删：证书虽然公开，但没理由让它比一次检查活得更久。
   */
  private async withCertFile<T>(pem: string, action: (certPath: string) => Promise<T>): Promise<T> {
    let dir: string;
    try {
      dir = await mkdtemp(join(tmpdir(), 'reqeek-trust-'));
    } catch (cause) {
      throw new CertificateError(`无法创建临时目录：${messageOf(cause)}`, '');
    }

    try {
      const certPath = join(dir, 'ca.pem');
      try {
        await writeFile(certPath, pem, 'utf8');
      } catch (cause) {
        throw new CertificateError(`无法写入临时证书文件：${messageOf(cause)}`, '');
      }
      return await action(certPath);
    } finally {
      // 清理失败不覆盖真正的结果：证书是公开信息，删不掉最多留个临时文件，
      // 把一次成功的检查改判成失败才是不可接受的
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async execInteractive(args: string[]): Promise<void> {
    try {
      await this.runInteractive(SECURITY, args);
    } catch (cause) {
      throw toCommandError(args, cause);
    }
  }

  private assertDarwin(): void {
    if (this.os !== 'darwin') {
      throw new CertificateError(
        `macOS 的证书信任 driver 只能在 darwin 上运行，当前平台为 ${this.os}`
      );
    }
  }
}

export const createDarwinTrustDriver = (
  options: DarwinTrustDriverOptions = {}
): CertificateTrustDriver => new DarwinCertificateTrustDriver(options);
