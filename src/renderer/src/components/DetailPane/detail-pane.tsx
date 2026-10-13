import React, {useEffect, useState} from 'react';
import styles from './detail-pane.module.css';
import type {Flow, FlowDetail} from '@shared/types';
import {mimeFromHeaders} from '@/lib/body';
import {BodyPanel} from '@/components/BodyPanel';
import {HeadersView} from '@/components/HeadersView';
import {TimingView} from '@/components/TimingView';

type TabKey = 'headers' | 'payload' | 'preview' | 'response' | 'timing';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'headers', label: 'Headers' },
  { key: 'payload', label: 'Payload' },
  { key: 'preview', label: 'Preview' },
  { key: 'response', label: 'Response' },
  { key: 'timing', label: 'Timing' }
];

interface DetailPaneProps {
  flow: Flow;
  onClose: () => void;
}

/** 详情按需拉取：列表推送里不带头和 body，选中某一行时才向主进程要 */
interface Loaded {
  id: number;
  detail: FlowDetail | null;
}

export const DetailPane = (props: DetailPaneProps): React.ReactElement => {
  const { flow, onClose } = props;

  const [tab, setTab] = useState<TabKey>('headers');
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.api.getFlowDetail(flow.id).then((detail) => {
      if (!cancelled) setLoaded({ id: flow.id, detail });
    });
    return () => {
      cancelled = true;
    };
  }, [flow.id]);

  // 切换选中项后，旧结果在新结果到达前不能被当成新行的详情
  const detail = loaded?.id === flow.id ? loaded.detail : null;
  const loading = loaded?.id !== flow.id;

  return (
    <aside className={styles.root} aria-label="请求详情">
      <div className={styles.tabs} role="tablist">
        <button type="button" className={styles.close} aria-label="关闭详情" onClick={onClose}>
          ×
        </button>
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            className={styles.tab}
            aria-selected={tab === item.key}
            onClick={() => setTab(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className={styles.content} role="tabpanel">
        {loading && tab !== 'timing' ? (
          <p className={styles.empty}>加载中…</p>
        ) : (
          <>
            {tab === 'headers' && <HeadersView flow={flow} detail={detail} />}
            {tab === 'payload' && (
              <BodyPanel
                body={detail?.requestBody ?? null}
                mime={detail ? mimeFromHeaders(detail.requestHeaders, 'content-type') : null}
                mode="preview"
                emptyText="此请求没有请求体"
              />
            )}
            {tab === 'preview' && (
              <BodyPanel
                body={detail?.responseBody ?? null}
                mime={flow.mimeType}
                mode="preview"
                emptyText={flow.hasDetail ? '没有可预览的响应体' : '此类记录不采集响应体'}
              />
            )}
            {tab === 'response' && (
              <BodyPanel
                body={detail?.responseBody ?? null}
                mime={flow.mimeType}
                mode="raw"
                emptyText={flow.hasDetail ? '没有响应体' : '此类记录不采集响应体'}
              />
            )}
            {tab === 'timing' && <TimingView flow={flow} />}
          </>
        )}
      </div>
    </aside>
  );
};
