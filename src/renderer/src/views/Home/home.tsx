import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import styles from './home.module.css';
import type {CaStatus, ProxyEvent, ProxyStatus} from '@shared/types';
import {AppSidebar, CaDialog, CaGate, DetailPane, FilterBar, FlowTable, StatusBar, TitleBar} from '@/components';
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
  const [caOpen, setCaOpen] = useState(false);
  const [filter, setFilter] = useState<FilterState>(INITIAL_FILTER);
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [expandedDomains, setExpandedDomains] = useState<Set<string>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);

  const refreshCa = useCallback((): void => {
    void window.api.getCaStatus().then((result) => {
      if (result.ok) setCa(result.value);
    });
  }, []);

  useEffect(() => {
    // 先订阅再拉一次当前状态：代理可能在窗口刷新前就已经在跑了
    const off = window.api.onProxyEvent((event: ProxyEvent) => {
      if (event.type === 'status') setStatus(event.status);
    });
    void window.api.getProxyStatus().then(setStatus);
    refreshCa();

    // 用户可能在系统设置里撤销了信任：窗口重新获得焦点时重新检测一次
    window.addEventListener('focus', refreshCa);
    return () => {
      off();
      window.removeEventListener('focus', refreshCa);
    };
  }, [refreshCa]);

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

  // 首次拿到 CA 状态之前不渲染主界面，避免门禁页一闪而过
  const gated = ca === null || !trusted;

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
    </div>
  );
};
