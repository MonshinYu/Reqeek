import {normalizeHost} from './ca/host';

const DEFAULT_PORTS = new Set([443]);
const BUILTIN_EXCLUSIONS = [
  /(^|\.)push\.apple\.com$/i,
  /(^|\.)ocsp\.[a-z0-9.-]+$/i,
  /(^|\.)push\.services\.apple\.com$/i
];

export interface ConnectTarget {
  host: string;
  port: number;
  isIp: boolean;
}

export interface FilterOptions {
  ports?: number[];
  include?: string[];
  exclude?: string[];
}

const globRegex = (glob: string): RegExp =>
  new RegExp(
    `^${glob
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
    'i'
  );

export const parseConnectTarget = (authority: string): ConnectTarget | null => {
  const normalized = normalizeHost(authority);
  if (!normalized) return null;
  let portText: string | undefined;
  if (authority.startsWith('[')) {
    const match = /^\[[^\]]+\](?::(\d+))?$/.exec(authority);
    if (!match) return null;
    portText = match[1];
  } else {
    const match = /^([^:]+)(?::(\d+))?$/.exec(authority);
    if (!match) return null;
    portText = match[2];
  }
  const port = portText ? Number(portText) : 443;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { ...normalized, port };
};

export const shouldMitm = (target: ConnectTarget, options: FilterOptions = {}): boolean => {
  const allowedPorts = new Set([...DEFAULT_PORTS, ...(options.ports ?? [])]);
  if (!allowedPorts.has(target.port)) return false;
  if (BUILTIN_EXCLUSIONS.some((pattern) => pattern.test(target.host))) return false;
  if ((options.exclude ?? []).some((glob) => globRegex(glob).test(target.host))) return false;
  const include = options.include ?? [];
  return include.length === 0 || include.some((glob) => globRegex(glob).test(target.host));
};

export const connectHostHeaderMatches = (
  hostHeader: string | undefined,
  target: ConnectTarget
): boolean => {
  if (!hostHeader) return true;
  const normalized = normalizeHost(hostHeader);
  return normalized !== null && normalized.host === target.host;
};
