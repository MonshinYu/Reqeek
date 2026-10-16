import {app, ipcMain, shell} from 'electron';
import type {UpdateCheckResult} from '@shared/types';

const VERSION_ENDPOINT = 'https://reqeek.com/api/version';
const WEBSITE = 'https://reqeek.com';

/** 查版本是顺带做的事，不能把界面卡住；超过这个时间就当连不上 */
const REQUEST_TIMEOUT_MS = 10_000;

/*
 * 用 Node 的全局 fetch（undici）而不是 Electron 的 net.fetch，是刻意的选择。
 *
 * 这个应用自己就是代理工具，系统代理通常正指向它自己，而 system-proxy 的本地白名单里
 * 只有 localhost / 127.0.0.1，reqeek.com 不在其中。走 net.fetch（Chromium 网络栈，
 * 跟随系统代理）的话，这次检查会被自己的 MITM 代理接住：既混进用户自己的抓包列表，
 * 根证书还没被信任时更会直接失败 —— 表现就是「检查更新永远失败」。
 * undici 默认忽略 HTTP_PROXY / HTTPS_PROXY，直连，行为可预测。
 *
 * 代价：企业代理或 VPN 环境下可能连不上，那时报 'network'。这是接受的取舍，
 * 请别把它「顺手修正」成 net.fetch。
 *
 * 另一点必须知道的：本仓库里 fetch 的返回类型是 any，不是 DOM 类型。
 * @types/node 的 web-globals/fetch.d.ts 引了 undici-types，而它没被 hoist 到
 * node_modules 根下，skipLibCheck 又把 .d.ts 里的「找不到模块」压掉了，
 * 于是 Response / RequestInit 一起退化成 any。这不报错，但 res.ok、data.version
 * 全无类型保护 —— 下面的运行时校验是唯一防线，不是多余的谨慎。
 */

/**
 * fetch 返回类型退化成 any（见上），这里补一个最小结构，让下面读到的
 * ok / status / json 至少有形状可依。真实响应是否符合，由运行时校验兜底。
 */
interface VersionResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

/**
 * 归一化版本号：服务端给的是 v0.1.2，app.getVersion() 给的是 0.1.1。
 *
 * trim() 不能省 —— " 0.1.2" 过不了正则；去前缀用 /^v/i，大写 V 是真实存在的。
 * 认不出就返回 null，调用方一律当失败：把「看不懂」当成「没有新版本」会让服务端
 * 坏掉时永远显示「已是最新」，用户查不出问题。
 */
const parseVersion = (raw: unknown): {display: string; parts: number[]} | null => {
  if (typeof raw !== 'string') return null;

  const display = raw.trim().replace(/^v/i, '');
  if (!/^\d+(\.\d+)*$/.test(display)) return null;

  return {display, parts: display.split('.').map(Number)};
};

/** 按段比大小，缺的段补 0（0.1 与 0.1.0 等价）；返回正数表示 a 更新 */
const compareVersions = (a: number[], b: number[]): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }

  return 0;
};

/**
 * 查一次版本号。
 *
 * 只有「拿响应」这一小段包在 try 里：连不上和「连上了但响应不对」是两件事，
 * 混进同一个 catch 就分不出该提示用户查网络、还是提示他只能等。
 */
const check = async (): Promise<UpdateCheckResult> => {
  let response: VersionResponse;
  try {
    response = await fetch(VERSION_ENDPOINT, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {accept: 'application/json'}
    });
  } catch (error) {
    console.warn('[Reqeek] 检查更新：请求失败', error);
    return {phase: 'failed', reason: 'network'};
  }

  if (!response.ok) {
    console.warn(`[Reqeek] 检查更新：服务端返回 ${response.status}`);
    return {phase: 'failed', reason: 'server'};
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    // 连上了却不是 JSON，常见于 DNS 劫持或强制门户返回的 200 HTML
    console.warn('[Reqeek] 检查更新：响应不是 JSON', error);
    return {phase: 'failed', reason: 'server'};
  }

  // 本机版本号解析不了属于防御性分支，正常不会发生；远端解析不了说明服务端给了垃圾
  const latest = parseVersion((payload as {version?: unknown} | null)?.version);
  const current = parseVersion(app.getVersion());
  if (!latest || !current) {
    console.warn('[Reqeek] 检查更新：版本号无法解析', payload);
    return {phase: 'failed', reason: 'server'};
  }

  return compareVersions(latest.parts, current.parts) > 0
    ? {phase: 'available', version: latest.display}
    : {phase: 'up-to-date'};
};

export const registerUpdate = (): void => {
  ipcMain.handle('update:check', (): Promise<UpdateCheckResult> => check());

  // URL 是主进程里的字面量，不接受渲染进程传参 —— 渲染侧只能触发「打开这一个页面」，
  // 这就是最小攻击面；改成「传 URL + 白名单校验」是自找的麻烦
  ipcMain.handle('update:open-site', async (): Promise<void> => {
    try {
      await shell.openExternal(WEBSITE);
    } catch (error) {
      // 不往外抛：渲染侧是 void 调用，抛出去只会变成一次没人处理的 rejection
      console.warn('[Reqeek] 打开官网失败', error);
    }
  });
};
