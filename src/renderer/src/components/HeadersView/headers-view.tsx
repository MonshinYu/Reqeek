import React from 'react';
import {useTranslation} from 'react-i18next';
import styles from './headers-view.module.css';
import type {Flow, FlowDetail, HeaderList} from '@shared/types';
import {flowFullUrl, statusText} from '@/lib/format';
import {ClampText} from '@/components/ClampText';

const HeaderSection = (props: { title: string; headers: HeaderList }): React.ReactElement => {
  const { title, headers } = props;
  const { t } = useTranslation();

  return (
    <details className={styles.section} open>
      <summary>
        {title} <span className={styles.count}>({headers.length})</span>
      </summary>
      {headers.length === 0 ? (
        <p className={styles.empty}>{t('common.none')}</p>
      ) : (
        <dl className={styles.list}>
          {headers.map(([key, value], index) => (
            <div key={`${key}-${index}`} className={styles.row}>
              <dt>{key}:</dt>
              <dd>
                <ClampText text={value} />
              </dd>
            </div>
          ))}
        </dl>
      )}
    </details>
  );
};

interface HeadersViewProps {
  flow: Flow;
  detail: FlowDetail | null;
}

export const HeadersView = (props: HeadersViewProps): React.ReactElement => {
  const { flow, detail } = props;
  const { t } = useTranslation();

  // 这几行的标签与 Chrome DevTools 的 Headers 面板逐字对齐，中文版 Chrome 里也是英文，故不翻译
  const general: [string, string][] = [
    ['Request URL', flowFullUrl(flow)],
    ['Request Method', flow.method],
    ['Status Code', statusText(flow)],
    ['Remote Address', `${flow.host}:${flow.port}`]
  ];
  if (flow.error) general.push(['Error', flow.error]);

  return (
    <div>
      <details className={styles.section} open>
        <summary>General</summary>
        <dl className={styles.list}>
          {general.map(([key, value]) => (
            <div key={key} className={styles.row}>
              <dt>{key}:</dt>
              <dd>
                <ClampText text={value} />
              </dd>
            </div>
          ))}
        </dl>
      </details>
      {detail ? (
        <>
          <HeaderSection title="Response Headers" headers={detail.responseHeaders} />
          <HeaderSection title="Request Headers" headers={detail.requestHeaders} />
        </>
      ) : (
        <p className={styles.empty}>
          {t(flow.hasDetail ? 'headers.detailEvicted' : 'headers.noHeadersCaptured')}
        </p>
      )}
    </div>
  );
};
