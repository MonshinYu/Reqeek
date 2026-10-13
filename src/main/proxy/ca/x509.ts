import 'reflect-metadata';

/**
 * 证书生成的底层：只回答「怎么造证书」。
 *
 * 三条边界，都是为将来搬家准备的（整个 ca/ 可能被塞进 utilityProcess）：
 * 1. 不碰文件系统 —— 落盘、权限、复用都在 index.ts；
 * 2. 不 import electron —— 需要的外部信息（机器名、当前时间）一律参数注入；
 * 3. 依赖自己带齐 —— 见上面第一行 import 的说明。
 *
 * 为什么 `import 'reflect-metadata'` 必须排在最前：@peculiar/x509 的装饰器在
 * **模块加载时**就要用到反射元数据，polyfill 晚一步注册，库会直接抛
 * "requires a reflect polyfill"。把 polyfill 放在本模块内部、而不是指望入口先 import
 * 一次，是为了不管谁先加载 ca/，先后顺序都是对的。
 */
import * as x509 from '@peculiar/x509';
import {createPrivateKey, createPublicKey} from 'node:crypto';
import {hostname as osHostname} from 'node:os';

import {sanEntry} from './host';
import type {CertificateInfo, LeafRequest} from './types';
import {CertificateError} from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * CA 有效期 3650 天（10 年）。
 * 与 `openssl -days 3650` 的口径一致；根证书不该频繁轮换 —— 每换一次，
 * 用户系统里装的旧根就作废一次，而重装是个要管理员参与的动作。
 */
export const CA_VALIDITY_DAYS = 3650;

/**
 * leaf 有效期 199 天。
 * 刻意压在 200 天以内：这是业界（Apple / Chrome）对"能长期自动缓存的证书"
 * 的容忍线，同时给了足够的重签窗口。
 */
export const LEAF_VALIDITY_DAYS = 199;

/**
 * notBefore 回拨 2 天。
 * 客户端时钟慢几秒、时区处理差一点都很常见，notBefore 卡在当前时刻的话，
 * 一台"慢一点"的机器会拒掉我们所有证书，现象还是"握手失败"。
 */
export const CLOCK_SKEW_DAYS = 2;

/** serverAuth 的 OID（id-kp-serverAuth） */
const SERVER_AUTH_OID = '1.3.6.1.5.5.7.3.1';

/** P-256（prime256v1）。这套参数组合已用 openssl 独立验证过 */
const KEY_GENERATOR_ALGORITHM: EcKeyGenParams = { name: 'ECDSA', namedCurve: 'P-256' };

const SIGNING_ALGORITHM: EcdsaParams = { name: 'ECDSA', hash: 'SHA-256' };

/** 内存里的根 CA：证书 + 与它配对的签名私钥 */
export interface RootCa {
  certificate: x509.X509Certificate;
  privateKey: CryptoKey;
}

/** 一次 leaf 签发的结果。私钥以 PEM 形式交给上层落盘/下发 */
export interface IssuedLeaf {
  certificate: x509.X509Certificate;
  /** PKCS#8 PEM */
  privateKeyPem: string;
}

/**
 * 生成一对 P-256 密钥。
 *
 * extractable 必须为 true：私钥要导出成 PEM 给上层，否则进程一重启这张
 * 证书就再也签不出东西了。
 */
export const generateKeyPair = async (): Promise<CryptoKeyPair> => {
  return globalThis.crypto.subtle.generateKey(KEY_GENERATOR_ALGORITHM, true, ['sign', 'verify']);
};

/**
 * 密码学随机的序列号。
 *
 * 不用 spike 里写死的 '01'，也不用有些实现爱用的 4 字节随机：抓包工具会持续
 * 签大量证书，序列号撞车（同一个签发者下）不是理论问题。
 */
export const randomSerialNumber = (): string => {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  // DER 的 INTEGER 是有符号的：最高位为 1 会被当成负数（或被编码器补一个 0x00）。
  // 这里直接清掉最高位、并把最低位置 1 —— 后者保证不为 0（RFC 5280 不允许零序列号）。
  bytes[0] = (bytes[0] & 0x7f) | 0x01;
  return Buffer.from(bytes).toString('hex').toUpperCase();
};

/**
 * 私钥导出成 PKCS#8 PEM。
 *
 * @peculiar/x509 只负责证书；私钥的 PEM 化绕一次 node:crypto，这是它缺的
 * 最后一块拼图（WebCrypto 只能导出 DER）。
 */
export const exportPrivateKeyPem = async (privateKey: CryptoKey): Promise<string> => {
  const pkcs8 = await globalThis.crypto.subtle.exportKey('pkcs8', privateKey);
  const pem = createPrivateKey({ key: Buffer.from(pkcs8), format: 'der', type: 'pkcs8' }).export({
    type: 'pkcs8',
    format: 'pem'
  });
  return String(pem);
};

/** 从 PKCS#8 PEM 导回 CryptoKey。extractable=false —— 它只用来签名，不需要再被导出 */
export const importPrivateKeyPem = async (privateKeyPem: string): Promise<CryptoKey> => {
  const keyObject = createPrivateKey(privateKeyPem);
  const pkcs8 = keyObject.export({ format: 'der', type: 'pkcs8' });
  return globalThis.crypto.subtle.importKey('pkcs8', pkcs8, KEY_GENERATOR_ALGORITHM, false, [
    'sign'
  ]);
};

/**
 * SHA-256 指纹：十六进制**大写**、无分隔符。
 * 跟 `security find-certificate` / `certutil` 的输出对齐，用户能直接拿去比对。
 */
export const fingerprint256 = async (certificate: x509.X509Certificate): Promise<string> => {
  const digest = await certificate.getThumbprint({ name: 'SHA-256' }, globalThis.crypto);
  return Buffer.from(digest).toString('hex').toUpperCase();
};

/** 转成契约里的公开信息（不含私钥）。展示、落盘、跨进程传输都用它 */
export const toCertificateInfo = async (
  certificate: x509.X509Certificate
): Promise<CertificateInfo> => ({
  commonName: certificate.subjectName.getField('CN')[0] ?? '',
  fingerprint256: await fingerprint256(certificate),
  pem: certificate.toString('pem'),
  notBefore: certificate.notBefore.getTime(),
  notAfter: certificate.notAfter.getTime()
});

export interface RootCaOptions {
  /**
   * 写进 Subject CN 的机器名，默认取本机 hostname。
   * 多台机器各自装各自的根证书时，用户一眼就能认出这张证书来自哪台机器；
   * 测试注入固定值，断言才可能确定。
   */
  hostname?: string;
  /** 当前时刻，默认 new Date()。测试注入固定时钟，才钉得住有效期 */
  now?: Date;
}

/** 生成一张自签名的根 CA 证书 */
export const createRootCa = async (options: RootCaOptions = {}): Promise<RootCa> => {
  const hostname = options.hostname ?? osHostname();
  const now = options.now ?? new Date();
  const keys = await generateKeyPair();

  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: randomSerialNumber(),
    name: [{ CN: [`Reqeek CA (${hostname})`] }, { O: ['Reqeek'] }],
    notBefore: new Date(now.getTime() - CLOCK_SKEW_DAYS * DAY_MS),
    notAfter: new Date(now.getTime() + CA_VALIDITY_DAYS * DAY_MS),
    signingAlgorithm: SIGNING_ALGORITHM,
    keys,
    extensions: [
      // CA:TRUE + critical：客户端据此认定"这张证书可以签别的证书"。
      // 少了它，哪怕装进系统信任库，它签出来的 leaf 也没人认。
      new x509.BasicConstraintsExtension(true, undefined, true),
      // keyCertSign = 允许签 leaf，cRLSign = 允许签吊销列表。
      // critical 是防误用：这张证书除签名之外什么都不能干。
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true
      ),
      // SKI：leaf 的 AKI 要指向的那把钥匙的指纹锚点。缺了它，链在 CA 这一环就断了
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey)
    ]
  });

  return { certificate, privateKey: keys.privateKey };
};

/**
 * leaf 的公钥必须和签发者的公钥不同。
 *
 * 复用 CA 私钥的话，等于把根密钥下发到每一次被解密的 TLS 握手（leaf 私钥是交给
 * 连接用的），一旦泄露，攻击者能冒充任意站点 —— 而用户系统里还信任着这张根。
 * 这类错误从签出来的证书外观上完全看不出来，所以必须在这里拦死。
 */
const assertKeyDiffersFromIssuer = async (
  leafPublicKey: CryptoKey,
  issuerCertificate: x509.X509Certificate
): Promise<void> => {
  const leafSpki = Buffer.from(await globalThis.crypto.subtle.exportKey('spki', leafPublicKey));
  const issuerSpki = Buffer.from(issuerCertificate.publicKey.rawData);
  if (leafSpki.equals(issuerSpki)) {
    throw new CertificateError('leaf 与根 CA 使用了同一把公钥：每张 leaf 都必须有独立密钥对');
  }
};

export interface LeafOptions extends LeafRequest {
  /** 签发者：根 CA 的证书与私钥 */
  issuer: RootCa;
  /** 当前时刻。默认 new Date()；测试注入固定时钟 */
  now?: Date;
  /**
   * 密钥生成函数，默认 generateKeyPair。
   * 存在这个注入点只有一个理由：单测要能构造出"leaf 拿到了 CA 密钥对"这种
   * 错误输入，验证上面那条断言真的在拦，而不是一段死代码。
   */
  generateKeys?: () => Promise<CryptoKeyPair>;
}

/** 以某个根 CA 的身份签一张 leaf 证书 */
export const createLeafCertificate = async (options: LeafOptions): Promise<IssuedLeaf> => {
  const { host, isIp, issuer } = options;
  const now = options.now ?? new Date();
  const keys = await (options.generateKeys ?? generateKeyPair)();

  await assertKeyDiffersFromIssuer(keys.publicKey, issuer.certificate);

  const certificate = await x509.X509CertificateGenerator.create({
    serialNumber: randomSerialNumber(),
    subject: [{ CN: [host] }],
    // 用签发者证书里的 subjectName（X509Name）而不是拼字符串：字符串形式在
    // 名字里有逗号、转义字符时会和库的解析规则打架，Name 对象没有这个问题。
    issuer: issuer.certificate.subjectName,
    notBefore: new Date(now.getTime() - CLOCK_SKEW_DAYS * DAY_MS),
    notAfter: new Date(now.getTime() + LEAF_VALIDITY_DAYS * DAY_MS),
    signingAlgorithm: SIGNING_ALGORITHM,
    publicKey: keys.publicKey,
    signingKey: issuer.privateKey,
    extensions: [
      // leaf 绝不能是 CA：CA:FALSE + critical，防止这张证书被拿去再签发别的证书
      new x509.BasicConstraintsExtension(false, undefined, true),
      // 只给 digitalSignature：leaf 的作用就是 TLS 握手签名，其余用途一概不要
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      // serverAuth：声明"这是服务端身份"，客户端才会接受它
      new x509.ExtendedKeyUsageExtension([SERVER_AUTH_OID], false),
      // SAN 才是客户端真正校验的东西（CN 早已不参与校验）。host 与 isIp 都必须准确：
      // 域名填成 ip 类型（或反过来）证书照样能签发，但客户端一律不认，
      // 而且失败现象是"握手莫名失败"，极难回溯到 SAN 类型上。
      //
      // dns / ip 的选择交给 host.ts 的 sanEntry，**不要在这里再写一份字面量** ——
      // 复制一份的后果是：编译期的类型守卫覆盖不到真正签证书的这行，两边会悄悄漂移。
      new x509.SubjectAlternativeNameExtension([sanEntry(host, isIp)]),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
      // AKI 传**签发者的公钥**：库据此派生出与 CA 的 SKI 一致的 key identifier，
      // 客户端顺着它就能找到签发者（这正是 AKI 应有的语义）。
      await x509.AuthorityKeyIdentifierExtension.create(issuer.certificate.publicKey)
    ]
  });

  return { certificate, privateKeyPem: await exportPrivateKeyPem(keys.privateKey) };
};

/**
 * 从 PEM 还原内存中的根 CA —— 「复用已存在的 CA」这条路要用它。
 *
 * 还原时顺带校验私钥与证书是不是一对：不校验的话，两个文件被换乱之后签出的
 * leaf 会带着对不上的 AKI，客户端握手失败，而那时已经没人想得到是磁盘上
 * 这两个文件的问题。这个检查很便宜，但把一类"神秘故障"变成了启动时的明确报错。
 */
export const rootCaFromPem = async (
  certificatePem: string,
  privateKeyPem: string,
  now: Date = new Date()
): Promise<RootCa> => {
  const certificate = new x509.X509Certificate(certificatePem);

  const keyObject = createPrivateKey(privateKeyPem);
  const keySpki = Buffer.from(createPublicKey(keyObject).export({ format: 'der', type: 'spki' }));
  if (!keySpki.equals(Buffer.from(certificate.publicKey.rawData))) {
    throw new CertificateError('CA 私钥与证书不是一对：两个文件都靠不住，无法用它签发 leaf');
  }

  // 过期的根证书能加载、能签 leaf，但客户端一律不认。不在这里重建（重建会让
  // 用户已安装的根作废），至少要让日志说清楚为什么解密全挂
  if (certificate.notAfter.getTime() <= now.getTime()) {
    console.error(
      `[Reqeek] 根 CA 已于 ${certificate.notAfter.toISOString()} 过期，需要重新生成并重新安装`
    );
  }

  return { certificate, privateKey: await importPrivateKeyPem(privateKeyPem) };
};
