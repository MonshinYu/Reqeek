import type {Flow} from '@shared/types';

export type FlowGroup =
  | {
      type: 'group';
      key: string;
      domain: string;
      count: number;
      expanded: boolean;
      groupLevel: number;
    }
  | {
      type: 'flow';
      key: string;
      flow: Flow;
      groupLevel: number;
    };

/**
 * 按域名分组，返回混合的组头行和请求行。
 * 支持展开/折叠：每个域名分组如果被展开，就显示其内部的请求行。
 */
export const groupByDomain = (flows: Flow[], expandedDomains: Set<string>): FlowGroup[] => {
  const groups = new Map<string, Flow[]>();

  // 按 host 分组
  for (const flow of flows) {
    const host = flow.host;
    const hostFlows = groups.get(host);
    if (hostFlows) hostFlows.push(flow);
    else groups.set(host, [flow]);
  }

  // 按请求数倒序排列
  const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);

  const result: FlowGroup[] = [];

  for (const [domain, domainFlows] of sorted) {
    const groupKey = `group-${domain}`;
    const isExpanded = expandedDomains.has(domain);

    // 添加分组头
    result.push({
      type: 'group',
      key: groupKey,
      domain,
      count: domainFlows.length,
      expanded: isExpanded,
      groupLevel: 0
    });

    // 如果展开，添加该域名下的所有请求
    if (isExpanded) {
      for (const flow of domainFlows) {
        result.push({
          type: 'flow',
          key: `flow-${flow.id}`,
          flow,
          groupLevel: 1
        });
      }
    }
  }

  return result;
};

export const toggleGroup = (expandedDomains: Set<string>, domain: string): Set<string> => {
  const next = new Set(expandedDomains);
  if (next.has(domain)) {
    next.delete(domain);
  } else {
    next.add(domain);
  }
  return next;
};

export const expandAll = (flows: Flow[]): Set<string> => {
  const domains = new Set<string>();
  for (const flow of flows) {
    domains.add(flow.host);
  }
  return domains;
};
