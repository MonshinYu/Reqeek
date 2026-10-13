/**
 * CONNECT 目标 / Host 头 → 「host + isIp」的归一化。
 *
 * 为什么值得单独一个文件：leaf 证书的 SAN 只有两种写法 —— 域名用 dNSName，
 * IP 字面量用 iPAddress。填错的话证书照样签发得出来，但客户端一律不认，失败现象是
 * 「握手莫名失败」，几乎无法从错误里往回追到 SAN 上（见 types.ts 的 LeafRequest.isIp）。
 * 所以这里的每个判断只求一件事：**要么给出精确答案，要么返回 null，让调用方把它
 * 退回隧道透传**。隧道那条路不签证书，永远不会因为这里拿不准而失败 ——
 * 宁可不解密，也不签一张对不上的证书。
 *
 * 另一个理由：@peculiar/x509 对可疑输入是**静默将就**的（对着它的 build/index.d.ts
 * 和真的签一张证书实测过）：
 * - { type: 'dns', value: '例子.中国' } 不报错，按 latin1 乱编 —— 它不替你转 punycode
 * - { type: 'ip',  value: 'fe80::1%en0' } 不报错，把 zone id 悄悄丢掉，编成 fe80::1
 * - { type: 'dns', value: '*.example.com' } 不报错，原样编进 SAN
 * 三种都只会得到一张对不上的、甚至不该签的证书，所以脏活必须在这里干完。
 *
 * 这一层不 import electron、不碰网络、不落盘：输入就是从 HTTP 里解析出来的原始字符串。
 */

import {isIPv4, isIPv6} from 'node:net';
import {domainToASCII} from 'node:url';
import type {DNS, IP, JsonGeneralName} from '@peculiar/x509';

/**
 * SAN 条目的 type 字面量，逐字对齐 @peculiar/x509（build/index.d.ts：
 * `declare const DNS = "dns"` 与 `declare const IP = "ip"`；运行时 build/x509.cjs.js
 * 里也是这两个值）。
 *
 * 这里用 satisfies 而不是裸字符串：库哪天改了字面量，会在**编译期**失败，
 * 而不是等运行期握手不过才回头找。satisfies 只做检查不改变类型，值仍是字面量，
 * 所以下面 sanEntry 的返回值能直接满足 JsonGeneralName。
 */
const DNS_TYPE = 'dns' satisfies typeof DNS;
const IP_TYPE = 'ip' satisfies typeof IP;

export interface NormalizedHost {
  /** 归一化后的主机：域名是小写 punycode 形态，IP 是规范写法（无方括号、无端口） */
  host: string;
  /** true 表示 host 是 IP 字面量 —— SAN 必须用 iPAddress，不是 dNSName */
  isIp: boolean;
}

/** 域名的长度上限是 253；再把尾点、方括号、":65535" 都算上也到不了 264 */
const MAX_RAW_LENGTH = 264;
const MAX_DOMAIN_LENGTH = 253;
/** 单个 DNS 标签：1..63 个 LDH 字符（字母数字连字符），且首尾不能是连字符 */
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const PORT_RE = /^[0-9]{1,5}$/;

/**
 * 域名输入里不允许出现的**可打印 ASCII** —— 除 LDH 与点之外的全部：
 * ! " # $ % & ' ( ) * + , / : ; < = > ? @ [ \ ] ^ _ ` { | } ~
 *
 * 写成码位范围而不是把 / ? # @ \ % 逐个列出来：黑名单枚举永远会漏，而这里的语义
 * 本来就是「ASCII 段里不是 LDH 或点的都不该出现在域名里」。低于 0x21 的那批
 * （控制字符、空格）交给下面按 Unicode 类别拒的正则，这里只管可打印段。
 *
 * 为什么必须**在 domainToASCII 之前**拒（而且必须覆盖含非 ASCII 的输入）：
 * domainToASCII 内部带着 URL 解析 + UTS#46 两套逻辑，会把同一个名字换成另一个：
 * - 在 / 处截断：'例子.中国/path' → 'xn--fsqu00a.xn--fiqs8s'（后面整段被吃掉）
 * - 让 % 混进标签编码：'例子.com%41' → 'xn--fsqu00a.xn--a-kq6ay5z'（看着合法，其实是别的名字）
 * 转换后的输出形态全都合法，最后的 LDH 复核看不出差别 —— 所以只能在这里拒。
 */
const INVALID_ASCII_HOST_RE = /[\u0021-\u002C\u002F\u003A-\u0040\u005B-\u0060\u007B-\u007E]/;

/**
 * 非 ASCII 侧的拒绝清单，按 **Unicode 类别** 而不是具体字符（枚举永远会漏）：
 * - Cc / Cf：控制字符与格式字符
 * - Zs / Zl / Zp：各种空白（NBSP、em space、行/段分隔符……）
 * - Default_Ignorable_Code_Point：默认不可见类 —— 最要命的一批，因为 UTS#46 会
 *   把它们**静默删除**，删完的 LDH 复核看不出任何差别。实测 Node 的 domainToASCII
 *   会删掉全部 294 个 DI 码点：U+200B 零宽空格、U+00AD 软连字符、U+FEFF、
 *   变体选择符（U+FE00..U+FE0F、U+E0100..E01EF）、U+034F、U+180B..U+180F……
 *   注意 U+034F / U+FE0F 的 Unicode 类别是 Mn（不是 Cf），只有 DI 这个属性覆盖得到，
 *   所以三个类别缺一不可。
 * 这些都是「正常域名里根本不该出现」的字符：拒掉最多损失一次解密（回退隧道），
 * 放过去则是给另一个名字签证书。
 */
const INVALID_UNICODE_HOST_RE = /[\p{Cc}\p{Cf}\p{Zs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

/**
 * 把 CONNECT 的 authority-form（`example.com:443`）或 Host 头值归一成可签的名字。
 * 认不出来就 null —— 调用方应把它当成「这个目标不解密」，走隧道透传。
 */
export const normalizeHost = (raw: string): NormalizedHost | null => {
  // 类型上 raw 是 string，但这条路上流的是刚解析出来的不可信字节；真收到别的东西
  // 也不能让代理崩掉 —— 当认不出来的输入处理。
  if (typeof raw !== 'string') return null;

  // 空串、超长、以及任何位置的空白（含 NBSP 这类看不见的）都拒。
  // 这里**不做 trim**：Host 头到这一步之前已经被 HTTP 解析器去掉过外侧 OWS，
  // 再冒出空白只说明这行输入本身可疑，猜「用户大概想要 example.com」没有依据。
  // 这是最外层的一道闸（先于方括号/IPv6/端口解析），\s 覆盖不到的零宽字符
  // （U+200B 这类 Cf/DI）由下面 INVALID_UNICODE_HOST_RE 按类别拦。
  if (raw.length === 0 || raw.length > MAX_RAW_LENGTH) return null;
  if (/\s/.test(raw)) return null;

  // 通配符一律拒绝，不管出现在哪一段。我们是**为具体目标现签**证书的：
  // 给 *.example.com 签一张，等于把我们这份签名能力放大到整个域名（任何子域都能
  // 被我们冒名），风险完全不对等。@peculiar/x509 会老老实实把 *.example.com
  // 编进 SAN，所以只能在这一层拦。
  // 说明：就算删掉这一句，'*' 也过不了下面的字符守卫与 LDH 校验 —— 这句的价值是
  // 把这条安全规则摆在明面上，将来谁为了内网名放松了字形校验，通配符也得继续被拒。
  if (raw.includes('*')) return null;

  // ---- 方括号 IPv6：[::1]、[::1]:443 ----
  // RFC 3986 规定只有方括号形式才允许跟端口，所以这一段一并把端口剥掉。
  if (raw.startsWith('[')) {
    const close = raw.indexOf(']');
    if (close < 0) return null;
    const inner = raw.slice(1, close);
    const rest = raw.slice(close + 1);
    // 收尾只允许是空的或 ":端口"，其它一律畸形
    if (rest !== '' && !(rest.startsWith(':') && isPort(rest.slice(1)))) return null;
    // zone id（fe80::1%en0、fe80::1%25en0）必须拒：作用域只在**本机链路**上有意义，
    // 而且证书根本表达不了它 —— iPAddress 是 4/16 字节裸地址，RFC 5280 没地方放 scope。
    // 顺带一提，把 zone id 交给 @peculiar/x509 它会悄悄丢掉 %en0、签成 fe80::1，
    // 那正好是一张对不上的证书。拒掉，让这条连接回退成隧道。
    if (inner.includes('%')) return null;
    // 方括号是 IPv6 专用，[example.com]、[1.2.3.4] 都是没意义的写法
    if (!isIPv6(inner)) return null;
    return { host: canonicalIpv6(inner), isIp: true };
  }

  // ---- 不带方括号的 IPv6 字面量：::1、2001:db8::1 ----
  // 注意 `::1:443` 这种形状：整串本身就是合法的 IPv6 地址（= 0:0:0:0:0:0:1:443），
  // 而 RFC 3986 要求端口只能跟在方括号形式之后，所以这里按**地址**解析、不拆端口；
  // 真要连 ::1 的 443 端口，写法是 [::1]:443。
  if (isIPv6(raw)) {
    if (raw.includes('%')) return null;
    return { host: canonicalIpv6(raw), isIp: true };
  }

  // ---- host[:port] ----
  let host = raw;
  const colon = raw.indexOf(':');
  if (colon !== -1) {
    // 能走到这里说明整串不是合法 IPv6；那还想带端口的话，冒号最多只能有一个
    if (colon !== raw.lastIndexOf(':')) return null;
    if (!isPort(raw.slice(colon + 1))) return null;
    host = raw.slice(0, colon);
  }

  // 尾点是「这是完整域名」的合法写法（`example.com.` 与 `example.com` 等价），
  // 去掉一个再比对。只去一个：`example.com..` 多出来的是空标签，属畸形，
  // 留给下面的标签校验去拒。
  if (host.endsWith('.')) host = host.slice(0, -1);
  // 根域 `.`、只有端口没有主机（":443"）、去掉尾点后什么都不剩 —— 没有可签的名字
  if (host === '') return null;

  // ---- 规范的 IPv4 点分十进制 ----
  // net.isIPv4 对前导零 / 十六进制 / 纯整数这些别名写法一律 false（010.0.0.1、
  // 0x7f.1、2130706433 都不算），正合我意：规范写法才能明确判定，别名写法见下面。
  if (isIPv4(host)) return { host, isIp: true };

  // ---- 域名：IDN 归一化交给 Node 现成的 url.domainToASCII ----
  // 交给它之前先按**类别**把两类「会被它换成另一个名字」的输入整个拒掉
  // （实测细节写在两个正则的注释里）：
  // - ASCII 结构字符：它内部的 URL 解析会截断/改写（'example.com/pathé'、
  //   '例子.中国/path'、'例子.com%41' 都栽在这条上）
  // - 不可见字符：它内部的 UTS#46 会静默删除（'exa\u200Bmple.com' 栽在这条上）
  // 旧实现只对**纯 ASCII** 输入卡这一刀，混进一个非 ASCII 字符就整串绕过守卫 ——
  // 那正是「为另一个名字签证书」的来源，所以这两条现在对所有输入都跑，含 IDN。
  if (INVALID_ASCII_HOST_RE.test(host)) return null;
  if (INVALID_UNICODE_HOST_RE.test(host)) return null;

  // domainToASCII 和浏览器的 URL 解析用的是同一套 UTS#46：大小写折叠、punycode
  // （例子.中国 → xn--fsqu00a.xn--fiqs8s）、非法字符返回空串，都在这一步完成。
  // 但它只管「转换」不管「形态」：尾点会留着，foo..com / -foo.com / exa_mple.com /
  // 64 字符的标签也一律原样放行；映射还会把 '＿' 这类字符换成 '_' 留在结果里。
  // 所以转换结果必须再按 LDH + 点复核一遍 —— 这是输入守卫之外的第二道闸，不能省。
  const ascii = domainToASCII(host);
  if (ascii === '') return null;

  // 归一化之后摇身一变成了合法 IPv4 的，说明原输入是 IPv4 的**别名写法**：
  // 010.0.0.1 → 8.0.0.1（前导零被当八进制）、0x7f.1 与 2130706433 → 127.0.0.1、
  // 1.2.3 → 1.2.0.3、42 → 0.0.0.42（规范的 1.2.3.4 在上面一步就已经返回了）。
  // 浏览器按 WHATWG 解成哪个地址，别的客户端（libc 的 inet_aton、curl…）未必同意，
  // 签错就是「握手莫名失败」—— 这种要猜的输入不签，回退隧道。
  if (isIPv4(ascii)) return null;
  if (!isValidDomain(ascii)) return null;
  return { host: ascii, isIp: false };
};

/**
 * 给定归一化好的 host 与 isIp，产出 SAN（Subject Alternative Name）条目。
 *
 * 返回形与 @peculiar/x509 的 JsonGeneralName 完全一致，x509.ts 可以直接
 * `new SubjectAlternativeNameExtension([sanEntry(host, isIp)])`。
 * type 是 'dns' 还是 'ip' 必须跟着 isIp 走 —— 这正是 LeafRequest.isIp 要
 * 由调用方准确给出的原因：类型填错，证书签得出来但客户端不认。
 */
export const sanEntry = (host: string, isIp: boolean): JsonGeneralName => {
  return isIp ? { type: IP_TYPE, value: host } : { type: DNS_TYPE, value: host };
};

/**
 * 端口只做形态校验，不保留返回值 —— 我们只签证书，端口不参与签名。
 * 但形状不对（非数字、0、超过 65535）说明这行输入本身畸形，那就不猜了。
 */
const isPort = (text: string): boolean => {
  if (!PORT_RE.test(text)) return false;
  const port = Number(text);
  return port >= 1 && port <= 65535;
};

/**
 * 把 IPv6 字面量收敛成 WHATWG 的规范写法（小写、零段压成 `::`）。
 *
 * 同一个地址的不同拼法（`2001:0DB8:0:0::1` 与 `2001:db8::1`）应该落到同一个证书
 * 缓存 key，签出的 SAN 也不该随输入的拼法变化 —— URL 的 host 序列化干的正是这件事，
 * 而且和客户端解析 Host 时用的是同一套规则。只有 isIPv6 放行的串才会走到这里。
 */
const canonicalIpv6 = (literal: string): string => {
  // hostname 自带方括号，剥掉
  return new URL(`http://[${literal}]/`).hostname.slice(1, -1);
};

/**
 * 域名（已转成 punycode 的 ASCII 形态）的形态校验。
 *
 * 为什么不直接信任 domainToASCII：它只负责 IDN 转换，不负责 DNS 的形态规则，
 * `foo..com`、`-foo.com`、`exa_mple.com`、64 字符的标签它都原样放行。
 * 这些名字签进 dNSName 没有任何意义（公共 CA 也不会签），不如早点拒掉。
 */
const isValidDomain = (domain: string): boolean => {
  if (domain.length > MAX_DOMAIN_LENGTH) return false;
  // 空标签（连写点、首尾点）进不了 LABEL_RE，会被 every 一并拒掉
  return domain.split('.').every((label) => LABEL_RE.test(label));
};
