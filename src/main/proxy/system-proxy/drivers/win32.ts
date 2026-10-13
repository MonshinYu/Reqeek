import {execFile} from 'node:child_process';

import {
  type ProxyEntry,
  type ProxyKind,
  type ProxySnapshot,
  type SystemProxyDriver,
  SystemProxyError,
  type TargetState
} from '../types';

/**
 * Windows 系统代理 driver：读写注册表里的全局代理配置。
 *
 * ⚠️ **未在 Windows 上验证**：本文件从来没有在 Windows 上执行过。开发机是 macOS，
 * 下面所有行为都来自 WinINet / reg.exe 的公开文档和既有工具的通行做法，一次真机执行都没有。
 * 真机联调时要逐条确认：
 *
 *  1. `reg query <键>` 的整键输出格式（值行有缩进、列间空白、类型标记）与退出码。
 *     值不存在时它根本不出现在输出里 —— 这是判断「值缺失」的唯一依据
 *  2. ProxyServer 混合形态（裸 token 和 http=/https= 同时出现）时 WinINet 的取舍。
 *     本实现按「显式协议优先、裸 token 兜底其余协议」处理
 *  3. 还原空值走的是 `reg delete <键> /v <值名> /f`（发之前会先读一次确认值存在），
 *     它的退出码要真机确认；`reg add /d ""` 能不能写空串则不再依赖 ——
 *     没验证过的写法不进还原路径（见 writeStringOrDelete）
 *  4. PowerShell 的 Add-Type P/Invoke 会不会被企业策略拦下（刷新通知因此做成 best-effort），
 *     以及它能否在 COMMAND_TIMEOUT_MS 内跑完 —— 跑不完就只丢刷新，注册表仍然是对的
 *  5. 裸 token 展开出的 socks= / ftp=（见 parseProxyServer 末尾）在真机上是否被 WinINet
 *     当作「显式协议」对待。裸 token 的 socks / ftp 覆盖全靠这次展开保住，
 *     真机联调时要确认会话期间和还原之后这两个协议都还走用户原来的地址
 *
 * 和 macOS 最大的不同：Windows 的代理是**一份全局配置**。没有 per-网络服务 的概念，
 * web / secureWeb / socks 三组地址挤在 ProxyServer 一个字符串里、共用一个 ProxyEnable
 * 开关，PAC 单独占一个 AutoConfigURL。
 */

/** 唯一合法目标。Windows 只有一份全局配置，不存在第二个目标 */
export const DEFAULT_TARGET = 'Default';

const INTERNET_SETTINGS_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

/**
 * ProxyServer 里的协议前缀 → 契约里的四类入口。
 * 只列我们认识的三个：pac 不在这条字符串里，它由 AutoConfigURL 承载。
 */
const PROTOCOL_TO_KIND: Record<string, ProxyKind> = {
  http: 'web',
  https: 'secureWeb',
  socks: 'socks'
};

// ------------------------------------------------------------------ 纯函数：地址

export interface ProxyEndpoint {
  host: string;
  port: number;
}

/** 带方括号的 IPv6，WinINet 也是这么写的 */
const BRACKETED_IPV6 = /^\[([^\]]+)\]:(\d+)$/;
/** 裸 host:port。`.` 贪婪会让未加方括号的 IPv6 被从最后一个冒号切开 */
const HOST_PORT = /^(.+):(\d+)$/;

export const parseEndpoint = (raw: string): ProxyEndpoint | null => {
  const text = raw.trim();
  if (text === '') return null;

  const bracketed = BRACKETED_IPV6.exec(text);
  if (bracketed) return makeEndpoint(bracketed[1], bracketed[2]);

  const plain = HOST_PORT.exec(text);
  if (!plain) return null;
  return makeEndpoint(plain[1], plain[2]);
};

const makeEndpoint = (host: string, portText: string): ProxyEndpoint | null => {
  const trimmed = host.trim();
  // 端口范围一并卡死：写进注册表的值错了，用户是直接断网，没有中间状态
  const port = Number(portText);
  if (trimmed === '' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: trimmed, port };
};

export const formatEndpoint = (endpoint: ProxyEndpoint): string =>
  endpoint.host.includes(':')
    ? `[${endpoint.host}]:${endpoint.port}`
    : `${endpoint.host}:${endpoint.port}`;

// ------------------------------------------------------------------ 纯函数：ProxyServer

export interface ParsedProxyServer {
  web: ProxyEndpoint | null;
  secureWeb: ProxyEndpoint | null;
  socks: ProxyEndpoint | null;
  /**
   * 写回时要一起带上的其余 token：ftp= 这类契约里没有的协议、解析不了的畸形 token，
   * 以及裸 token（对所有协议生效）对 ftp 的那一份 —— 它在解析时就被展开成显式 ftp=
   * 放进来（原因见 parseProxyServer 末尾）。不带上它们，用户配过的 ftp 代理
   * 就在我们改一次设置之后凭空消失了。
   */
  passthrough: string[];
}

/** 透传 token 里是否已经有某个协议前缀（`ftp=f:21` 这种，看 `=` 左边） */
const hasProtocolPrefix = (tokens: readonly string[], protocol: string): boolean =>
  tokens.some((token) => {
    const separator = token.indexOf('=');
    return separator > 0 && token.slice(0, separator).trim().toLowerCase() === protocol;
  });

/**
 * 解析 ProxyServer。这条字符串有两种形态，还可能混着写：
 *   裸形态   "10.0.0.1:8080"                        —— 对所有协议生效
 *   带前缀   "http=a:1;https=b:2;socks=c:3"          —— 逐协议指定
 *   混合     "10.0.0.1:8080;socks=c:3"               —— 显式协议优先，裸 token 兜底其余
 */
export const parseProxyServer = (raw: string): ParsedProxyServer => {
  const result: ParsedProxyServer = { web: null, secureWeb: null, socks: null, passthrough: [] };
  let fallback: ProxyEndpoint | null = null;

  for (const token of splitOnSemicolon(raw)) {
    const separator = token.indexOf('=');
    if (separator < 0) {
      const endpoint = parseEndpoint(token);
      // 裸 token 先记着，等所有显式协议都读完，再给没被指定的协议兜底
      if (endpoint) fallback = endpoint;
      else result.passthrough.push(token);
      continue;
    }

    const protocol = token.slice(0, separator).trim().toLowerCase();
    const value = token.slice(separator + 1);

    if (protocol === 'http' || protocol === 'https') {
      // http / https 是我们注定要重写的两项：值坏掉就当「没设」，不塞进 passthrough ——
      // 否则 apply 写回时会同时出现两个 http= token，等于往注册表里塞垃圾
      const endpoint = parseEndpoint(value);
      if (protocol === 'http') result.web = endpoint;
      else result.secureWeb = endpoint;
      continue;
    }

    if (protocol === 'socks') {
      const endpoint = parseEndpoint(value);
      if (endpoint) result.socks = endpoint;
      // 解析不了的 socks 原样留着：apply 只改 http/https，不能顺手把它删掉
      else result.passthrough.push(token);
      continue;
    }

    result.passthrough.push(token);
  }

  if (fallback) {
    if (!result.web) result.web = fallback;
    if (!result.secureWeb) result.secureWeb = fallback;
    if (!result.socks) result.socks = fallback;

    // 裸 token 在 WinINet 里对**所有**协议生效，ftp 也在其中。快照（ProxySnapshot）只有
    // web / secureWeb / socks / pac 四格，ftp 没有位置可放；ProxyServer 字符串本身才是
    // 它唯一的保真通道 —— 在这里把裸 token 对 ftp 的那一份展开成显式 ftp= 收进 passthrough，
    // apply / restore 写回时就会一路带上它（apply 重写成带前缀形态的那一刻不会丢，
    // restore 从注册表当前值里也捡得回来）。
    //
    // 为什么展开成显式前缀、而不是把裸 token 原样留在字符串里：混着裸 token 的形态
    //（"http=…;10.0.0.1:8080"）在 WinINet 里怎么取舍没有实机验证过（见文件头第 2 条），
    // 而显式 ftp= 和已经在写的 socks= 是同一种文档化写法。
    //
    // 已经有显式 ftp= 时不补：显式协议优先，补了就会出现两个 ftp= token。
    if (!hasProtocolPrefix(result.passthrough, 'ftp')) {
      result.passthrough.push(`ftp=${formatEndpoint(fallback)}`);
    }
  }

  return result;
};

/**
 * 构造要写进 ProxyServer 的字符串（apply 方向）。
 *
 * 手上没有快照，所以从**当前注册表值**重新解析一遍再合并：socks、ftp 以及契约里没有的
 * 协议保持原值。原值是裸形态时会被展开成带前缀的形式 —— 这一步是必须的，
 * 因为裸形态对**所有**协议生效，直接覆写成带前缀形态就等于把 socks 一起改掉了；
 * 反过来说，我们也不写裸形态（否则 socks 会被顺带指到 HTTP 代理端口上）。
 * 展开后 socks= 来自 parsed.socks，ftp= 由 parseProxyServer 提前放进 passthrough
 * 一起写回（见那里的注释）—— 两者都是裸 token 对其它协议的那一份，少一个就是用户丢配置。
 */
export const buildProxyServer = (original: string, host: string, port: number): string => {
  const parsed = parseProxyServer(original);
  const target = formatEndpoint({ host, port });

  const parts = [`http=${target}`, `https=${target}`];
  if (parsed.socks) parts.push(`socks=${formatEndpoint(parsed.socks)}`);
  parts.push(...parsed.passthrough);
  return parts.join(';');
};

/**
 * 从快照的 entries 还原 ProxyServer（restore 方向）。地址在就算数，enabled 由 ProxyEnable 单独承载。
 *
 * passthrough 是要原样带回去的其余 token（ftp=、解析不了的 socks= 等；裸 token 对 ftp 的
 * 那一份也由 parseProxyServer 展开在这里）。快照里没有它们的位置（ProxySnapshot 只有
 * 契约里的四类入口），但 apply 是特意把这些 token 留在 ProxyServer 里的；restore 不带回来，
 * 就等于完整一轮 start/stop 之后用户的 ftp 代理被吃掉 —— 和 apply 的保留是自相矛盾的。
 */
export const buildProxyServerFromEntries = (
  entries: Record<ProxyKind, ProxyEntry>,
  passthrough: readonly string[] = []
): string => {
  const parts: string[] = [];
  for (const [protocol, kind] of Object.entries(PROTOCOL_TO_KIND)) {
    const entry = entries[kind];
    const host = entry.host.trim();
    if (host === '') continue;
    parts.push(`${protocol}=${formatEndpoint({ host, port: entry.port })}`);
  }
  parts.push(...passthrough);
  return parts.join(';');
};

// ------------------------------------------------------------------ 纯函数：reg 输出

/** ProxyOverride / 绕过列表的分隔符是分号，多余空白丢掉；`<local>` 这类关键字原样保留 */
export const parseBypassDomains = (raw: string): string[] => splitOnSemicolon(raw);

const splitOnSemicolon = (raw: string): string[] =>
  raw
    .split(';')
    .map((token) => token.trim())
    .filter((token) => token !== '');

export interface RegistryValue {
  type: string;
  value: string;
}

/**
 * 值行：<缩进><值名><空白><REG_类型><空白><原样值>。
 *
 * 值名用惰性匹配而不是 `\S+`：值名里理论上可以有空格，而 `REG_` 这个前缀只会出现在类型列。
 * 值部分是正则的最后一段、不再参与切分：类型标记之后的整段文本原样保留
 *（分隔用的那一段空白除外 —— 它和值开头的空白本来就分不开）。
 * （旧实现先把整行按「2 个以上空白」切成列、再用两个空格拼回去，值里 3 个以上连续空白
 * 会被压成恰好 2 个：read 读到的原文失真，restore 写回去就是在改用户的值。）
 */
const REG_VALUE_LINE = /^[ \t]+(.+?)[ \t]+(REG_[A-Za-z0-9_]+)(?:[ \t]+(.*))?$/;

/**
 * 解析 `reg query <键>` 的整键输出。
 *
 * 为什么整键查一次、而不是按值名逐个 `reg query /v`：按值名查时「值不存在」和
 * 「键读不到」都是退出码 1，而 reg.exe 的报错文本是跟着系统语言走的，靠文本区分
 * 等于赌用户的 Windows 是英文；整键查一次则把两种情况彻底分开 —— 退出码非 0 一定是
 * 真错误，某个值不存在就只是不在输出里。
 *
 * 返回的 map 键是**小写值名**：注册表值名大小写不敏感，reg 打印的是写入时的大小写。
 */
export const parseRegQueryOutput = (stdout: string): Map<string, RegistryValue> => {
  const values = new Map<string, RegistryValue>();

  for (const line of stdout.split(/\r?\n/)) {
    // 键路径行、子键行、空行都不带 REG_ 类型标记，匹配不上直接跳过 ——
    // 比「按缩进猜这行是不是值行」更准，也不必假设缩进是几个空格
    const match = REG_VALUE_LINE.exec(line);
    if (match === null) continue;

    values.set(match[1].toLowerCase(), { type: match[2], value: match[3] ?? '' });
  }

  return values;
};

/** reg query 把 REG_DWORD 打成 0x1 这样的十六进制；这里两种写法都认 */
export const parseDword = (raw: string | undefined): number | null => {
  const text = raw?.trim() ?? '';
  if (text === '') return null;

  const hex = /^0x/i.test(text);
  const digits = hex ? text.slice(2) : text;
  const pattern = hex ? /^[0-9a-f]+$/i : /^\d+$/;
  if (!pattern.test(digits)) return null;

  const value = Number.parseInt(digits, hex ? 16 : 10);
  return Number.isInteger(value) ? value : null;
};

// ------------------------------------------------------------------ 纯函数：刷新通知

/** wininet.h: INTERNET_OPTION_REFRESH = 37 */
const INTERNET_OPTION_REFRESH = 37;
/** wininet.h: INTERNET_OPTION_SETTINGS_CHANGED = 39 */
const INTERNET_OPTION_SETTINGS_CHANGED = 39;

const MEMBER_DEFINITION =
  '[DllImport("wininet.dll", SetLastError=true)] public static extern bool InternetSetOption' +
  '(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);';

/**
 * 注册表写完**不会立刻生效**：WinINet 把代理配置缓存在进程里，要它重新读，
 * 必须调 InternetSetOption(NULL, INTERNET_OPTION_SETTINGS_CHANGED, NULL, 0)，
 * 再补一发 INTERNET_OPTION_REFRESH。
 *
 * 不引入 native 模块就只能借 PowerShell 现场编译一段 P/Invoke（Add-Type）——
 * 代价是首次要多花一两秒给 csc 编译，换来的是不用为每个 Electron 版本重编译二进制。
 * 另一条常见死路是 `netsh winhttp set proxy`：那只管 WinHTTP（服务用），
 * 浏览器读的是 WinINet，改了也没反应。
 *
 * ⚠️ 未在 Windows 上验证（见文件头）。所以调用方把它当 best-effort：
 * 注册表才是唯一的事实来源，通知失败最多是浏览器要重启一次才认账。
 */
const REFRESH_SCRIPT = [
  `$definition = '${MEMBER_DEFINITION}'`,
  'Add-Type -Namespace Reqeek -Name WinInet -MemberDefinition $definition',
  `[Reqeek.WinInet]::InternetSetOption([IntPtr]::Zero, ${INTERNET_OPTION_SETTINGS_CHANGED}, [IntPtr]::Zero, 0) | Out-Null`,
  `[Reqeek.WinInet]::InternetSetOption([IntPtr]::Zero, ${INTERNET_OPTION_REFRESH}, [IntPtr]::Zero, 0) | Out-Null`
].join('\n');

export const encodePowerShellCommand = (script: string): string =>
  Buffer.from(script, 'utf16le').toString('base64');

export interface CommandInvocation {
  file: string;
  args: string[];
}

/**
 * -EncodedCommand 收的是 UTF-16LE 的 base64。绕开所有引号转义问题，
 * 脚本里出现引号、分号、`<>` 都不用再操心（这些字符在命令行上一层层转义最容易被吃）。
 * 用 powershell.exe 而不是 pwsh：前者每台 Windows 都自带，后者要用户自己装。
 */
export const buildRefreshInvocation = (): CommandInvocation => ({
  file: 'powershell.exe',
  args: [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encodePowerShellCommand(REFRESH_SCRIPT)
  ]
});

// ------------------------------------------------------------------ 命令执行

export interface CommandResult {
  stdout: string;
  stderr: string;
  /** 退出码；进程压根没起来（找不到可执行文件）时为 null，原因在 stderr 里 */
  code: number | null;
  /**
   * 命令超时、被我们杀掉时为 true。
   * 这时 code 也是 null（被信号终止没有退出码），不单独标一笔就会和「进程压根没起来」
   * 混成同一条错误，排查方向直接被带偏。
   */
  timedOut?: boolean;
}

/**
 * 命令执行包一层：测试注入假实现，就能在 mac 上把 driver 的行为完整跑一遍。
 *
 * 这里刻意**不**用「非零退出就抛错」的约定，而是把退出码原样带回来：reg.exe 的退出码
 * 分不出「值不存在」和「键读不到」，只有拿到 stdout 才能自己判断（见 parseRegQueryOutput）。
 * 代价是和 darwin driver 的 runner 约定不一样，将来要抽公共模块时得先统一这里。
 */
export type CommandRunner = (file: string, args: string[]) => Promise<CommandResult>;

const toExitCode = (error: unknown): number | null => {
  if (error === null || error === undefined) return 0;
  if (typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'number') return code;
  }
  // ENOENT / 被信号杀掉：没有可用的退出码
  return null;
};

/** 失败原因的一行描述。超时被杀时 code 是 null，报「未启动」会把排查方向带偏，所以单独认一下 */
const describeFailure = (result: CommandResult): string =>
  result.timedOut === true ? '超时被终止' : `退出码 ${result.code ?? '未启动'}`;

/**
 * 单条命令的超时上限（毫秒）。
 *
 * 为什么必须有：reg.exe / powershell.exe 一旦卡住，不设超时就是**永久**挂起 ——
 * 而 restore 跑在退出路径上，挂住意味着进程退不掉、系统代理也还原不了。
 * 为什么是 5 秒：reg.exe 正常几十毫秒返回，留了两个数量级的余量；最慢的一条是刷新通知里
 * 现场编译的 PowerShell（Add-Type，冷启动一到几秒），而它本来就是 best-effort ——
 * 真在慢机器上超时也只是浏览器要重启一次才认账，换来的是退出路径的挂起上限被压住。
 * 与 darwin driver 取同一个值，将来抽公共模块时不用再对齐一次。
 */
export const COMMAND_TIMEOUT_MS = 5_000;

/**
 * runner 工厂：超时时长可注入，测试用几十毫秒快速验证超时路径，生产走默认值。
 *
 * 超时用 AbortController，而不是「另起一个定时 Promise 来 race」：race 只让调用方
 * 不再等，挂住的子进程还活着、事件循环仍被它钉住 —— 进程照样退不掉，等于没修。
 * 到点 abort 会把子进程真的杀掉；是否超时用本函数自己的 timedOut 标记，
 * 不去猜错误对象上的 killed / signal 字段（别的失败形态也会带这些字段）。
 * 做法与 darwin driver 的 runner 一致，只是这里的失败按本文件的约定原样返回、不抛。
 */
export const createExecFileRunner = (timeoutMs: number = COMMAND_TIMEOUT_MS): CommandRunner => {
  return (file, args) => {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    return new Promise<CommandResult>((resolve) => {
      execFile(
        file,
        args,
        {
          // windowsHide：不然每次读注册表都会在用户屏幕上闪一个黑框。
          // 绝不能开 shell：ProxyOverride 里的 `<local>` 走 cmd 会被当成重定向
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024,
          signal: controller.signal,
          // 超时后必须真死透：默认的 SIGTERM 是可以被子进程忽略的，被忽略掉就等于没设超时。
          // （Windows 上 Node 一律用 TerminateProcess，这个值在那里没有副作用）
          killSignal: 'SIGKILL'
        },
        (error, stdout, stderr) => {
          clearTimeout(timer);
          resolve({ stdout, stderr, code: toExitCode(error), timedOut });
        }
      );
    });
  };
};

// ------------------------------------------------------------------ driver

export interface Win32SystemProxyOptions {
  runner?: CommandRunner;
  /**
   * 只为可测性存在：在 macOS 上跑单测时把它假扮成 'win32'。
   * 生产代码不传，默认取 process.platform。
   */
  hostPlatform?: NodeJS.Platform;
}

interface RawInternetSettings {
  /** 缺省时是 null（不是 0）—— 缺省和显式 0 在还原时都是关，但读的时候要能区分 */
  proxyEnable: number | null;
  proxyServer: string;
  proxyOverride: string;
  autoConfigUrl: string;
  /**
   * 注册表里**真实存在**的值名（小写）。「值是空的」和「值不存在」读出来是同一个字符串，
   * 但写回空值时只有它能决定该发删除还是干脆什么都不做。
   */
  presentNames: ReadonlySet<string>;
}

export class Win32SystemProxyDriver implements SystemProxyDriver {
  readonly platform = 'win32' as const;

  private readonly runner: CommandRunner;
  private readonly hostPlatform: NodeJS.Platform;

  constructor(options: Win32SystemProxyOptions = {}) {
    this.runner = options.runner ?? createExecFileRunner();
    this.hostPlatform = options.hostPlatform ?? process.platform;
  }

  async listTargets(): Promise<string[]> {
    this.assertWin32();
    // Windows 只有一份全局配置，列不出第二个目标
    return [DEFAULT_TARGET];
  }

  async read(target: string): Promise<TargetState> {
    this.assertWin32();
    this.assertTarget(target);
    return toTargetState(await this.readRawSettings());
  }

  async apply(target: string, host: string, port: number, bypassDomains: string[]): Promise<void> {
    this.assertWin32();
    this.assertTarget(target);
    assertProxyAddress(host, port);

    const raw = await this.readRawSettings();

    // 先写地址再开开关：反过来的话，ProxyEnable=1 会有一瞬间指向旧地址（甚至是空地址）
    await this.writeString('ProxyServer', buildProxyServer(raw.proxyServer, host, port));
    await this.writeDword('ProxyEnable', 1);
    // 调用方给的是合并后的完整列表，这里如实写入；列表为空时同样走
    // writeStringOrDelete（删除/不动），不让未验证过的空串写法从 apply 这条路溜进来。
    // AutoConfigURL 一个字都不碰：那是用户的 PAC，动了它等于替他关掉自己的配置
    await this.writeStringOrDelete('ProxyOverride', bypassDomains.join(';'), raw);

    await this.notifySettingsChanged();
  }

  async restore(snapshot: ProxySnapshot): Promise<void> {
    this.assertWin32();
    this.assertTarget(snapshot.target);

    // 先读一次当前值，把 apply 特意留在 ProxyServer 里的未知 token（ftp=、解析不了的
    // socks=）捡回来。快照里没有它们的位置（ProxySnapshot 只有契约里的四类入口），
    // 不读就只能丢 —— 那会让完整一轮 start/stop 之后用户的 ftp 配置凭空消失。
    // 当前值还是裸形态时（apply 没写成：崩在 commit 之后、或者写 ProxyServer 那一步就失败了），
    // parseProxyServer 会把裸 token 对 ftp 的那一份就地展开成 ftp=，这里同样捡得到。
    // 读失败直接抛：宁可什么都不写，也不拿一份不完整的原样去覆盖注册表
    //（快照还在盘上，调用方下次可以重试）
    const current = await this.readRawSettings();
    const passthrough = parseProxyServer(current.proxyServer).passthrough;

    // 逐项尝试、最后统一报错，而不是一失败就中断：一中断，后面的项就停在被我们改过的
    // 样子，调用方却只看到一个「restore 失败」—— 半还原的系统比哪一项都没写更糟。
    // 全部试完之后再抛，调用方不标记 cleared，下次重试还能继续收敛
    const failures: string[] = [];
    const failureStderr: string[] = [];
    const attempt = async (what: string, write: () => Promise<void>): Promise<void> => {
      try {
        await write();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // reg.exe 的原文只躺在 SystemProxyError.stderr 里，message 里一个字都没有。
        // 两个通道都要带上：上层重新包装错误时（controller 的 toMessage）只转发 message，
        // 只填 stderr 字段的话排障的人仍然看不到它；而 stderr 字段正是这份一手信息该待的地方
        const stderr = error instanceof SystemProxyError ? error.stderr.trim() : '';
        failures.push(
          stderr === '' ? `${what}：${message}` : `${what}：${message}（reg stderr：${stderr}）`
        );
        if (stderr !== '') failureStderr.push(`${what}：${stderr}`);
      }
    };

    // 不做任何「整体关掉」的捷径：用户可能只用其中一两项，
    // 整体关闭就等于抹掉他自己的配置（V0 就是这么把 secureWeb 用户坑了的）
    await attempt('ProxyServer', () =>
      this.writeStringOrDelete(
        'ProxyServer',
        buildProxyServerFromEntries(snapshot.entries, passthrough),
        current
      )
    );
    await attempt('ProxyEnable', () =>
      this.writeDword('ProxyEnable', anyProxyEnabled(snapshot.entries) ? 1 : 0)
    );
    await attempt('ProxyOverride', () =>
      this.writeStringOrDelete('ProxyOverride', snapshot.bypassDomains.join(';'), current)
    );

    // 已经写回去的项要尽快生效，所以刷新照发；它本身 best-effort，不会抛
    await this.notifySettingsChanged();

    if (failures.length > 0) {
      throw new SystemProxyError(
        `Windows 系统代理还原没有全部完成：${failures.join('；')}。已写回的项不回滚，重试还原可以继续收敛`,
        failureStderr.join('\n')
      );
    }
  }

  // ---------------------------------------------------------------- 内部实现

  private assertWin32(): void {
    if (this.hostPlatform !== 'win32') {
      throw new SystemProxyError(
        `Windows 系统代理 driver 只能在 win32 上调用，当前平台是 ${this.hostPlatform}`
      );
    }
  }

  /**
   * Windows 的代理是全局的，target 只可能是 listTargets() 给出的 'Default'。
   * 校验它不是为了别的，是为了挡住「把 macOS 快照的 "Wi-Fi" 写到 Windows 注册表」
   * 这种一旦发生就直接改坏用户网络的情况。
   */
  private assertTarget(target: string): void {
    if (target.trim().toLowerCase() !== DEFAULT_TARGET.toLowerCase()) {
      throw new SystemProxyError(
        `未知的 Windows 系统代理目标 "${target}"，应为 "${DEFAULT_TARGET}"`
      );
    }
  }

  private async readRawSettings(): Promise<RawInternetSettings> {
    const stdout = await this.runReg(
      ['query', INTERNET_SETTINGS_KEY],
      '读取 Internet Settings 注册表'
    );
    const values = parseRegQueryOutput(stdout);

    return {
      proxyEnable: parseDword(values.get('proxyenable')?.value),
      proxyServer: values.get('proxyserver')?.value ?? '',
      proxyOverride: values.get('proxyoverride')?.value ?? '',
      autoConfigUrl: values.get('autoconfigurl')?.value ?? '',
      presentNames: new Set(values.keys())
    };
  }

  /** 只负责非空值；空值必须走 writeStringOrDelete，别在这里写 `reg add /d ""` */
  private async writeString(name: string, value: string): Promise<void> {
    await this.runReg(
      ['add', INTERNET_SETTINGS_KEY, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'],
      `写入 ${name}`
    );
  }

  /**
   * 写一个字符串值；要写的值是空串时改成**删除**它。
   *
   * 为什么不写 `reg add /d ""`：真机上 reg.exe 收不收空串没有验证过（见文件头），
   * 万一不收，失败会发生在 restore 的收尾那一步 —— 前面的项已经写回去了，
   * 整条 restore 报失败、系统却停在半还原状态。注册表里「值不存在」和「值是空的」
   * 对 WinINet 是等价的，所以空值统一走删除；值此刻本来就不存在时连删除都不发 ——
   * reg delete 对不存在的值会非 0 退出，而那个退出码和真正的失败分不开。
   */
  private async writeStringOrDelete(
    name: string,
    value: string,
    current: RawInternetSettings
  ): Promise<void> {
    if (value !== '') {
      await this.writeString(name, value);
      return;
    }

    if (!current.presentNames.has(name.toLowerCase())) return;
    await this.runReg(['delete', INTERNET_SETTINGS_KEY, '/v', name, '/f'], `删除 ${name}`);
  }

  private async writeDword(name: string, value: number): Promise<void> {
    await this.runReg(
      ['add', INTERNET_SETTINGS_KEY, '/v', name, '/t', 'REG_DWORD', '/d', String(value), '/f'],
      `写入 ${name}`
    );
  }

  private async runReg(args: string[], what: string): Promise<string> {
    const result = await this.runner('reg', args);

    // 半途失败不在这里回滚：上层已经把快照落盘，走 restore 逐项写回会收敛到原样，
    // 两边都抢着回滚反而会互相覆盖
    if (result.code !== 0) {
      throw new SystemProxyError(
        `Windows 系统代理操作失败：${what}（reg ${describeFailure(result)}）`,
        result.stderr.trim() || result.stdout.trim()
      );
    }

    return result.stdout;
  }

  private async notifySettingsChanged(): Promise<void> {
    const invocation = buildRefreshInvocation();

    try {
      const result = await this.runner(invocation.file, invocation.args);
      if (result.code === 0) return;
      console.warn(
        '[Reqeek] 通知 WinINet 刷新代理设置失败（注册表已写入，浏览器可能要重启才生效）：',
        result.stderr.trim() || describeFailure(result)
      );
    } catch (error) {
      console.warn(
        '[Reqeek] 通知 WinINet 刷新代理设置异常（注册表已写入，浏览器可能要重启才生效）：',
        error
      );
    }
  }
}

// ------------------------------------------------------------------ 组装

const toTargetState = (raw: RawInternetSettings): TargetState => {
  const parsed = parseProxyServer(raw.proxyServer);
  const proxyEnabled = raw.proxyEnable !== null && raw.proxyEnable !== 0;

  // 关着也要把地址留在快照里：还原时要按原样写回去，丢掉地址就等于把用户的配置删了
  const toEntry = (endpoint: ProxyEndpoint | null): ProxyEntry => ({
    enabled: proxyEnabled && endpoint !== null,
    host: endpoint?.host ?? '',
    port: endpoint?.port ?? 0
  });

  return {
    entries: {
      web: toEntry(parsed.web),
      secureWeb: toEntry(parsed.secureWeb),
      socks: toEntry(parsed.socks),
      // PAC 不在 ProxyServer 里，它有自己的值；有值就是启用
      pac: { enabled: raw.autoConfigUrl !== '', host: raw.autoConfigUrl, port: 0 }
    },
    bypassDomains: parseBypassDomains(raw.proxyOverride)
  };
};

const anyProxyEnabled = (entries: Record<ProxyKind, ProxyEntry>): boolean =>
  entries.web.enabled || entries.secureWeb.enabled || entries.socks.enabled;

/** 写坏注册表的代价是用户直接断网，所以宁可在写之前把明显不对的参数挡下来 */
const assertProxyAddress = (host: string, port: number): void => {
  // 空白和 `;` `=` 会把 ProxyServer 的语法搅乱；`<>` 在任何主机名里都不该出现，
  // 它是命令行重定向符号，调用方一旦不小心走了 cmd 就会在这里出岔子
  const badHost = host.trim() === '' || /[\s;=<>]/.test(host);
  const badPort = !Number.isInteger(port) || port < 1 || port > 65535;

  if (badHost || badPort) {
    throw new SystemProxyError(`非法的代理地址 "${host}:${port}"，拒绝写入注册表`);
  }
};
