import {createDarwinDriver} from './drivers/darwin';
import {Win32SystemProxyDriver} from './drivers/win32';
import {canRestore, createOwnership, createStateStore, isOwnedBy} from './state';
import type {PersistedSystemProxyState, ProxySnapshot, SystemProxyDriver, WriteOwnership} from './types';
import {SystemProxyError} from './types';

/** 本地绕过：不加的话 Reqeek 自己和本地开发服务器的流量都会绕进代理 */
const LOCAL_BYPASS = ['localhost', '127.0.0.1'];

const PROXY_HOST = '127.0.0.1';

/**
 * 合并绕过列表：用户原有的并上本地的，**而不是拿我们的列表替换**。
 *
 * V0 的 bug 之一就是「替换」—— 清理残留时用空列表写下去，用户的 bypass 域名
 * 就永久没了。这个函数是那道防线。
 */
export const mergeBypassDomains = (existing: readonly string[]): string[] => {
  const merged = new Set<string>();
  for (const domain of existing) {
    const trimmed = domain.trim();
    if (trimmed) merged.add(trimmed);
  }
  for (const domain of LOCAL_BYPASS) merged.add(domain);
  return [...merged];
};

const createDriver = (): SystemProxyDriver => {
  if (process.platform === 'darwin') return createDarwinDriver();
  if (process.platform === 'win32') return new Win32SystemProxyDriver();
  throw new SystemProxyError(`暂不支持在 ${process.platform} 上修改系统代理`);
};

const toMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export interface SystemProxyController {
  /** 把系统代理指向本地端口。正常返回时，快照已落盘且系统已改好 */
  enable: (port: number) => Promise<void>;
  /** 按快照逐项还原。没有记录、或记录不属于本进程时是安全的 no-op */
  disable: () => Promise<void>;
  /** 清理上次异常退出留下的残留，返回是否真的还原了什么 */
  recoverStale: () => Promise<boolean>;
  readonly ownership: WriteOwnership;
}

export interface SystemProxyControllerDeps {
  /**
   * 平台 driver。生产不传，按当前平台创建；测试注入假实现。
   *
   * 为什么必须是注入而不是"运行时替换个 mock"：真 driver 的每个写操作都在改用户
   * 的系统代理，是**不可回滚的外部副作用**。可测性的做法只有一种 —— 把这条唯一
   * 的副作用入口变成参数，让测试根本拿不到真 driver。
   */
  driver?: SystemProxyDriver;
}

export const createSystemProxyController = (
  stateDir: string,
  deps: SystemProxyControllerDeps = {}
): SystemProxyController => {
  const store = createStateStore(stateDir);
  const ownership = createOwnership();
  const driver = deps.driver ?? createDriver();
  let enabled = false;

  const captureTarget = async (): Promise<ProxySnapshot> => {
    const targets = await driver.listTargets();
    // listTargets 把当前活跃的服务排在第一位；动别人的网络服务没有意义
    const target = targets[0];
    if (!target) throw new SystemProxyError('没有找到可配置的网络服务');

    const state = await driver.read(target);
    return { target, ...state, capturedAt: Date.now() };
  };

  /**
   * 接管盘上可能存在的、属于上一个进程的记录。
   *
   * state 模块的所有权门禁规定：盘上存在别人的记录时 beginWrite 一律被拒。
   * 而**上一轮正常退出就会留下一条 cleared 墓碑** —— 不接管它，第二次启动
   * 用户点「启动代理」时会被门禁挡住，代理从此再也起不来。
   *
   * 顺序不能反：**先按快照把系统还原，再谈接管**。反过来的话，万一还原失败，
   * 用户原始配置的唯一副本就没了。
   */
  const takeOverForeignRecord = async (): Promise<boolean> => {
    const existing = await store.load();
    if (!existing || isOwnedBy(existing, ownership)) return false;

    const restorable = canRestore(existing);
    if (restorable) await driver.restore(existing.snapshot);

    try {
      // adopt 要求调用方声明"已完成还原"。走到这里：可还原的已经还原了；
      // 不可还原的（cleared 墓碑）本来就没有需要还原的东西。
      await store.adopt(ownership, { restored: true });
    } catch (error) {
      // 接管失败**不致命**：系统已经还原了，那是这个函数唯一必须做到的事。
      // 记录留在旧主名下只会让下次启动再走一遍 —— 而还原是幂等的。
      console.error('[Reqeek] 接管系统代理记录失败，下次启动会重试：', error);
    }

    return restorable;
  };

  const enable = async (port: number): Promise<void> => {
    if (enabled) return;

    // 这里故意让 StateCorruptError 往外抛：状态文件损坏时我们已经无从知道
    // 用户的原始配置，此时还去改系统代理，等于把唯一的还原依据也毁掉。
    await takeOverForeignRecord();

    const snapshot = await captureTarget();

    // 顺序是这个模块存在的核心：**快照先落盘，再动系统**。
    // 中间任何一步崩溃，都还有一份 original 可查。
    await store.beginWrite(snapshot, ownership);
    // commit 放在 apply **之前**。这样 apply 走到一半被 SIGKILL，盘上留的是一份
    // 可还原的 committed 记录；反过来（apply 成功才 commit）的话，会停在 intent，
    // 而两个门禁都只认 committed —— 用户就被留在半改状态里，谁也不会去收拾。
    await store.commit(ownership);

    try {
      await driver.apply(
        snapshot.target,
        PROXY_HOST,
        port,
        mergeBypassDomains(snapshot.bypassDomains)
      );
    } catch (error) {
      // 可能已经改了一半。先按快照还原，别把用户留在半改状态
      try {
        await driver.restore(snapshot);
        await store.clear(ownership);
      } catch {
        // 还原也失败了：**保留** committed 记录，让下次启动的 recoverStale 接着收拾。
        // 这里不再抛别的东西 —— 用户需要看到的是最初那个失败原因。
      }
      throw error;
    }

    enabled = true;
  };

  const disable = async (): Promise<void> => {
    let state: PersistedSystemProxyState | null;
    try {
      state = await store.load();
    } catch (error) {
      // 状态文件损坏：我们已经无从知道用户原来的配置。
      // 这里**绝不能**退化成「把代理整个关掉」——那正是 V0 会抹掉用户配置的做法。
      // 往上抛，让界面告诉用户去「系统设置 → 网络 → 代理」自己确认。
      throw new SystemProxyError(`系统代理状态文件损坏，无法按原样还原：${toMessage(error)}`);
    }

    if (!state || !canRestore(state)) {
      enabled = false;
      return;
    }

    if (!isOwnedBy(state, ownership)) {
      throw new SystemProxyError('系统代理记录属于另一个 Reqeek 实例，不代它还原');
    }

    await driver.restore(state.snapshot);
    await store.clear(ownership);
    enabled = false;
  };

  const recoverStale = async (): Promise<boolean> => {
    // 清理是尽力而为的：抛出去会让启动流程挂掉，而这只该是一条日志
    try {
      return await takeOverForeignRecord();
    } catch (error) {
      throw new SystemProxyError(`清理系统代理残留失败：${toMessage(error)}`);
    }
  };

  return { enable, disable, recoverStale, ownership };
};

export { toMessage };
