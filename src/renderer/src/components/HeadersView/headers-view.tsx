import React from 'react';
import styles from './headers-view.module.css';
import type {Flow, FlowDetail, HeaderList} from '@shared/types';
import {flowFullUrl, statusText} from '@/lib/format';
import {ClampText} from '@/components/ClampText';

const HeaderSection = (props: { title: string; headers: HeaderList }): React.ReactElement => {
  const { title, headers } = props;

  return (
    <details className={styles.section} open>
      <summary>
        {title} <span className={styles.count}>({headers.length})</span>
      </summary>
      {headers.length === 0 ? (
        <p className={styles.empty}>无</p>
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
          {flow.hasDetail
            ? '详情已被清理（超出内存预算）'
            : '此类记录不采集请求头（隧道或升级连接）'}
        </p>
      )}
    </div>
  );
};
