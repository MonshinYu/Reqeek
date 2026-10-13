import type {CapturedBody} from './capture';
import type {HeaderList} from '@shared/types';

/** 所有详情合计的内存预算 */
export const DETAIL_TOTAL_BUDGET = 64 * 1024 * 1024;

/** 每条详情的固定开销估值，避免海量小请求把预算算成 0 */
const ENTRY_OVERHEAD = 256;

export interface StoredDetail {
  id: number;
  requestHeaders: HeaderList;
  responseHeaders: HeaderList;
  requestBody: CapturedBody | null;
  responseBody: CapturedBody | null;
}

const headerBytes = (headers: HeaderList): number =>
  headers.reduce((sum, [key, value]) => sum + key.length + value.length, 0);

const costOf = (detail: StoredDetail): number =>
  ENTRY_OVERHEAD +
  headerBytes(detail.requestHeaders) +
  headerBytes(detail.responseHeaders) +
  (detail.requestBody?.bytes.length ?? 0) +
  (detail.responseBody?.bytes.length ?? 0);

/**
 * 按预算整条淘汰最旧详情的存储。Map 的迭代顺序就是插入顺序，
 * 所以队首永远是最旧的一条，淘汰是 O(1)。
 */
export class DetailStore {
  private readonly items = new Map<number, { detail: StoredDetail; cost: number }>();
  private used = 0;

  constructor(private readonly budget: number = DETAIL_TOTAL_BUDGET) {}

  get bytesUsed(): number {
    return this.used;
  }

  get size(): number {
    return this.items.size;
  }

  add(detail: StoredDetail): void {
    const previous = this.items.get(detail.id);
    if (previous) {
      this.used -= previous.cost;
      this.items.delete(detail.id);
    }

    const cost = costOf(detail);
    this.items.set(detail.id, { detail, cost });
    this.used += cost;

    // 刚加入的这条永远不淘汰，哪怕它自己就超预算
    while (this.used > this.budget && this.items.size > 1) {
      const oldestEntry = this.items.entries().next().value;
      if (oldestEntry === undefined) break;
      const [oldestId, oldest] = oldestEntry;
      if (oldestId === detail.id) break;
      this.used -= oldest.cost;
      this.items.delete(oldestId);
    }
  }

  get(id: number): StoredDetail | null {
    return this.items.get(id)?.detail ?? null;
  }

  clear(): void {
    this.items.clear();
    this.used = 0;
  }
}
