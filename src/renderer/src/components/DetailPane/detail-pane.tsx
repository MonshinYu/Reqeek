import React, {useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import styles from './detail-pane.module.css';
import type {Flow, FlowDetail} from '@shared/types';
import {mimeFromHeaders} from '@/lib/body';
import {BodyPanel} from '@/components/BodyPanel';
import {Icon} from '@/components/Icon';
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
  const { t } = useTranslation();

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
    <aside className={styles.root} aria-label={t('detail.title')}>
      <div className={styles.tabs} role="tablist">
        <button
          type="button"
          className={styles.close}
          aria-label={t('detail.close')}
          onClick={onClose}
        >
          <Icon name="close" size={14} />
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
          <p className={styles.empty}>{t('common.loading')}</p>
        ) : (
          <>
            {tab === 'headers' && <HeadersView flow={flow} detail={detail} />}
            {tab === 'payload' && (
              <BodyPanel
                body={detail?.requestBody ?? null}
                mime={detail ? mimeFromHeaders(detail.requestHeaders, 'content-type') : null}
                mode="preview"
                emptyText={t('detail.noRequestBody')}
              />
            )}
            {tab === 'preview' && (
              <BodyPanel
                body={detail?.responseBody ?? null}
                mime={flow.mimeType}
                mode="preview"
                emptyText={t(flow.hasDetail ? 'detail.noPreviewBody' : 'detail.bodyNotCaptured')}
              />
            )}
            {tab === 'response' && (
              <BodyPanel
                body={detail?.responseBody ?? null}
                mime={flow.mimeType}
                mode="raw"
                emptyText={t(flow.hasDetail ? 'detail.noResponseBody' : 'detail.bodyNotCaptured')}
              />
            )}
            {tab === 'timing' && <TimingView flow={flow} />}
          </>
        )}
      </div>
    </aside>
  );
};
