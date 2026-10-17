import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import styles from './home.module.css';
import type {CaStatus, ProxyEvent, ProxyStatus} from '@shared/types';
import {
  AppSidebar,
  CaDialog,
  CaGate,
  DetailPane,
  FilterBar,
  FlowTable,
  Spinner,
  StatusBar,
  TitleBar
} from '@/components';
import {type FilterState, groupByApp, INITIAL_FILTER, matchesFilter} from '@/lib/filter';
import {DEFAULT_SORT, sortFlows, type SortKey, type SortState} from '@/lib/sort';
import {expandAll, groupByDomain, toggleGroup} from '@/lib/group';
import {clearTraffic, useFlows} from '@/store/traffic';
import '@/lib/i18n';

const IDLE_STATUS: ProxyStatus = { running: false, port: null, error: null };

/** 主界面：标题栏 + 过滤栏 + 应用侧栏 + 抓包列表 + 详情面板 */
export const Home = (): React.ReactElement => {
  const {t} = useTranslation();
  const flows = useFlows();
  const [status, setStatus] = useState<ProxyStatus>(IDLE_STATUS);
  const [ca, setCa] = useState<CaStatus | null>(null);
  // 首屏依赖两个异步结果。到位前无论先渲染哪一边都会闪错内容：先渲染主界面会闪一下
  // 「未录制」，先渲染门禁页会闪一下「没有证书」——后者正是启动时看到的那一闪
  const [caSettled, setCaSettled] = useState(false);
  const [statusSettled, setStatusSettled] = useState(false);
  const [caOpen, setCaOpen] = useState(false);
  const [filter, setFilter] = useState<FilterState>(INITIAL_FILTER);
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [expandedDomains, setExpandedDomains] = useState<Set<string>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);

  const refreshCa = useCallback((): void => {
    void window.api
      .getCaStatus()
      .then((result) => {
        if (result.ok) setCa(result.value);
      })
      // 取不到就维持「未知」，交给门禁页的兜底文案；但加载层不能因此一直挂着
      .catch(() => undefined)
      .finally(() => setCaSettled(true));
  }, []);

  useEffect(() => {
    // 先订阅再拉一次当前状态：代理可能在窗口刷新前就已经在跑了
    const off = window.api.onProxyEvent((event: ProxyEvent) => {
      if (event.type === 'status') setStatus(event.status);
    });
    void window.api
      .getProxyStatus()
      .then(setStatus)
      // 同样：拉不到就按「未运行」渲染，不能把加载层卡住
      .catch(() => undefined)
      .finally(() => setStatusSettled(true));
    refreshCa();

    // 用户可能在系统设置里撤销了信任：窗口重新获得焦点时重新检测一次
    window.addEventListener('focus', refreshCa);
    return () => {
      off();
      window.removeEventListener('focus', refreshCa);
    };
  }, [refreshCa]);

  // home.html 里那个内联加载态，正常会被 React 挂载时的容器清理带走。这里兜一次底：
  // 它是个铺满窗口的 fixed 元素，一旦残留就会永远盖在界面上，代价太大不值得赌
  useEffect(() => {
    document.getElementById('boot')?.remove();
  }, []);

  // 信任被撤销时，正在运行的抓包要停掉，否则之后抓到的 HTTPS 全是不透明隧道
  const trusted = ca?.trust === 'trusted';
  useEffect(() => {
    if (ca !== null && !trusted && status.running) window.api.stopServer();
  }, [ca, trusted, status.running]);

  const visible = useMemo(
    () =>
      sortFlows(
        flows.filter((flow) => matchesFilter(flow, filter)),
        sort
      ),
    [flows, filter, sort]
  );

  const grouped = useMemo(
    () => groupByDomain(visible, expandedDomains),
    [visible, expandedDomains]
  );

  const appGroups = useMemo(() => groupByApp(flows), [flows]);

  const selected = useMemo(
    () => flows.find((flow) => flow.id === selectedId) ?? null,
    [flows, selectedId]
  );

  const onSort = (key: SortKey): void =>
    setSort((current) =>
      current.key === key
        ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: 'asc' }
    );

  // 两个首屏依赖都到位前一律算门禁：这一层底下渲染的无论是主界面还是门禁页都会被
  // 加载层完全盖住，而菜单动作读的是同一个 gated，也就一并挡住了
  const ready = caSettled && statusSettled;
  const gated = !ready || !trusted;

  const handleClear = useCallback((): void => {
    setSelectedId(null);
    // 清空后侧栏里没有这个应用了，留着筛选会让列表永远为空
    setFilter((current) => ({ ...current, app: null }));
    void clearTraffic();
  }, []);

  const handleOpenCa = useCallback((): void => {
    setCaOpen(true);
    refreshCa();
  }, [refreshCa]);

  // 应用菜单触发的动作。门禁页下录制 / 清空 / 搜索不可用，菜单也要遵守同样的限制
  useEffect(() => {
    return window.api.onMenuAction((action) => {
      switch (action) {
        case 'toggle-capture':
          if (gated) return;
          if (status.running) window.api.stopServer();
          else window.api.startServer();
          return;
        case 'clear':
          if (!gated) handleClear();
          return;
        case 'focus-search':
          if (!gated) {
            searchRef.current?.focus();
            searchRef.current?.select();
          }
          return;
        case 'open-ca':
          handleOpenCa();
          return;
        case 'open-settings':
          window.api.openSettings();
          return;
      }
    });
  }, [gated, status.running, handleClear, handleOpenCa]);

  return (
    <div className={styles.home}>
      <TitleBar
        status={status}
        gated={gated}
        keyword={filter.keyword}
        onKeyword={(keyword) => setFilter((current) => ({ ...current, keyword }))}
        onClear={handleClear}
        onOpenCa={handleOpenCa}
        searchRef={searchRef}
      />

      {gated ? (
        <CaGate ca={ca} platform={window.api.platform} onChange={setCa} />
      ) : (
        <>
          <FilterBar filter={filter} onChange={setFilter} />

          <div className={styles.body}>
            <AppSidebar
              groups={appGroups}
              total={flows.length}
              selected={filter.app}
              onSelect={(app) => setFilter((current) => ({ ...current, app }))}
            />
            <div className={styles.list}>
              {visible.length === 0 ? (
                <div className={styles.empty}>
                  <strong>
                    {flows.length === 0 ? t('empty.noRequests') : t('empty.noMatch')}
                  </strong>
                  <span>
                    {flows.length === 0 ? t('empty.noRequestsHint') : t('empty.noMatchHint')}
                  </span>
                </div>
              ) : (
                <FlowTable
                  groups={grouped}
                  selectedId={selectedId}
                  compact={selected !== null}
                  sort={sort}
                  onSort={onSort}
                  onSelect={setSelectedId}
                  onToggleExpand={(domain) => {
                    setExpandedDomains((current) => toggleGroup(current, domain));
                  }}
                  onExpandAll={() => {
                    setExpandedDomains(expandAll(visible));
                  }}
                  onCollapseAll={() => {
                    setExpandedDomains(new Set());
                  }}
                />
              )}
            </div>
            {selected && <DetailPane flow={selected} onClose={() => setSelectedId(null)} />}
          </div>

          <StatusBar status={status} shown={visible} total={flows.length} ca={ca} />
        </>
      )}

      {caOpen && <CaDialog ca={ca} onChange={setCa} onClose={() => setCaOpen(false)} />}

      {/* 启动加载层：盖住上面两块，两个首屏依赖到位后淡出（过渡见 .loading）。
          文案交给容器播报一次；Spinner 旁边既然有文字，再播一遍就是噪音 */}
      <div className={styles.loading} data-done={ready} role="status">
        <Spinner size={28} />
        <span>{t('ca.reading')}</span>
      </div>
    </div>
  );
};
