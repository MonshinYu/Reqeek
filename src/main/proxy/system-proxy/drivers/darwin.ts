import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {
  type ProxyEntry,
  type ProxyKind,
  type ProxySnapshot,
  type SystemProxyDriver,
  SystemProxyError,
  type TargetState
} from '../types';

/**
 * macOS 系统代理 driver。
 *
 * 四类代理（web / secureWeb / socks / pac）在 macOS 上是**四组各自独立的开关和地址**，
 * 统一通过 networksetup 按「网络服务」（Wi-Fi / 以太网 / iPhone USB…）读写。
 * 这个文件里没有、也不允许出现「整体开关」这种东西 —— 一旦有，就会重演 V0 里
 * 「用户只开了 secureWeb（Clash），我们停止时连他的一起关掉」那类数据丢失。
 *
 * 所有命令都经可注入的 runner 执行：测试换成假实现，既能逐条断言命令，
 * 又绝不会真的改动运行这台机器的设置。
 */

/** 命令执行的输出。为什么只留 stdout/stderr：driver 只用输出文本，失败一律以抛错表达 */
export interface CommandResult {
  stdout: string;
  stderr: string;
}

/**
 * 命令执行器。默认实现是 promisify(execFile)，测试注入假实现。
 * 约定：命令非零退出时抛出的 Error 上会挂着 stdout / stderr（execFile 的行为）；
 * 例外是超时 —— 默认 runner 直接抛不带流的 SystemProxyError（见 createCommandRunner）。
 */
export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

const execFileAsync = promisify(execFile);

/**
 * 单条命令的超时上限（毫秒）。
 *
 * 为什么必须有：networksetup / route 一旦卡住，不设超时就是**永久**挂起 —— 而
 * restore 跑在退出路径上（正常停止、崩溃恢复都是），挂住意味着进程
 * 退不掉、系统代理也还原不了，用户只能自己进「系统设置」收拾这个烂摊子。
 *
 * 为什么是 5 秒：本机实测 networksetup 正常耗时在几十毫秒量级，5 秒有两个数量级的
 * 余量，系统再忙也不会误杀；反过来，最坏情况下 restore 是 web / secureWeb 各最多两条
 * （回填原地址 + 关开关）、socks 与 pac 各一条、再加 bypass 一条，共 7 条命令串行，
 * 全部超时也只是 35 秒内收敛，不会把「卡死」从一个地方挪到另一个地方。
 */
export const COMMAND_TIMEOUT_MS = 5_000;

/**
 * runner 工厂：超时时长可注入，测试用几十毫秒验证超时路径，生产走默认值。
 *
 * 不用 shell：服务名、域名直接进 argv，免得带空格或特殊字符的名字被 shell 再解释一遍。
 *
 * 超时用 AbortSignal 而不是「race 一个定时 Promise」：race 只让调用方不再等，
 * 挂住的子进程还活着、事件循环仍被它钉住 —— 进程照样退不掉，等于没修。这里持一个
 * 定时器，到点 abort，execFile 会真的把子进程杀掉。是否超时用本函数自己的 timedOut
 * 标记判定，不去猜错误对象上的 killed / signal 字段（别的失败形态也会带这些字段）。
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
        throw new SystemProxyError(
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

/** 生产路径用的 runner：超时取 COMMAND_TIMEOUT_MS */
export const defaultCommandRunner: CommandRunner = createCommandRunner();

const NETWORKSETUP = 'networksetup';
const ROUTE = 'route';

/** 清空 bypass 列表用的关键字，man networksetup 原文：Specify "Empty" for <domain1> to clear all */
const BYPASS_EMPTY_KEYWORD = 'Empty';

/**
 * PAC 脚本配置的命令。形态和另外三类不一样（没有端口），所以不共用命令表：
 * - 读：一条 -getautoproxyurl 同时给出 URL 行和它自己的 Enabled 行
 * - 写：-setautoproxyurl 回填 URL 并顺带开启；-setautoproxystate 只改开关、不碰 URL
 */
const PAC_URL_GET_COMMAND = '-getautoproxyurl';
const PAC_URL_SET_COMMAND = '-setautoproxyurl';
const PAC_STATE_COMMAND = '-setautoproxystate';

/** 三类「地址 + 端口」代理的命令表。pac 形态不同，单独处理 */
interface PortProxyCommands {
  readonly get: string;
  readonly set: string;
  readonly setState: string;
}

const PORT_PROXY_COMMANDS: Record<'web' | 'secureWeb' | 'socks', PortProxyCommands> = {
  web: { get: '-getwebproxy', set: '-setwebproxy', setState: '-setwebproxystate' },
  secureWeb: {
    get: '-getsecurewebproxy',
    set: '-setsecurewebproxy',
    setState: '-setsecurewebproxystate'
  },
  socks: {
    get: '-getsocksfirewallproxy',
    set: '-setsocksfirewallproxy',
    setState: '-setsocksfirewallproxystate'
  }
};

/** 还原顺序固定为 web -> secureWeb -> socks -> pac；四项互不依赖，固定只是让断言稳定 */
const RESTORE_ORDER: readonly ProxyKind[] = ['web', 'secureWeb', 'socks', 'pac'];

/**
 * apply 会改写的两类。只有它们的地址可能在一次 apply 里被换成 Reqeek 的地址，
 * 所以也只有它们在还原时可能需要回填快照里的「惰性地址」（见 restoreEntry）。
 * socks / pac apply 从不碰，地址始终是用户自己写下的，回填它们只会白白制造一个
 * 「代理短暂打开」的窗口，换不来任何东西。
 */
const APPLY_REWRITES_KINDS = new Set<ProxyKind>(['web', 'secureWeb']);

/** 取 "Key: value" 行的值。行不存在返回 null，好把「输出不认识」和「值本身是空」分开 */
const readField = (output: string, key: string): string | null => {
  const match = output.match(new RegExp(`^${key}:[ \t]*(.*)$`, 'm'));
  return match ? match[1].trim() : null;
};

/**
 * networksetup 的布尔值有两套写法：代理是 Yes/No，pac 是 On/Off。
 * 两套都认，免得某版系统换个说法就被误判成「关闭」—— 误判成关闭会在还原时
 * 把用户本来就开着的代理关掉。
 */
const isSwitchOn = (value: string): boolean => {
  const normalized = value.trim().toLowerCase();
  return normalized === 'yes' || normalized === 'on' || normalized === 'true' || normalized === '1';
};

/** 没配过地址时 networksetup 打印的字面量 */
const NULL_VALUE = '(null)';

const normalizeAddress = (value: string): string => (value === NULL_VALUE ? '' : value);

const parsePort = (value: string): number => {
  const port = Number.parseInt(value, 10);
  return Number.isFinite(port) && port > 0 ? port : 0;
};

/** 端口上限（合法 TCP 端口） */
const MAX_PORT = 65_535;

/**
 * 「这个地址值得回填吗」——host 非空、端口在合法区间内。
 *
 * 为什么 port 必须大于 0：退化快照（host 非空但 port 为 0）写回去就是 -set*proxy
 * <host> 0，networksetup 照单全收，于是一个指向 0 端口的代理被打开 —— 那等于断网，
 * 比不回填更糟。0 在这份契约里的含义正是「没有可用端口」（见 types.ts 的 ProxyEntry.port），
 * 不是「端口 0」。
 */
const isUsableAddress = (entry: ProxyEntry): boolean =>
  entry.host !== '' && Number.isFinite(entry.port) && entry.port > 0 && entry.port <= MAX_PORT;

/** 解析 web / secureWeb / socks 三项共用的输出形态：Enabled / Server / Port 三行 */
const parsePortEntry = (command: string, output: string): ProxyEntry => {
  const enabled = readField(output, 'Enabled');
  const server = readField(output, 'Server');
  const port = readField(output, 'Port');

  // 解析不出来就抛：宁可让上层看到失败，也不能猜一个「关闭」回去
  if (enabled === null || server === null || port === null) {
    throw new SystemProxyError(`无法解析 networksetup ${command} 的输出`, output.trim());
  }

  return {
    enabled: isSwitchOn(enabled),
    host: normalizeAddress(server),
    port: parsePort(port)
  };
};

/**
 * -getautoproxyurl 的形态：URL 一行、Enabled 一行（man: "Displays proxy auto-config
 * (url, enabled) info"），未配置时 URL 是字面量 (null)。
 *
 * 两个字段必须从**同一份输出**里一起解析：分开解析的话，「URL 解析成功、Enabled 解析
 * 失败」会退化成一条半对的快照，而半对的快照还原回去就是把用户的设置改成我们猜的样子。
 */
const parsePacEntry = (output: string): ProxyEntry => {
  const url = readField(output, 'URL');
  const enabled = readField(output, 'Enabled');

  if (url === null || enabled === null) {
    throw new SystemProxyError(
      `无法解析 networksetup ${PAC_URL_GET_COMMAND} 的输出`,
      output.trim()
    );
  }

  return { enabled: isSwitchOn(enabled), host: normalizeAddress(url), port: 0 };
};

/**
 * -getproxybypassdomains 在「一个都没配」时只打印一句说明文字（实测走 stdout），
 * 其余情况是每行一个域名。
 */
const parseBypassDomains = (output: string): string[] =>
  output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^there aren't any bypass domains/i.test(line));

/** -listallnetworkservices 的第一行是说明文字；被禁用的服务名带 "*" 前缀 */
const parseServiceList = (output: string): string[] =>
  output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('An asterisk'))
    // 禁用的服务仍然可以配置，所以只去掉标记星号、不丢弃它
    .map((line) => line.replace(/^\*/, '').trim())
    .filter((line) => line.length > 0);

/**
 * -listnetworkserviceorder 的形态是两行一组：
 *   (3) Wi-Fi
 *   (Hardware Port: Wi-Fi, Device: en0)
 * 返回「接口名 -> 服务名」，用来把默认路由的接口反查回服务名。
 */
const parseServiceOrder = (output: string): Map<string, string> => {
  const byDevice = new Map<string, string>();
  let current: string | null = null;

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();

    const nameMatch = line.match(/^\(\d+\)\s*(.+)$/);
    if (nameMatch) {
      current = nameMatch[1].replace(/^\*/, '').trim();
      continue;
    }

    const deviceMatch = line.match(/Device:\s*([^)\s]+)/);
    if (deviceMatch && current) byDevice.set(deviceMatch[1], current);
  }

  return byDevice;
};

/** 空列表必须换成 Empty 关键字，直接传空数组 networksetup 会报参数错误 */
const toBypassArgs = (domains: string[]): string[] =>
  domains.length > 0 ? [...domains] : [BYPASS_EMPTY_KEYWORD];

const pickStreamText = (cause: unknown, key: 'stdout' | 'stderr'): string => {
  if (typeof cause !== 'object' || cause === null) return '';
  const value = (cause as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : '';
};

/**
 * 把 execFile 的失败整理成 SystemProxyError。
 *
 * networksetup 的 "** Error: ..." 打在 stdout 而不是 stderr（实测），
 * 所以 stderr 为空时回落到 stdout —— 否则这条错误就没有任何可归因的线索。
 */
const toCommandError = (args: readonly string[], cause: unknown): SystemProxyError => {
  if (cause instanceof SystemProxyError) return cause;

  const detail = pickStreamText(cause, 'stderr') || pickStreamText(cause, 'stdout');
  const reason = detail || (cause instanceof Error ? cause.message : String(cause));
  return new SystemProxyError(`${NETWORKSETUP} ${args.join(' ')} 执行失败：${reason}`, detail);
};

/** 收拢到本应用支持的三种平台；其余平台落到 linux，只要结论是「不是 darwin」就够拒绝执行 */
const resolvePlatform = (): SystemProxyDriver['platform'] => {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'win32') return 'win32';
  return 'linux';
};

export interface DarwinDriverOptions {
  /** 注入命令执行器。测试传假实现，绝不真的执行 setter */
  run?: CommandRunner;
  /**
   * 覆盖平台判定。仅供测试验证非 darwin 的报错分支，
   * 生产代码不要传 —— 默认取 process.platform。
   */
  platform?: SystemProxyDriver['platform'];
}

export class DarwinSystemProxyDriver implements SystemProxyDriver {
  /** 契约里的平台标识：这个 driver 天生就是 darwin 的实现 */
  readonly platform: SystemProxyDriver['platform'] = 'darwin';

  private readonly run: CommandRunner;

  private readonly os: SystemProxyDriver['platform'];

  constructor(options: DarwinDriverOptions = {}) {
    this.run = options.run ?? defaultCommandRunner;
    this.os = options.platform ?? resolvePlatform();
  }

  /**
   * 候选目标：网络服务列表，**当前活跃的排第一位**。
   * 活跃服务靠默认路由的接口名反查，改代理时优先命中用户此刻真正在走的那个服务。
   */
  async listTargets(): Promise<string[]> {
    this.assertDarwin();

    const { stdout } = await this.exec(['-listallnetworkservices']);
    const services = parseServiceList(stdout);

    // 活跃服务识别失败只是让排序退化成默认顺序，不该让整个列表拿不到
    const active = await this.detectActiveService().catch(() => null);

    if (!active) return services;
    // 活跃服务若不在列表里（网络刚切换），也照样放到最前
    return [active, ...services.filter((service) => service !== active)];
  }

  async read(target: string): Promise<TargetState> {
    this.assertDarwin();

    // 四类代理的读取互不依赖，一起发。但快照必须完整：任何一类解析失败都让
    // 整个 read 失败 —— 缺一项就没法安全还原，还不如不写
    const [web, secureWeb, socks, pac, bypassDomains] = await Promise.all([
      this.readPortEntry('web', target),
      this.readPortEntry('secureWeb', target),
      this.readPortEntry('socks', target),
      this.readPacEntry(target),
      this.readBypassDomains(target)
    ]);

    return { entries: { web, secureWeb, socks, pac }, bypassDomains };
  }

  /**
   * 把代理指向本地端口。**只写 web + secureWeb 两项**：
   * socks 和 pac 用户可能正拿来做别的事（Clash 的 socks 口、公司的 PAC 脚本），
   * 我们没有任何理由碰它们。
   */
  async apply(target: string, host: string, port: number, bypassDomains: string[]): Promise<void> {
    this.assertDarwin();

    // 先写 bypass、再开代理。两个原因：
    // 1. man 里 -setwebproxy 明写 "Turns proxy on"，反过来的话，从代理打开的瞬间
    //    到 bypass 落盘之间，访问 localhost 的请求会绕进我们自己的代理；
    // 2. 这样万一写 bypass 先失败，也不会留下一个已经打开的代理
    await this.exec(['-setproxybypassdomains', target, ...toBypassArgs(bypassDomains)]);

    await this.exec([PORT_PROXY_COMMANDS.web.set, target, host, String(port)]);
    await this.exec([PORT_PROXY_COMMANDS.secureWeb.set, target, host, String(port)]);
  }

  /** 逐项还原到快照。按 ProxyKind 一项一项写，没有任何「整体关掉」的捷径 */
  async restore(snapshot: ProxySnapshot): Promise<void> {
    this.assertDarwin();

    const { target } = snapshot;

    // 为什么必须逐项：用户可能只用其中一两项（典型是 Clash 只开 secureWeb），
    // 整体关闭就等于把他的配置抹了 —— 这正是 V0 的数据丢失 bug
    for (const kind of RESTORE_ORDER) {
      await this.restoreEntry(target, kind, snapshot.entries[kind]);
    }

    await this.exec(['-setproxybypassdomains', target, ...toBypassArgs(snapshot.bypassDomains)]);
  }

  private async readPortEntry(
    kind: 'web' | 'secureWeb' | 'socks',
    target: string
  ): Promise<ProxyEntry> {
    const command = PORT_PROXY_COMMANDS[kind].get;
    const { stdout } = await this.exec([command, target]);
    return parsePortEntry(command, stdout);
  }

  /**
   * pac 项在 macOS 上对应的是「PAC 脚本配置」这一套设置，和契约里的语义一一对齐：
   * host <- 脚本 URL，enabled <- 该脚本配置自己的开关。两个字段都来自同一条
   * -getautoproxyurl，读到什么就一定能原样写回去（写回见 restoreEntry）。
   *
   * ⚠️ -getproxyautodiscovery（Proxy Auto Discovery / WPAD）是**另一套独立设置**，
   * 不是 PAC 脚本：它没有 URL，只有开关，系统靠网络自动发现脚本地址。我们从不修改
   * WPAD，所以它也不该进快照 —— 把它的开关写进 pac.enabled，等于让快照替用户承诺一个
   * 我们并不还原的设置；上一版正是这么映射的，跨平台语义因此对不上。
   */
  private async readPacEntry(target: string): Promise<ProxyEntry> {
    const { stdout } = await this.exec([PAC_URL_GET_COMMAND, target]);
    return parsePacEntry(stdout);
  }

  private async readBypassDomains(target: string): Promise<string[]> {
    const { stdout } = await this.exec(['-getproxybypassdomains', target]);
    return parseBypassDomains(stdout);
  }

  private async restoreEntry(target: string, kind: ProxyKind, entry: ProxyEntry): Promise<void> {
    if (kind === 'pac') {
      // enabled=true：-setautoproxyurl 写回脚本 URL 并顺带开启（man 原文 "and enable it"），
      // 一条命令就把「脚本地址 + 开启」还原到位。
      if (entry.enabled && entry.host !== '') {
        await this.exec([PAC_URL_SET_COMMAND, target, entry.host]);
        return;
      }

      // enabled=false（以及 enabled=true 但压根没配过 URL 的兜底）：只写开关，**不碰 URL**。
      //
      // 为什么必须用 -setautoproxystate 而不是拿 -setautoproxyurl 回填 URL：后者自带
      // "and enable it"，会把这个用户单独关掉的 PAC 配置重新打开。而 -setautoproxystate
      // 只改开关、URL 原样保留 —— 用户可能只是关掉了自动代理，脚本地址还留着。
      //
      // ⚠️ 更正一条曾经写在这里的假论断：旧注释断言「networksetup 不存在
      // -setautoproxystate（man 里查不到，已核对）」，并以此作为「darwin 的 pac 语义
      // 无法统一、只能拿 WPAD 当 enabled」的唯一支撑。该论断是错的：
      //   * 命令确实**没有**出现在 man networksetup 和 -printcommands 里（那边只有
      //     -setproxyautodiscovery / -setautoproxyurl），旧注释查到的就是这个；
      //   * 但二进制认它 —— 用不存在的服务名调用返回的是参数校验错误
      //     ("** Error: The parameters were not valid.")，而真正不认识的命令返回的是
      //     整篇 usage 加 "** Error: The command is not recognized."，两者可区分；
      // 「man 里没有」只说明它没被文档化，不说明它不存在。结论已被推翻：pac 的
      // enabled / host 两端语义可以、也应当统一到 PAC 脚本配置上。
      await this.exec([PAC_STATE_COMMAND, target, entry.enabled ? 'on' : 'off']);
      return;
    }

    const commands = PORT_PROXY_COMMANDS[kind];
    // 地址可用才谈得上回填（见 isUsableAddress）
    const usableAddress = isUsableAddress(entry);

    if (entry.enabled && usableAddress) {
      // 原本开着：用 setter 写回原地址端口。setter 自带开启，正好还原成「开着 + 原地址」
      await this.exec([commands.set, target, entry.host, String(entry.port)]);
      return;
    }

    if (!entry.enabled && usableAddress && APPLY_REWRITES_KINDS.has(kind)) {
      // 原本关着、但快照里留着**可用**地址，且这一项 apply 动过（web / secureWeb）：必须先把
      // 原地址写回去，再关掉。只发一条 state off 的话，apply 写下的 Reqeek 地址就永远
      // 留在用户配置里 —— macOS 关闭代理**不清除** Server/Port，而快照紧接着在 cleared
      // 阶段作废，之后再没有任何补救机会。用户那条「关着、但配好 corp-proxy:8080」的
      // 配置会永久指向 Reqeek 的死端口，日后重新勾选代理就是全体断网。
      //
      // 代价（旧实现正是为躲开它才不回填的，这里反过来接受它）：
      // networksetup 没有「只改地址、不动开关」的命令（man 原文：-setwebproxy 一族
      // "Turns proxy on"），回填只能借道 setter，于是两条命令之间有几毫秒到几百毫秒的
      // 窗口，代理短暂打开、指向用户自己的原地址 —— 窗口内恰好经过系统代理的请求会被
      // 送往那个地址（它可能已失效），最坏是一次请求失败；对比另一头「永久改写并丢掉
      // 用户配置、且无法弥补」，两害相权取其轻。
      // 两条命令紧挨着发、中间不插入任何其他 await，就是为了把这个窗口压到最短。
      await this.exec([commands.set, target, entry.host, String(entry.port)]);
      await this.exec([commands.setState, target, 'off']);
      return;
    }

    // 其余情形只写开关状态：socks（apply 从不碰它，地址没被覆盖过，回填零收益）、
    // 地址不可用的项（host 为空，或 port 为 0 的退化快照 —— 回填一个指向 0 端口的代理
    // 等于断网，见 isUsableAddress），以及 enabled=true 但没配过地址的兜底。
    //
    // 快照说 enabled 但地址不可用时这里写 on。理由是 restore 的职责是忠实还原而不是
    // 止损 —— socks 我们从头到尾没碰过，凭一个读不出端口的地址就把它关掉，正是这个
    // 文件最怕的那类「关掉用户自己的设置」。地址本身不写，所以不会把代理指向 0 端口。
    await this.exec([commands.setState, target, entry.enabled ? 'on' : 'off']);
  }

  /** 默认路由的接口名（en0…）反查服务名；识别不出来返回 null */
  private async detectActiveService(): Promise<string | null> {
    let routeOutput: string;
    try {
      routeOutput = (await this.run(ROUTE, ['-n', 'get', 'default'])).stdout;
    } catch {
      // 没有默认路由（没联网 / 拔了网线）时 route 非零退出，这不是错误
      return null;
    }

    const device = routeOutput.match(/^\s*interface:\s*(\S+)\s*$/m)?.[1];
    if (!device) return null;

    const order = await this.exec(['-listnetworkserviceorder']);
    return parseServiceOrder(order.stdout).get(device) ?? null;
  }

  private async exec(args: string[]): Promise<CommandResult> {
    try {
      return await this.run(NETWORKSETUP, args);
    } catch (cause) {
      throw toCommandError(args, cause);
    }
  }

  private assertDarwin(): void {
    if (this.os !== 'darwin') {
      throw new SystemProxyError(
        `macOS 的系统代理 driver 只能在 darwin 上运行，当前平台为 ${this.os}`
      );
    }
  }
}

export const createDarwinDriver = (options: DarwinDriverOptions = {}): SystemProxyDriver =>
  new DarwinSystemProxyDriver(options);
