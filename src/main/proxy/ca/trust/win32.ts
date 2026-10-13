import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';

import {CertificateError, type CertificateInfo, type CertificateTrustDriver, type TrustState} from '../types';

/**
 * Windows 的证书信任 driver：读写**当前用户**的证书存储，另外**只读**地查机器级
 * Disallowed 存储（不写它 —— 写机器级存储要管理员，本 driver 不做，见下）。
 *
 * ⚠️ **未在 Windows 上验证**：本文件从来没有在 Windows 上执行过。开发机是 macOS，
 * 下面所有行为都来自 certutil / CryptoAPI 的公开文档、官方语法说明和别人的真机报告，
 * 一次真机执行都没有。真机联调时下面的清单要逐条确认 —— **没有一条是已经在真机验证过的**：
 *
 * ── 退出码与输出解析（决定 inspect 的结论）
 *  1. `certutil -user -store Root <certid>` 在**没有匹配**时的退出码是不是 0x80092004
 *     （CRYPT_E_NOT_FOUND）。这是本实现"没装"的主判据（见 isNotFound）。已核实的是
 *     0x80092004 = CRYPT_E_NOT_FOUND（CryptoAPI 的"找不到对象"），而官方文档对 -store
 *     的退出码只字未提；社区报告说 certutil 用 HRESULT 当退出码，同样没核实 -store
 *     在无匹配时返回的就是它、而不是别的码
 *  2. 匹配成功时 -store 的证书块里打印的字段。已核实：-dump 里是 `Cert Hash(sha1)`、
 *     `Cert Hash(md5)`、`Cert Hash(sha256)`，中文系统是 `证书哈希(sha1)`，值可能是
 *     `aa bb cc…`（带空格）也可能是连续十六进制；-store 的字段名没找到直接证据，
 *     按同一套字段处理。解析器对此做了两手准备：认括号里的算法名（不翻译）；
 *     一行指纹都解析不出时**不再拿退出码下结论**，而是按"查不出来"上报（见下）
 *  3. certutil 的错误文本走 stdout 还是 stderr。同一条错误在社区里两种说法都有，
 *     所以本实现两条流都读（stderr 优先，见 describeOutput），不影响判定、只影响
 *     报错文本的完整性
 *
 * ── 命令行与文件格式（决定 install / uninstall 在真机上能不能跑起来）
 *  4. **-addstore 对 PEM / Base64 文件的接受度**：官方文档只把 InFile 写成
 *     "the certificate or CRL file"，对编码格式只字未提；社区里既有把 base64 文本
 *     直接喂给 -addstore 的样例，也有要求先转成 DER 的。本应用的安装文件是 PEM
 *     （LF 换行，ca/index.ts 落盘的那份）。**若某些 Windows 版本只吃 DER，干净机器上
 *     install 会直接失败** —— 真机联调第一件事就是验它，失败的话改喂 DER 或先
 *     `certutil -decode` 转换
 *  5. **选项位置与各动词的 options 列表**：文档语法统一写成 `certutil [options] -verb …`，
 *     但 -store / -addstore / -delstore 各自列出的 options **并不相同**（-store 与
 *     -delstore 有 `-Silent`，-addstore 没有；-store 另有 `-split`）。本实现里
 *     -store 的选项写在动词前（照文档语法），-addstore / -delstore 写在动词后
 *     （照社区通行写法）。"certutil 的参数解析不区分选项位置"是通行说法而非文档承诺，
 *     两种顺序都没在真机上验证过 —— 真机联调时这三个动词的命令都要各跑一遍
 *  6. 重复 `-addstore` 同一张证书的退出码：公开报告里 -addstore 对已在存储里的证书会报
 *     `Certificate "…" already in store.`（看上去是失败），但没有权威来源给出数字退出码。
 *     契约没有要求 install 幂等，所以这里不做预检查；真机确认后若重复安装会非 0 失败，
 *     调用方应先 inspect 再决定装不装
 *
 * ── 机器级 Disallowed（inspect / uninstall 用的第三个查询）
 *  7. 非管理员**读**机器级存储：为了堵住"假 trusted"路径（见下），本文件多查了一条
 *     `certutil -store Disallowed <sha1>`（不带 -user 即机器级）。公开报告一致说机器级
 *     存储的读不需要管理员（写才要），但没有官方文档的直接承诺。若某些机器上非管理员
 *     读机器级存储被拒，inspect / uninstall 会当场抛错（fail-closed，不猜，也不静默降级）
 *  8. **显式不信任是否同时看用户级与机器级 Disallowed**：查机器级 Disallowed 的前提是
 *     "同在 HKLM Disallowed 里的证书对当前用户也不被信任"。支持它的公开证据是
 *     Disallowed 在两个 scope 都存在、机器级不信任清单由 Windows Update 的 CTL 播发；
 *     官方文档没有一句话直接写明链引擎同时检查两个 scope。注意这条假设即使猜错，
 *     后果也落在**保守方向**：最多把"其实受信任"报成 'installed'，不会产生假 trusted
 *
 * ## 平台差异：装进 Root 就已经受信任
 *
 * `-addstore -user Root` 把证书放进用户的 **Trusted Root Certification Authorities**，
 * 这个存储的语义就是"受信任的根"：装进去那一刻它就被信任了。macOS 不是这样 ——
 * `security add-certificates` 只是导入，信任位要另外设，所以在 darwin 上
 * "已导入但没设始终信任"是**常态**，'installed' 是那条路上最常见的中间态。
 * Windows 没有这个中间态：装进 Root ⇒ 受信任。
 *
 * 那 Windows 上 'installed' 从哪来？从 **Disallowed** 存储来。同一张证书如果同时躺在
 * Root 和 Disallowed 里，CryptoAPI 的显式不信任检查会让它**不被信任** —— 契约里
 * "在证书库里、但没有被信任"的语义，在 Windows 上只对应这一种状态。所以 inspect
 * 查三个存储再组合（完整的组合规则见 inspect 的注释）：
 *   用户 Root 有、用户 Disallowed 无、机器级 Disallowed 无 → 'trusted'
 *   任何一个存储里有（用户的或机器级的） → 'installed'
 *   三个都确定没有 → 'not-installed'
 *   没有任何确定"有"的证据、又存在"查不出来" → 抛错，绝不猜
 * 只看 Root 就下结论的话，会把"被显式标记为不受信任"的证书报成 'trusted' ——
 * 用户接着会发现解密不工作而不知道为什么，正是三态设计要避免的那种谎话。
 *
 * 机器级存储查一半、不查一半，是有意为之：
 * - 机器级 **Disallowed** 必须查：显式不信任按公开行为同时看用户级与机器级（第 8 条），
 *   漏掉它，"用户 Root 有、机器级 Disallowed 也有"的证书会被报成 'trusted' ——
 *   这是本 driver 唯一一条能产生假 trusted 的路径。读机器级存储一般不需要管理员
 *   （第 7 条），所以这条查询不破坏"不需要管理员"的承诺
 * - 机器级 **Root** 不查：那不是这个 driver 装的（装它要管理员），卸载也卸不掉它
 *   （要管理员）。把它算成 'trusted' 会让 uninstall 变成一句空话，所以宁可只管
 *   CurrentUser 这一份，并在这里写明范围
 *
 * ## 不确定不猜：三态 + fail-closed
 *
 * queryPresence 的回答是**三态**（确定有 / 确定没有 / 查不出来），不是布尔：
 * 「退出码 0 但一行指纹都解析不出」曾经被判成"存在"（fail-open），它依赖一个
 * 从未验证过的假设 —— 第 1 条说 -store 无匹配必然非 0 退出。假设不成立时它会
 * 谎报 installed / trusted，而谎报 installed 会让用户以为装好了。现在的规则是
 * **不确定不往乐观方向倒**：
 * - inspect 只在三条查询都确定且方向一致时才报 'trusted'；证据只够说"在库里"
 *   就报 'installed'；连这都够不上就抛错，不替 certutil 猜；
 * - uninstall 把"查不出来"按"可能在里面"处理 —— 删除对不存在的证书是幂等的
 *   （deleteFrom 容忍 CRYPT_E_NOT_FOUND），宁可多发一条删除命令，也要让
 *   "证书不在库里"这个目标状态真的达成。
 *
 * ## 判定为什么不依赖 certutil 的文本
 *
 * 同一个命令，中文 Windows 打 "证书哈希(sha1)"、英文打 "Cert Hash(sha1)"；而且中文
 * Windows 的控制台程序按本地代码页（GBK）输出，Node 默认按 UTF-8 解码，中文部分还会
 * 变成一片替换字符。任何"先找标签、再取右边"的解析都在赌系统语言 + 赌编码。
 * 本文件的选择是：
 *   * 主判据是**退出码**（CRYPT_E_NOT_FOUND 是数字，不随语言变）；
 *   * 交叉核对用**括号里的算法名**（`(sha1)` / `(sha256)`）—— 它是 certutil 输出里
 *     唯一不会随语言变的锚点（已核实中文输出是 `证书哈希(sha1)`），值本身也全是
 *     ASCII 十六进制，任何代码页下解码都是原样。
 *
 * ## 其它约定
 *
 * - 核心模块不许 import electron：本文件只用 node:child_process 和 node:crypto，
 *   命令执行走可注入的 runner（生产是 execFile，测试是假实现）
 * - 失败一律抛 CertificateError（契约里的错误类型），stderr 字段放一手输出
 * - certutil 只按名字调用：Windows 自带、在 System32 里，而 System32 的绝对路径
 *   依赖系统盘符（%SystemRoot%），拼绝对路径反而会错
 */

/** certutil 在 Windows 上随系统自带，按名字调用由 PATH/系统目录解析 */
const CERTUTIL = 'certutil';

/** 当前用户的"受信任的根证书颁发机构"。装进这里就等于被信任（见文件头） */
export const ROOT_STORE = 'Root';

/**
 * "不受信任的证书"存储（MMC 里显示为"不受信任的证书"）。在里面的证书即使同时
 * 也在 Root 里，CryptoAPI 也不信任它。
 *
 * 这个存储有**用户级和机器级两份**：install / uninstall 只写用户级（带 -user，
 * 不需要管理员）；inspect 还会用同名的机器级那份做一次**只读**查询（不带 -user），
 * 因为机器级的不信任同样压制信任 —— 漏掉它是本 driver 唯一一条假 trusted 路径
 * （见文件头与 inspect 的注释）。
 */
export const DISALLOWED_STORE = 'Disallowed';

/**
 * 单条命令的超时上限（毫秒）。
 *
 * 为什么必须有：certutil 一旦卡住（存储被别的进程占着、crypt32 初始化出问题）不设
 * 超时就是**永久**挂起，而 inspect / install 都在用户点了按钮之后的等待路径上。
 * 为什么是 5 秒：这些命令只碰本地证书存储，正常几十毫秒返回，留了两个数量级的余量；
 * 与 system-proxy 的两个 driver 取同一个值，将来抽公共模块时不用再对齐一次。
 */
export const COMMAND_TIMEOUT_MS = 5_000;

export interface CommandResult {
  stdout: string;
  stderr: string;
  /** 退出码；进程压根没起来（certutil 不在）时为 null，原因在 stderr 里 */
  code: number | null;
  /**
   * 命令超时、被我们杀掉时为 true。这时 code 也是 null（被信号终止没有退出码），
   * 不单独标一笔就会和"进程压根没起来"混成同一条错误，排查方向直接被带偏。
   */
  timedOut?: boolean;
}

/**
 * 命令执行包一层：测试注入假实现，就能在 mac 上把 driver 的行为完整跑一遍。
 *
 * 和 system-proxy 的 win32 driver 一样，这里**不**用"非零退出就抛错"的约定，
 * 而是把退出码原样带回来：证书查询分不出"没找到"和"真失败"就只能瞎猜，
 * 只有拿到退出码才能自己判断（见 queryPresence）。代价是和 darwin 那边的 runner
 * 约定不一样，将来抽公共模块时得先统一这里。
 */
export type CommandRunner = (file: string, args: string[]) => Promise<CommandResult>;

export interface CommandInvocation {
  file: string;
  args: string[];
}

const toExitCode = (error: unknown): number | null => {
  if (error === null || error === undefined) return 0;
  if (typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'number') return code;
  }
  // ENOENT / 被信号杀掉：没有可用的退出码
  return null;
};

/**
 * runner 工厂：超时时长可注入，测试用几十毫秒快速验证超时路径，生产走默认值。
 *
 * 超时用 AbortController，而不是"另起一个定时 Promise 来 race"：race 只让调用方
 * 不再等，挂住的子进程还活着、事件循环仍被它钉住 —— 进程照样退不掉，等于没修。
 * 到点 abort 会把子进程真的杀掉；是否超时用本函数自己的 timedOut 标记，
 * 不去猜错误对象上的 killed / signal 字段（别的失败形态也会带这些字段）。
 * 做法与 system-proxy 的 win32 driver 一致，只是这里的失败按本文件的约定原样返回、不抛。
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
          // windowsHide：不然每查一次证书都会在用户屏幕上闪一个黑框。
          // 绝不能开 shell：证书路径由调用方给出，走 shell 等于把路径交给 cmd 再解释一遍
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

// ------------------------------------------------------------------ 纯函数：指纹归一化

/**
 * 把 certutil 打的指纹统一成**大写、无分隔符**的十六进制。
 *
 * 为什么需要：同一张证书，certutil 在不同版本/命令上可能打成 `aa bb cc…`（按字节
 * 分组、带空格）也可能打成连续十六进制，大小写也不保证；而契约里的 fingerprint256
 * 明确规定是"大写、无分隔符"（types.ts），certutil 的 certid 匹配也按十六进制文本
 * 比对。比较、查询、删除之前必须先把两边都收敛到同一种写法。
 *
 * 去掉一切非十六进制字符是有意为之：空格、`:`、连字符都不该影响"是不是同一个指纹"。
 */
export const normalizeThumbprint = (raw: string): string =>
  raw.replace(/[^0-9a-fA-F]/g, '').toUpperCase();

// ------------------------------------------------------------------ 纯函数：certutil 输出解析

export interface CertutilHash {
  /** 小写算法名，就取括号里写的那个（sha1 / sha256 / md5） */
  algorithm: string;
  /** 归一化后的十六进制（大写、无分隔符） */
  value: string;
}

/**
 * 从 certutil 输出里抽出所有指纹行。
 *
 * 锚点选**括号里的算法名**，不是它左边的标签：标签是本地化文案 —— 英文
 * `Cert Hash(sha1)`、中文 `证书哈希(sha1)`（已核实）—— 而括号里的 `(sha1)`
 * 不翻译。值只取紧跟其后的十六进制（可带分隔空白），遇到别的字符就停：
 * 后面万一跟了注释之类的文本，也不会被并进指纹里。
 * 分隔符同时认半角冒号和全角冒号（本地化输出可能用全角标点）。
 *
 * 代价：`Key Id Hash(sha1)` 这类**别的**哈希也会被收进来。这不影响判定 ——
 * 调用方只问"输出里有没有我们这张证书的指纹"（见 queryPresence），
 * 多收的项既不会造成误判，也不值得为它去解析本地化的标签。
 *
 * 取不到像指纹的东西（值为空、归一化后长度不够、长度是奇数）直接丢掉：
 * 宁可少认几行，也不要拿一段残缺的十六进制去和真指纹比对。
 */
export const parseCertutilHashes = (stdout: string): CertutilHash[] => {
  const hashes: CertutilHash[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    // 值部分只吃十六进制字符和空白：中文 Windows 的 GBK 标签在这里已经被跳过，
    // 而十六进制全是 ASCII —— 任何代码页下解码都是原样
    for (const match of line.matchAll(
      /\((md5|sha1|sha256)\)\s*[:：]\s*([0-9a-fA-F][0-9a-fA-F\s]*)/gi
    )) {
      const value = normalizeThumbprint(match[2]);
      // 指纹最短的是 MD5（32 个十六进制字符），短的只能是别的东西（序列号之类）
      if (value.length < 32 || value.length % 2 !== 0) continue;
      hashes.push({ algorithm: match[1].toLowerCase(), value });
    }
  }

  return hashes;
};

// ------------------------------------------------------------------ 纯函数：PEM → 指纹

export interface PemThumbprints {
  /** 大写无分隔的 SHA-1 */
  sha1: string;
  /** 大写无分隔的 SHA-256，与契约里的 fingerprint256 同一形态 */
  sha256: string;
}

/**
 * 从 PEM 推出证书的两种指纹。为什么自己算，而不是只用契约给的 fingerprint256：
 *
 * - certutil 的 certid（-store 的匹配串、-delstore 的删除目标）文档里列出的匹配形式
 *   只有 **SHA-1** 哈希（"a SHA-1 certificate, CRL, CTL or public key hash"），
 *   没有 SHA-256。按指纹查、按指纹删都只能用 SHA-1，而契约里的 CertificateInfo
 *   只有 fingerprint256 —— 不自己从 PEM 推一个 SHA-1 出来，这两条路径就没法按指纹走。
 * - 有了两个指纹，输出里的 `Cert Hash(sha1)` 和 `Cert Hash(sha256)` 哪个出现都能对上。
 *
 * 指纹的定义是**DER 编码**的哈希，不是 PEM 文本的哈希：先剥掉 PEM 头尾、解码 base64，
 * 再算哈希（这一点跟 openssl x509 -fingerprint 对齐过）。
 */
export const thumbprintsOfPem = (pem: string): PemThumbprints => {
  // 只认 BEGIN/END CERTIFICATE 之间的内容，两种理由：
  // 一是 pem 里混进别的文本时（注释、第二张证书）不该把那些字节也算进 DER；
  // 二是 Node 的 base64 解码很宽容 —— 一段根本不是 base64 的文本也会解出几个字节，
  // 光看"解码结果非空"判断不了输入是否有效
  const body = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/.exec(pem)?.[1];
  if (body === undefined) {
    throw new CertificateError(
      'CertificateInfo.pem 里找不到 BEGIN/END CERTIFICATE 块，无法推导指纹'
    );
  }

  // 里面的空白（换行、缩进）是 PEM 的排版，不是数据
  const der = Buffer.from(body.replace(/\s+/g, ''), 'base64');
  if (der.length === 0) {
    throw new CertificateError('CertificateInfo.pem 里的证书块解不出 DER，无法推导指纹');
  }

  // DER 证书一定以 ASN.1 SEQUENCE（0x30）开头；不是就别往下算了 ——
  // 算出来的"指纹"对不上任何真实证书，错误还要晚一步才暴露
  if (der[0] !== 0x30) {
    throw new CertificateError(
      'CertificateInfo.pem 解出来的内容不是 DER 证书（首字节不是 SEQUENCE）'
    );
  }

  return {
    sha1: createHash('sha1').update(der).digest('hex').toUpperCase(),
    sha256: createHash('sha256').update(der).digest('hex').toUpperCase()
  };
};

// ------------------------------------------------------------------ 纯函数：命令行构造

/**
 * 查存储：用户级是 `certutil -user -store <store> <certid>`，
 * 机器级（scope = 'machine'）是 `certutil -store <store> <certid>`。
 *
 * `-user` 是用户级的关键：certutil 默认操作**机器级**存储（读一般不需要管理员，
 * 写才要），带上它才落在 HKCU 下的 CurrentUser 存储 —— install / uninstall 的承诺
 * 就是"不需要管理员"。反过来，机器级 Disallowed 必须**不带** -user 才查得到
 * （见 inspect：它是唯一能压制信任的机器级信号）。
 * certid 用 SHA-1 指纹（certutil 文档列出的匹配形式里唯一的哈希）。
 * 选项写在动词前面，与文档语法 `certutil [options] -store …` 一致；注意
 * -store / -addstore / -delstore 的 options 列表在文档里并不相同（见文件头第 5 条）。
 */
export const buildStoreQueryInvocation = (
  store: string,
  certId: string,
  scope: 'user' | 'machine' = 'user'
): CommandInvocation => ({
  file: CERTUTIL,
  args: scope === 'user' ? ['-user', '-store', store, certId] : ['-store', store, certId]
});

/**
 * 装证书：`certutil -addstore -user Root <certPath>`。
 *
 * 装进的是**用户**的 Root 存储 —— 装完就受信任（见文件头）。选项放在动词后面：
 * 与社区里 -addstore 的常见写法一致；而文档语法写成 `certutil [options] -addstore …`
 * （选项在动词前），且给 -addstore 列出的 options 与 -store 不同。两种顺序都没有
 * 真机验证过（见文件头第 5 条）—— 真机联调时如果这条命令报参数错误，先把选项
 * 挪到动词前面试。
 */
export const buildAddStoreInvocation = (certPath: string): CommandInvocation => ({
  file: CERTUTIL,
  args: ['-addstore', '-user', ROOT_STORE, certPath]
});

/**
 * 从存储删证书：`certutil -delstore -user Root <certId>`。
 *
 * 删除目标同样用 SHA-1 指纹：那是 certid 支持的匹配形式，而且指纹唯一，
 * 不会像按 CN 删那样一次带走同名的旧 CA。选项位置同 -addstore，同样未真机验证
 * （见文件头第 5 条）。
 */
export const buildDelStoreInvocation = (store: string, certId: string): CommandInvocation => ({
  file: CERTUTIL,
  args: ['-delstore', '-user', store, certId]
});

// ------------------------------------------------------------------ 失败判据

/** CryptoAPI 的 CRYPT_E_NOT_FOUND：目标不在存储里 */
const CRYPT_E_NOT_FOUND = 0x80092004;

/**
 * "没找到"的两条判据，都不看语言：
 *
 * 1. 退出码等于 CRYPT_E_NOT_FOUND。certutil 把 HRESULT 直接当进程退出码，
 *    所以同一个值既可能以有符号（-2146885628）也可能以无符号（2148081668）形态
 *    回到 Node 里 —— `>>> 0` 统一成无符号 32 位，两侧都对得上。
 * 2. certutil 的 `FAILED: 0x80092004 (…)` 行里那个**数字**。它不随语言变，
 *    是退出码判据的兜底：退出码的符号/宽度在不同 Windows 版本上没验证过（见文件头），
 *    而报错行里的错误编号是稳定的。
 */
const isNotFound = (result: CommandResult): boolean =>
  (result.code !== null && result.code >>> 0 === CRYPT_E_NOT_FOUND) ||
  /0x80092004/i.test(result.stdout) ||
  /0x80092004/i.test(result.stderr);

/**
 * 失败的一行描述。超时被杀时 code 是 null，报"未启动"会把排查方向带偏，所以单独认一下。
 */
const describeFailure = (result: CommandResult): string =>
  result.timedOut === true ? '超时被终止' : `退出码 ${result.code ?? '未启动'}`;

/**
 * certutil 的错误文本走哪条流没有可靠结论（文档不写，社区两种说法都有），所以两条流
 * 都读：stderr 优先（错误信息该待的地方），为空时回落到 stdout。
 *
 * 返回的就是要放进 CertificateError.stderr 的那段一手信息 —— 字段名虽叫 stderr，
 * 契约里它的用途是"带上原始输出便于归因"（types.ts），比执着于流名有用。
 */
const describeOutput = (result: CommandResult): string =>
  result.stderr.trim() || result.stdout.trim();

// ------------------------------------------------------------------ driver

/**
 * 一个存储里"有没有我们的证书" —— 三态的内部表示，只在本文件内流转。
 *
 * 为什么不是布尔：certutil 的输出解析不了时，"存在"和"不存在"都无从谈起
 * （见 queryPresence 与文件头的 fail-closed 一节）。把"查不出来"压成 true 或
 * false 都是在替 certutil 猜，而这个文件的设计前提是"不确定就不猜"。
 */
type StorePresence = 'present' | 'absent' | 'unknown';

export interface Win32TrustDriverOptions {
  runner?: CommandRunner;
  /**
   * 只为可测性存在：在 macOS 上跑单测时把它假扮成 'win32'。
   * 生产代码不传，默认取 process.platform。
   */
  hostPlatform?: NodeJS.Platform;
}

/** 一次操作要用的两个指纹，来自同一份 pem */
type CertMaterial = PemThumbprints;

export class Win32CertificateTrustDriver implements CertificateTrustDriver {
  readonly platform = 'win32' as const;

  private readonly runner: CommandRunner;
  private readonly hostPlatform: NodeJS.Platform;

  constructor(options: Win32TrustDriverOptions = {}) {
    this.runner = options.runner ?? createExecFileRunner();
    this.hostPlatform = options.hostPlatform ?? process.platform;
  }

  /**
   * 三态判定：并行查三个存储再组合 —— 用户 Root、用户 Disallowed、**机器级
   * Disallowed**（为什么是这三个见文件头）。三个查询互不依赖，并行发省掉两份等待。
   *
   * 组合规则（每条查询的答案已经被 queryPresence 收敛成"确定有 / 确定没有 /
   * 查不出来"）：
   * - 'trusted' 要求三个都是确定结论且方向一致：用户 Root 有、用户 Disallowed 没有、
   *   机器级 Disallowed 也没有。任何一条是"查不出来"都不能报 —— 那等于替 certutil
   *   猜，而猜错的方向必然是把"系统其实不信任"说成"受信任"（见文件头第 7、8 条）
   * - 只要有一条确定"有"就至少是 'installed'：certutil 确实把证书找到了
   *   （用户 Root 里那份被 Disallowed 压过、或只在某个 Disallowed 里，语义都一样）
   * - 三个都确定"没有"才是 'not-installed'
   * - 剩下的情况（没有任何确定"有"，又存在"查不出来"）抛错：这时 trusted 和
   *   not-installed 都是在猜，唯一的诚实回答是"没法确认"
   */
  async inspect(info: CertificateInfo): Promise<TrustState> {
    this.assertWin32();
    const material = certMaterialOf(info);

    const [inRoot, inDisallowed, inMachineDisallowed] = await Promise.all([
      this.queryPresence(ROOT_STORE, material, `用户 ${ROOT_STORE} 存储`),
      this.queryPresence(DISALLOWED_STORE, material, `用户 ${DISALLOWED_STORE} 存储`),
      this.queryPresence(DISALLOWED_STORE, material, `机器级 ${DISALLOWED_STORE} 存储`, 'machine')
    ]);

    // 用户 Root 有、两份 Disallowed 都没有：这才是"在证书库里且被信任"
    if (inRoot === 'present' && inDisallowed === 'absent' && inMachineDisallowed === 'absent') {
      return 'trusted';
    }
    // 在任一个存储里都算"装上了"，但不构成信任：Root 里那份被 Disallowed 压过
    // （用户的或机器级的），或者只在 Disallowed 里（从 Root 删过、或手动标过"不受信任"）
    if (inRoot === 'present' || inDisallowed === 'present' || inMachineDisallowed === 'present') {
      return 'installed';
    }
    if (inRoot === 'absent' && inDisallowed === 'absent' && inMachineDisallowed === 'absent') {
      return 'not-installed';
    }

    // 到这里的唯一可能：没有任何一条确定"有"，又至少有一条"查不出来"（否则上面已返回）
    const unknown = [
      inRoot === 'unknown' ? `用户 ${ROOT_STORE} 存储` : '',
      inDisallowed === 'unknown' ? `用户 ${DISALLOWED_STORE} 存储` : '',
      inMachineDisallowed === 'unknown' ? `机器级 ${DISALLOWED_STORE} 存储` : ''
    ]
      .filter((name) => name !== '')
      .join('、');

    throw new CertificateError(
      `无法确认证书的信任状态：${unknown}的查询退出码为 0，但输出里解析不出任何指纹，` +
        '既不能据此说「存在」，也不该反过来说「不存在」。为避免谎报状态，这里如实报错'
    );
  }

  /**
   * 装进**用户**的 Root 存储（不需要管理员；机器级存储才要）。
   *
   * ⚠️ 平台差异：装进去就是"受信任"，没有 macOS 那种"导入但没设始终信任"的中间态
   * （见文件头）。所以 install 之后 inspect 正常应直接返回 'trusted'；若还是
   * 'installed'，只可能是同一张证书同时躺在用户级或机器级的 Disallowed 里。
   *
   * 不做"已经装过就跳过"的预检查：一是契约没要求 install 幂等，二是重复 -addstore
   * 的退出码真机上没验证过（见文件头第 6 条），猜错会把"装第二遍"变成假失败。
   * 调用方要幂等，先 inspect 再决定。
   */
  async install(certPath: string): Promise<void> {
    this.assertWin32();

    // 空路径交给 certutil 只会得到一条难认的参数错误，不如在动手前挡住
    if (certPath.trim() === '') {
      throw new CertificateError('证书路径为空，拒绝执行 certutil -addstore');
    }

    await this.runOk(
      buildAddStoreInvocation(certPath),
      `把证书装进用户 ${ROOT_STORE} 存储（受信任的根证书颁发机构）`
    );
  }

  /**
   * 从用户级的两个存储里移除我们的证书，**幂等**：没装过时一条删除命令都不发，直接成功。
   *
   * 为什么先查再删、而不是"直接删、把 CRYPT_E_NOT_FOUND 当成功"：
   * 1. 只有查清楚才知道要删哪个存储（只在 Disallowed 里时不能去删 Root）；
   * 2. "没装过"是常见路径（用户点重复卸载），这条路上不该产生看着像失败的 certutil 报错。
   * 查完到删之间的竞态（别人正好删了）由 deleteFrom 容忍 CRYPT_E_NOT_FOUND 兜住。
   * "查不出来"按"可能在里面"处理：多删一条不存在的证书是幂等的（deleteFrom 兜底），
   * 漏删一条真实存在的才是没达成目标状态（fail-closed 的取舍，见文件头）。
   *
   * 删除顺序 Root 在前：反过来的话，Root 里那份还在、Disallowed 里那条已经没了，
   * 中间会有一小段"这张证书重新被信任"的窗口 —— 虽然最终状态一样，但中间态是反的。
   *
   * 机器级 Disallowed：**只查不删**。写机器级存储要管理员，本 driver 不做（见文件头）；
   * 但查到里面有我们的证书时要抛错说清楚 —— 那张证书会一直压制信任，清完用户级后
   * 静默返回成功，只会让用户以为卸干净了，而下一次 inspect 仍报 'installed'。
   * uninstall 的"成功"只承诺它管得到的用户级，管不到的部分不假装成功。
   */
  async uninstall(info: CertificateInfo): Promise<void> {
    this.assertWin32();
    const material = certMaterialOf(info);

    const [inRoot, inDisallowed, inMachineDisallowed] = await Promise.all([
      this.queryPresence(ROOT_STORE, material, `用户 ${ROOT_STORE} 存储`),
      this.queryPresence(DISALLOWED_STORE, material, `用户 ${DISALLOWED_STORE} 存储`),
      this.queryPresence(DISALLOWED_STORE, material, `机器级 ${DISALLOWED_STORE} 存储`, 'machine')
    ]);

    // "查不出来"（unknown）也照删：删除是对不存在的证书幂等的，先删才能确定目标达成
    if (inRoot !== 'absent') {
      await this.deleteFrom(ROOT_STORE, material.sha1, `用户 ${ROOT_STORE} 存储`);
    }
    if (inDisallowed !== 'absent') {
      await this.deleteFrom(DISALLOWED_STORE, material.sha1, `用户 ${DISALLOWED_STORE} 存储`);
    }

    if (inMachineDisallowed === 'present') {
      throw new CertificateError(
        `用户级存储已处理，但证书仍在机器级 ${DISALLOWED_STORE} 存储里，系统会继续显式不信任它。` +
          '本 driver 不写机器级存储，移除它需要管理员权限' +
          `（可在提升的终端里执行 certutil -delstore ${DISALLOWED_STORE} ${material.sha1}）`
      );
    }
  }

  // ---------------------------------------------------------------- 内部实现

  /**
   * 这个存储里有没有我们的证书 —— 返回**三态**（StorePresence），不是布尔。
   *
   * 各分支（都不看被翻译的文本）：
   * 1. 退出码 0 且解析出的指纹与证书对得上 → 'present'（certutil 匹配到了我们这一张）。
   *    指纹交叉核对是必须的：certid 的匹配形式不止哈希（官方文档列了序列号等一串
   *    类型，且"用 CertId 匹配时会对每个证书遍历所有类型"），一串 40 位十六进制
   *    也可能按序列号命中别的证书，那样退出码同样是 0。
   * 2. 退出码 0 但**一行指纹都解析不出**（输出格式和我们认识的不同）→ 'unknown'。
   *    这里曾经按"退出码 0 = 命中"返回 true，依赖一个从未验证过的假设：
   *    certutil -store 无匹配时必然返回非 0（见文件头第 1 条）。官方文档不写 -store
   *    的退出码，假设不成立时它会把"什么都没查到"说成"证书存在"，上层随即报出
   *    假的 trusted / installed。**不确定不能往乐观方向倒**：既不据此说"存在"，
   *    也不反过来说"不存在"，只诚实回答"查不出来"，由上层按 fail-closed 的规则处理
   *    （见 inspect / uninstall）。
   * 3. 退出码 0 但解析出的指纹全是别人的 → 抛错：这时连"我们这张到底在不在"都
   *    无从谈起，是一种"没法诚实回答"的状态。静默答"没装"会诱导上层去装第二遍，
   *    答"装好了"更是直接说假话 —— 三态设计的全部意义就是不说这种假话。
   * 4. CRYPT_E_NOT_FOUND → 'absent'（确定不存在）。
   * 5. 其余退出码 / 超时 / 起不来 → 抛错（"读取失败"和"没装"混为一谈，会让上层
   *    拿一个错误的结论去引导用户）。
   */
  private async queryPresence(
    store: string,
    material: CertMaterial,
    what: string,
    scope: 'user' | 'machine' = 'user'
  ): Promise<StorePresence> {
    const result = await this.run(
      buildStoreQueryInvocation(store, material.sha1, scope),
      `查询${what}`
    );

    // 查询用 SHA-1 当 certid（见 thumbprintsOfPem），匹配到的基本就是我们这一张
    if (result.code === 0) {
      const hashes = parseCertutilHashes(result.stdout);
      // 解析不出指纹 = 查不出来，而不是"存在"（fail-closed，见上方注释与文件头）
      if (hashes.length === 0) return 'unknown';

      const matched = hashes.some(
        (entry) => entry.value === material.sha1 || entry.value === material.sha256
      );
      if (matched) return 'present';

      throw new CertificateError(
        `certutil 在${what}里匹配到的证书，与证书信息里的指纹对不上（输出里的指纹和 pem 推出来的不一致）`,
        describeOutput(result)
      );
    }

    if (isNotFound(result)) return 'absent';

    throw new CertificateError(
      `查询${what}失败（${describeFailure(result)}）`,
      describeOutput(result)
    );
  }

  private async deleteFrom(store: string, certId: string, what: string): Promise<void> {
    const result = await this.run(buildDelStoreInvocation(store, certId), `从${what}删除证书`);

    if (result.code === 0) return;

    // 查过之后、删之前，证书被别人（用户自己、别的工具、另一份 Reqeek）删掉了：
    // 目标状态已经达成，这正是幂等该有的样子，不算失败
    if (isNotFound(result)) return;

    throw new CertificateError(
      `从${what}删除证书失败（${describeFailure(result)}）`,
      describeOutput(result)
    );
  }

  /**
   * 执行一条命令，把"进程压根没起来"和超时变成 CertificateError。
   * 退出码原样带回：查询路径要靠它区分"没找到"和"真失败"（见 queryPresence）。
   */
  private async run(invocation: CommandInvocation, what: string): Promise<CommandResult> {
    let result: CommandResult;

    try {
      result = await this.runner(invocation.file, invocation.args);
    } catch (cause) {
      // runner 自己抛错 = 命令没跑起来（certutil 不存在、被策略拦下），
      // 和"certutil 执行了但退出码非 0"是两回事，错误里要分开
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new CertificateError(`无法执行 certutil：${what}（${reason}）`);
    }

    if (result.timedOut === true) {
      // 不写死秒数：超时时长可以由注入的 runner 决定（测试用几十毫秒），
      // 报一个和实际不符的数字只会误导排障
      throw new CertificateError(
        `certutil 执行超时：${what}（没有在超时时限内返回，已终止该命令）`
      );
    }

    return result;
  }

  /** 期望成功的命令（安装、删除）：非零退出统一按失败抛 */
  private async runOk(invocation: CommandInvocation, what: string): Promise<CommandResult> {
    const result = await this.run(invocation, what);

    if (result.code !== 0) {
      throw new CertificateError(
        `certutil 执行失败：${what}（${describeFailure(result)}）`,
        describeOutput(result)
      );
    }

    return result;
  }

  /**
   * 注意：这里抛错而不是返回 'unsupported'。'unsupported' 是**平台分发层**的状态
   * （比如 Linux 上还没实现），不是"把 win32 driver 拿到 mac 上调用"的答案 ——
   * 后者是调用方接错了 driver，必须当场炸掉；返回 'unsupported' 会把一个接线错误
   * 静默地伪装成平台结论。
   */
  private assertWin32(): void {
    if (this.hostPlatform !== 'win32') {
      throw new CertificateError(
        `Windows 的证书信任 driver 只能在 win32 上调用，当前平台是 ${this.hostPlatform}`
      );
    }
  }
}

/**
 * 把一份 CertificateInfo 收敛成本次操作要用的两个指纹。
 *
 * 契约说 fingerprint256 就是这张证书的 SHA-256（types.ts），而从 pem 再推一次
 * 是**交叉验证**：两者对不上，说明调用方把两张证书的信息拼在了一起。这时候按 pem
 * 推导出的指纹去删的是 A，调用方以为删的是 B —— 宁可在动手之前炸掉，也不要照着
 * 一份自相矛盾的输入去改系统信任库。
 */
const certMaterialOf = (info: CertificateInfo): CertMaterial => {
  const material = thumbprintsOfPem(info.pem);
  const declared = normalizeThumbprint(info.fingerprint256);

  if (declared !== material.sha256) {
    throw new CertificateError(
      `CertificateInfo.fingerprint256 与 pem 推出来的 SHA-256 不一致，拒绝操作` +
        `（声明值 ${declared === '' ? '不是十六进制' : declared}，pem 算出 ${material.sha256}）`
    );
  }

  return material;
};
