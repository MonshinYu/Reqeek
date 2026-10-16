import {app, BrowserWindow, net, shell} from 'electron';
import type {WriteStream} from 'node:fs';
import {createWriteStream} from 'node:fs';
import {access, rm} from 'node:fs/promises';
import {join} from 'node:path';
import type {AppUpdater} from 'electron-updater';
import {autoUpdater} from 'electron-updater';
import type {UpdateErrorReason, UpdateStatus} from '@shared/types';

/**
 * 应用内的检查更新。
 *
 * 两个平台走的是两条完全不同的路，原因在 macOS 的签名上：
 *
 * - Windows：electron-updater 全自动（下载、校验、退出时安装）。它用 latest.yml 里的
 *   SHA-512 校验完整性，不依赖 Authenticode 签名，所以没有代码签名证书也能用。
 * - macOS：只能查到新版本、把 dmg 下下来打开，让用户自己拖进「应用程序」。
 *   Squirrel.Mac 会拿运行中应用的 designated requirement 校验更新包，而本项目是
 *   ad-hoc 签名（electron-builder 的 `identity: '-'`），没有证书也没有 Team ID，
 *   那个要求只能绑到当前构建的 cdhash 上 —— 每个新版本都必然对不上，100% 装不上。
 *   这段逻辑在 Electron 自己的二进制里，不是 electron-builder 配置能绕开的。
 *
 * 拿到 Developer ID 证书并公证之后，macOS 那条分支可以整个换成 electron-updater：
 * 打包时补上 zip 目标（Squirrel.Mac 只认 zip）和 latest-mac.yml 的上传即可，
 * 界面这边一行都不用改 —— 状态模型是照两条路都能用设计的。
 */

/** 仓库路径。写死而不是从 package.json 推断：打包后的应用里没有 git remote 可读 */
const REPO = 'MonshinYu/Reqeek';

/**
 * 首选更新源。能给出真实的 assets 列表，安装包链接不用猜。
 *
 * 代价是这个请求不带 token，GitHub 按出口 IP 限流 60 次/小时 —— 公司、校园网、
 * 代理出口都是共享 IP，撞上就 403。所以还有一条不吃配额的路，见 RELEASES_LATEST_URL。
 */
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;

/**
 * 兜底更新源。GitHub 会 302 到具体 tag 页面，网页请求不吃上面那个 API 配额。
 *
 * 拿不到 assets 列表，安装包链接只能按 electron-builder 的命名规律拼 —— 见 pickMacAsset。
 */
const RELEASES_LATEST_URL = `https://github.com/${REPO}/releases/latest`;

/** 安装包下载地址前缀，后面接 tag 和文件名 */
const RELEASE_DOWNLOAD_BASE = `https://github.com/${REPO}/releases/download`;

/**
 * 安装包文件名里的应用标识。对应 package.json 的 name ——
 * electron-builder.yml 里 mac.artifactName 写的是 `${name}-${version}-mac-${arch}.${ext}`，
 * 那个 ${name} 展开的就是它。改包名时这三处要一起改。
 */
const APP_SLUG = 'reqeek';

/** 查一次的总时长上限。不设的话网络卡住时界面会永远停在「检查中」 */
const CHECK_TIMEOUT_MS = 15_000;
/** 下载上限。dmg 有 100MB 出头，给足时间，但不能无限等 */
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

let status: UpdateStatus = { phase: 'idle' };

export const getUpdateStatus = (): UpdateStatus => status;

/**
 * 状态是全局的，不属于某个窗口：设置窗口关掉再打开要能接回当前进度。
 *
 * 广播给所有窗口而不是只发给设置窗口 —— 主窗口将来要用「有新版本」做角标的话，
 * 不用再回来改这里。
 */
const setStatus = (next: UpdateStatus): void => {
  status = next;
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('update:status', next);
  }
};

/**
 * 比较版本号，只看 x.y.z 三段数字。
 *
 * 更新源的标签形如 v0.2.0，前缀 v 可有可无；解析不出的段按 0 算，
 * 于是 "0.2" 与 "0.2.0" 相等，而手滑写坏的标签也不会被当成新版本。
 */
const compareVersions = (left: string, right: string): number => {
  const segments = (value: string): number[] =>
    value
      .replace(/^v/i, '')
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);

  const a = segments(left);
  const b = segments(right);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

/* ------------------------------ Windows ------------------------------ */

/** 出错时用来判断是「查」还是「下」的问题：electron-updater 的 error 事件不带这个信息 */
let windowsStage: 'check' | 'download' = 'check';
/** 下载中的版本号。download-progress 事件只给进度，不给版本 */
let windowsVersion = '';

/**
 * Windows 的两条失败路径共用。
 *
 * electron-updater 的 error 事件只给一个 Error，没有 HTTP 状态，分辨不出是限流还是断网 ——
 * 都归到「网络」，那是绝大多数情况。stage 是变量（可能已经走到下载阶段了），
 * 得按它决定要不要带 reason：下载失败另有文案，不需要细分。
 */
const setWindowsError = (): void => {
  setStatus(
    windowsStage === 'check'
      ? { phase: 'error', stage: 'check', reason: 'network' }
      : { phase: 'error', stage: 'download' }
  );
};

let windowsUpdater: AppUpdater | null = null;

/**
 * 取 electron-updater 的单例，顺带把事件接上。
 *
 * 只在 Windows 上调用：autoUpdater 是按平台惰性构造的，macOS 上拿到的是走
 * Squirrel.Mac 的 MacUpdater，而那条路在本项目上走不通（见文件头）。构造本身没有副作用，
 * 但接上事件之后它就会响应用户的操作了，所以入口收在这里。
 */
const getWindowsUpdater = (): AppUpdater => {
  if (windowsUpdater) return windowsUpdater;

  autoUpdater.autoDownload = true;
  // 用户不点「重启并安装」就退出的话，下次启动时把这次下载的更新装上
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => setStatus({ phase: 'checking' }));

  autoUpdater.on('update-available', (info) => {
    windowsStage = 'download';
    windowsVersion = info.version;
    setStatus({ phase: 'downloading', version: info.version, percent: 0 });
  });

  autoUpdater.on('update-not-available', () => {
    setStatus({ phase: 'up-to-date' });
  });

  autoUpdater.on('download-progress', (progress) => {
    const percent = Math.round(progress.percent);
    // 进度事件很密，百分比没变就不推，免得白刷一遍界面
    if (status.phase === 'downloading' && status.percent === percent) return;
    setStatus({ phase: 'downloading', version: windowsVersion, percent });
  });

  autoUpdater.on('update-downloaded', (info) => {
    setStatus({ phase: 'ready', version: info.version, kind: 'restart' });
  });

  autoUpdater.on('error', setWindowsError);

  windowsUpdater = autoUpdater;
  return windowsUpdater;
};

const checkOnWindows = async (): Promise<void> => {
  // 未打包时 resources/app-update.yml 不存在，electron-updater 会静默返回 null，
  // 界面就永远停在「检查中」。与其装作在查，不如直接报失败
  if (!app.isPackaged) {
    // 开发模式下会走到这里，用户是开发者，兜底文案足够，不单独造一类
    setStatus({ phase: 'error', stage: 'check', reason: 'unknown' });
    return;
  }

  windowsStage = 'check';
  setStatus({ phase: 'checking' });

  try {
    await getWindowsUpdater().checkForUpdates();
  } catch {
    // 失败时 electron-updater 会先发 error 事件再 reject，状态已经被上面那个监听改过了，
    // 这里只是别让 rejection 漏成 unhandled
    setWindowsError();
  }
};

/* ------------------------------ macOS ------------------------------ */

/**
 * 带 HTTP 状态码的请求失败。
 *
 * 状态码本来就在错误消息里（"HTTP 403"），但那是给人看的字符串，不该拿来解析。
 * 上层要靠它把「限流」（403/429，换条路还能走）和别的失败分开。
 */
class HttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

/**
 * 查更新失败，reason 已归好类，界面照着选文案。
 *
 * 归类必须在这一层做完：判定要用到的信息（HTTP 状态）只有这里还有，
 * 往上抛成普通 Error 之后就只剩一句消息了。
 */
class CheckError extends Error {
  readonly reason: UpdateErrorReason;

  constructor(reason: UpdateErrorReason, message: string) {
    super(message);
    this.name = 'CheckError';
    this.reason = reason;
  }
}

/**
 * 限流：换条路还能走，跟网络故障不是一回事。
 *
 * 写成类型守卫而不是返回 boolean：判定通过之后调用处拿到的就是 HttpError，
 * 可以直接读 status 报出来，不用再把整个错误对象 String() 成一句带类名的糊状消息。
 */
const isRateLimited = (error: unknown): error is HttpError =>
  error instanceof HttpError && (error.status === 403 || error.status === 429);

/**
 * Electron 的 IncomingMessage 在运行时就是标准的 Node 可读流，pipe/resume/pause 都在，
 * 只是 .d.ts 里只声明了 EventEmitter 那一半。在这里断言一次，
 * 好过在每个调用点各绕各的。
 */
const asStream = (response: Electron.IncomingMessage): NodeJS.ReadableStream =>
  response as unknown as NodeJS.ReadableStream;

interface GitHubAsset {
  name: string;
  browser_download_url: string;
}

interface GitHubRelease {
  tag_name: string;
  assets: GitHubAsset[];
}

/**
 * 发一个 GET 并把响应体当 JSON 解析。
 *
 * 用 Electron 的 net 而不是 Node 的 fetch：它走 Chromium 的网络栈，
 * 系统代理、证书这些设置跟应用其他请求一致。
 */
const requestJson = <T>(url: string): Promise<T> =>
  new Promise((resolve, reject) => {
    const request = net.request(url);
    request.setHeader('Accept', 'application/vnd.github+json');
    // GitHub API 不给 User-Agent 就直接回 403
    request.setHeader('User-Agent', `Reqeek/${app.getVersion()}`);

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('check timeout'));
      // abort 会触发 error 事件，但 settled 已经是 true 了，那个错误会被忽略
      request.abort();
    }, CHECK_TIMEOUT_MS);

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };

    request.on('response', (response) => {
      if (response.statusCode !== 200) {
        // 不排空响应体的话连接不会被回收
        asStream(response).resume();
        // 带状态码抛，好让调用方把限流和别的失败分开
        fail(new HttpError(response.statusCode));
        return;
      }

      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
        } catch (error) {
          reject(error);
        }
      });
      response.on('error', fail);
    });

    request.on('error', fail);
    request.end();
  });

/**
 * 从 https://github.com/<owner>/<repo>/releases/tag/v0.1.0 里取出 tag。
 *
 * 取出来的串紧接着要拼进下载链接和文件名，所以要求它形状像个版本号：GitHub 在没有
 * Release 时会 302 到 /releases 列表页，仓库改名则跳到新地址，这些都不该被当成正常结果
 * 一路带到下载阶段去。
 */
const tagFromReleaseUrl = (url: string): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(url, RELEASES_LATEST_URL);
  } catch {
    return null;
  }

  // 只认自家域名，别的一律不算
  if (parsed.hostname !== 'github.com') return null;

  /*
   * 锚在 /releases/tag/ 上而不是直接取 URL 末段：owner 和仓库名自己就可能带 "tag" 这个词，
   * 末段那套在 https://github.com/tag/foo/releases/tag/v1 上会先切错地方。
   */
  const tag = /\/releases\/tag\/([^/?#]+)/.exec(parsed.pathname)?.[1];
  if (!tag) return null;

  // 版本号只含字母数字点横线。这一条顺带把百分号编码挡在外面 —— tag 里带斜杠时会被
  // 编成 %2F，那种串拼出来的文件名必定 404，不如现在就当成「没有可用版本」
  return /^v?\d[\w.-]*$/.test(tag) ? tag : null;
};

/**
 * 从网页端的 302 里取出最新版本的 tag。
 *
 * 「取消重定向之后会怎样」实测过，有三处跟直觉不一样，也正是这里必须这么写的原因：
 * - 没有 response 事件，redirect 事件是唯一能拿到目标地址的地方；
 * - 紧接着会补一个 error('Redirect was cancelled')，不挡住的话，
 *   一次成功的降级会被当成网络故障；
 * - close 事件反而在 redirect 之前到达，所以它不能当「结束了」的信号。
 */
const requestLatestTag = (): Promise<string> =>
  new Promise((resolve, reject) => {
    // manual：不让它自己跟过去。我们要的正是那个 Location，跟过去反而拿不到
    const request = net.request({ url: RELEASES_LATEST_URL, redirect: 'manual' });
    /*
     * 显式要 HTML。不指定的话 GitHub 可能按内容协商直接回一坨 JSON 正文
     * （electron-updater 在 Windows 上就是带着 Accept: application/json 拿到 200 的），
     * 那样就没有 302 可读了。
     */
    request.setHeader('Accept', 'text/html');

    let settled = false;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };

    const timer = setTimeout(() => {
      fail(new Error('check timeout'));
      request.abort();
    }, CHECK_TIMEOUT_MS);

    request.on('redirect', (_statusCode, _method, redirectUrl) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const tag = tagFromReleaseUrl(redirectUrl);
      if (!tag) {
        reject(new Error(`unexpected redirect: ${redirectUrl}`));
        return;
      }
      resolve(tag);
    });

    // 取消重定向之后的那个 error 会落到这里，settled 已经置上，被忽略
    request.on('error', fail);

    request.end();
  });

/**
 * 最新版本。
 *
 * tag 和 version 分开：下载地址里要原样的 tag（GitHub 按 tag 找文件），
 * 跟本地版本比大小则要用去掉前缀的数字。少了这个区分，tag 不带 v 的仓库就会拼出坏链接。
 */
interface LatestRelease {
  /** 原始 tag，形如 v0.1.0 */
  tag: string;
  /** 去掉前缀的版本号，用来跟 app.getVersion() 比 */
  version: string;
  /** 只有 API 那条路拿得到；降级路线为 null */
  assets: GitHubAsset[] | null;
}

const stripVersionPrefix = (tag: string): string => tag.replace(/^v/i, '');

/** 请求失败的归类。要用状态码判，所以得趁 HttpError 还在的时候做 */
const failureReason = (error: unknown): UpdateErrorReason => {
  if (error instanceof HttpError && error.status === 404) return 'no-release';
  if (isRateLimited(error)) return 'rate-limited';
  return 'network';
};

/**
 * 取最新版本。API 优先 —— 它能给出真实的 assets 列表，安装包链接不用猜。
 *
 * 只有限流才降级到网页端，因为那是「这条路暂时走不了」，换一条确实能到。
 * 网络不通之类的失败换哪个 URL 都一样，白等一轮 15 秒超时，不如直接报给用户。
 */
const fetchLatestRelease = async (): Promise<LatestRelease> => {
  try {
    const release = await requestJson<GitHubRelease>(RELEASES_API);
    return {
      tag: release.tag_name,
      version: stripVersionPrefix(release.tag_name),
      assets: release.assets
    };
  } catch (error) {
    if (!isRateLimited(error)) {
      throw new CheckError(failureReason(error), `release check failed: ${String(error)}`);
    }

    /*
     * 未鉴权的 GitHub API 按 IP 限流（60 次/小时）是常态，改走网页重定向属于预期内的路径，
     * 不是故障，所以用 info 而不是 warn —— 级别一高，一次正常的降级看起来就像出事了。
     * 但也不能全静默：这是排查「某次检查为什么慢了一拍」时唯一的线索。
     *
     * 界面上看不到这行，它只进系统日志，最终用户不会被打扰。
     */
    console.info(`[Reqeek] GitHub API 限流（HTTP ${error.status}），改用 Release 页取版本号`);

    try {
      const tag = await requestLatestTag();
      return { tag, version: stripVersionPrefix(tag), assets: null };
    } catch {
      /*
       * 两条路都没走通。归到限流而不是网络：能收到 403 说明 DNS、TCP、TLS 全程是通的，
       * 紧接着同一个 IP 的网页请求也失败，最可能还是被限。
       * 这时候「稍后重试」是对的，「去检查网络」会把人引到错的方向。
       */
      throw new CheckError('rate-limited', 'both release sources failed');
    }
  }
};

/**
 * 挑出当前架构要下载的 dmg。
 *
 * 只认 dmg 不认 zip：zip 是给 Squirrel.Mac 自动更新用的，而 macOS 那条路走不通；
 * 用户手动安装的话，双击就能拖进「应用程序」的 dmg 才是该给他的那个。
 *
 * 降级路线拿不到 assets 列表，就按命名规律拼一个同形状的对象顶上去 ——
 * 下游的 downloadAsset 只认 { name, browser_download_url }，不必知道版本是从哪条路来的。
 */
const pickMacAsset = (release: LatestRelease): GitHubAsset | null => {
  // Rosetta 下跑的是 x64 构建，process.arch 会如实报 x64，正好对应要下的包
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const { assets, tag, version } = release;

  if (assets) {
    return (
      assets.find(
        (asset) =>
          asset.name.includes('mac') && asset.name.includes(arch) && asset.name.endsWith('.dmg')
      ) ?? null
    );
  }

  /*
   * 对应 electron-builder.yml 里 mac.artifactName 的
   * `${name}-${version}-mac-${arch}.${ext}`。改了那边忘了同步这里的话，下载会 404
   * 并报「暂无可用的发布版本」—— 不静默，但也不会自己好。
   * 注意地址用原始 tag（可能带 v），文件名用去掉前缀的版本号，两者不是一回事。
   */
  const name = `${APP_SLUG}-${version}-mac-${arch}.dmg`;
  return { name, browser_download_url: `${RELEASE_DOWNLOAD_BASE}/${tag}/${name}` };
};

/** 下载到「下载」目录并返回落盘路径；中途失败会把半个文件删掉 */
const downloadAsset = (asset: GitHubAsset, version: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const target = join(app.getPath('downloads'), asset.name);
    const request = net.request(asset.browser_download_url);

    let settled = false;
    let percent = 0;
    let file: WriteStream | null = null;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 先关流再删：Windows 上句柄还占着的文件删不掉
      file?.destroy();
      // 半个 dmg 留着只会让用户以为已经下好了。删不掉也不致命，下次下载会覆盖它，
      // 所以吞掉这里的失败 —— 让它漏成 unhandled rejection 反而会盖住真正的错误
      void rm(target, { force: true }).catch(() => undefined);
      reject(error);
    };

    const timer = setTimeout(() => {
      // 先 fail 再 abort：反过来的话 abort 触发的 error 会先到，
      // 报出来的就不是「超时」这个更准确的失败原因了
      fail(new Error('download timeout'));
      request.abort();
    }, DOWNLOAD_TIMEOUT_MS);

    request.on('response', (response) => {
      if (response.statusCode !== 200) {
        asStream(response).resume();
        // 把 URL 一起带上：降级路线拼出来的链接是按命名规律猜的，一旦和
        // electron-builder.yml 那边不同步，这行就是唯一能指出「是哪个链接 404 了」的线索
        fail(new Error(`HTTP ${response.statusCode} ${asset.browser_download_url}`));
        return;
      }

      const lengthHeader = response.headers['content-length'];
      const total = Number(Array.isArray(lengthHeader) ? lengthHeader[0] : lengthHeader) || 0;
      let received = 0;

      file = createWriteStream(target);

      // 只数不消费：数据交给 pipe 写盘（背压由它管），这里纯粹为了报进度
      response.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (total === 0) return;
        const next = Math.round((received / total) * 100);
        if (next === percent) return;
        percent = next;
        setStatus({ phase: 'downloading', version, percent: next });
      });

      asStream(response).pipe(file);
      file.on('finish', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(target);
      });
      file.on('error', fail);
      response.on('error', fail);
    });

    request.on('error', fail);
    request.end();
  });

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

/** 已下载的 dmg：用户关掉安装包之后还能再打开一次，也免得同一个版本反复下 */
let macInstaller: { version: string; path: string } | null = null;

/** 打开已下载的 dmg，成功返回 true */
const openMacInstaller = async (version: string, path: string): Promise<boolean> => {
  let error = '';
  try {
    error = await shell.openPath(path);
  } catch (cause) {
    error = String(cause);
  }

  if (error) {
    // dmg 已经被用户删掉或拖走时走到这里，下次检查会重新下载
    macInstaller = null;
    return false;
  }

  macInstaller = { version, path };
  setStatus({ phase: 'ready', version, kind: 'opened' });
  return true;
};

const checkOnMac = async (): Promise<void> => {
  setStatus({ phase: 'checking' });

  let release: LatestRelease;
  try {
    release = await fetchLatestRelease();
  } catch (error) {
    console.error('[Reqeek] 检查更新失败：', error);
    // 不是 CheckError 就说明是意料之外的失败，归到 unknown 让界面给最笼统的那句
    setStatus({
      phase: 'error',
      stage: 'check',
      reason: error instanceof CheckError ? error.reason : 'unknown'
    });
    return;
  }

  // 草稿和预发布版都不会出现在 releases/latest 里，跟「草稿 Release 手动 Publish 才算数」的发布流程正好对上
  const { version } = release;
  if (compareVersions(version, app.getVersion()) <= 0) {
    setStatus({ phase: 'up-to-date' });
    return;
  }

  // 同一个版本已经下过就直接打开：dmg 有 100MB 出头，重复下一遍纯属浪费用户的流量
  if (macInstaller?.version === version && (await pathExists(macInstaller.path))) {
    await openMacInstaller(version, macInstaller.path);
    return;
  }

  const asset = pickMacAsset(release);
  if (!asset) {
    setStatus({ phase: 'error', stage: 'check', reason: 'no-release' });
    return;
  }

  setStatus({ phase: 'downloading', version, percent: 0 });

  try {
    const file = await downloadAsset(asset, version);
    // 打开 dmg 让用户自己拖 —— 这是 macOS 上不需要证书能做到的最后一步
    if (!(await openMacInstaller(version, file))) {
      setStatus({ phase: 'error', stage: 'download' });
    }
  } catch (error) {
    // 同上：带 URL 才能在命名规律不同步时一眼看出问题
    console.error(`[Reqeek] 下载安装包失败：${asset.browser_download_url}`, error);
    setStatus({ phase: 'error', stage: 'download' });
  }
};

/* ------------------------------ 对外 ------------------------------ */

/**
 * 查一次更新。不返回结果：进度和结论都通过 update:status 事件推给界面，
 * 因为 macOS 这条路上「查」和「下」是连在一起的，要跑好几分钟。
 */
export const checkForUpdates = async (): Promise<void> => {
  // 界面会把按钮置灰，但状态是全局的、窗口可以关了再开，主进程这层还是要自己挡住：
  // macOS 上重入会变成两个下载同时往一个文件里写
  if (status.phase === 'checking' || status.phase === 'downloading') return;

  try {
    if (process.platform === 'win32') {
      await checkOnWindows();
      return;
    }
    await checkOnMac();
  } catch {
    // 两条分支各自处理了意料之中的失败，这里兜住剩下的意外 ——
    // 抛出去的话界面会永远停在「检查中」
    setStatus({ phase: 'error', stage: 'check', reason: 'unknown' });
  }
};

/**
 * 跟进「安装包已就位」这一步。两个平台动作不同：
 * - Windows：退出应用并运行安装包，装完自动拉起来
 * - macOS：把已经下好的 dmg 再打开一次（用户可能顺手关掉了，或者想重新拖一遍）
 */
export const installUpdate = (): void => {
  if (status.phase !== 'ready') return;

  if (process.platform === 'win32') {
    if (status.kind !== 'restart') return;
    // 第二个参数让它装完自动把应用拉起来，用户不用再去点一次图标
    autoUpdater.quitAndInstall(false, true);
    return;
  }

  if (status.kind === 'opened' && macInstaller) {
    void openMacInstaller(macInstaller.version, macInstaller.path);
  }
};
