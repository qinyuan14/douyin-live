import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  EvidenceRef,
  KnowledgeItem,
  LiveSession,
  OfferSnapshot,
  OrderOutcome,
  RuntimeEvent,
  StoreConfig,
} from '@mzg/live-contracts';
import { evidenceMatchesStoredFile } from './evidence.js';

export function projectRoot(): string {
  return process.env.MZG_PROJECT_ROOT
    ? resolve(process.env.MZG_PROJECT_ROOT)
    : resolve(import.meta.dirname, '..', '..', '..');
}

export interface EvidenceMeta {
  originalName: string;
  mimeType: string;
  bytes: number;
  sha256: string;
  sourceUri: string;
  privacyConfirmed: boolean;
  systemPinned?: boolean;
}

export interface AuditEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

interface DatabaseState {
  config: StoreConfig;
  offers: OfferSnapshot[];
  knowledge: KnowledgeItem[];
  sessions: LiveSession[];
  orders: OrderOutcome[];
  events: RuntimeEvent[];
  audit: AuditEntry[];
  evidence: Record<string, EvidenceMeta>;
}

const ACTIVE_SESSION_STATES = new Set(['DRAFT', 'PREFLIGHT_BLOCKED', 'READY', 'LIVE', 'PAUSED']);

const DEFAULT_CONFIG: StoreConfig = {
  presenceIntervalMinutes: 5,
  maxMissedPresence: 2,
};

export class LiveDatabase {
  private dir: string;
  private state!: DatabaseState;

  private constructor(dir: string) {
    this.dir = dir;
  }

  static async open(): Promise<LiveDatabase> {
    const dir = resolve(projectRoot(), '.data', 'live-system');
    mkdirSync(dir, { recursive: true });
    const db = new LiveDatabase(dir);
    await db.load();
    return db;
  }

  get dataDir(): string {
    return this.dir;
  }

  private filePath(name: string): string {
    return resolve(this.dir, `${name}.json`);
  }

  private readJson<T>(name: string, fallback: T): T {
    const path = this.filePath(name);
    if (!existsSync(path)) return fallback;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as T;
    } catch {
      return fallback;
    }
  }

  private async load(): Promise<void> {
    this.state = {
      config: this.readJson<StoreConfig>('config', DEFAULT_CONFIG),
      offers: this.readJson<OfferSnapshot[]>('offers', []),
      knowledge: this.readJson<KnowledgeItem[]>('knowledge', []),
      sessions: this.readJson<LiveSession[]>('sessions', []),
      orders: this.readJson<OrderOutcome[]>('orders', []),
      events: this.readJson<RuntimeEvent[]>('events', []),
      audit: this.readJson<AuditEntry[]>('audit', []),
      evidence: this.readJson<Record<string, EvidenceMeta>>('evidence', {}),
    };
  }

  private persist(): void {
    writeFileSync(this.filePath('config'), JSON.stringify(this.state.config, null, 2));
    writeFileSync(this.filePath('offers'), JSON.stringify(this.state.offers, null, 2));
    writeFileSync(this.filePath('knowledge'), JSON.stringify(this.state.knowledge, null, 2));
    writeFileSync(this.filePath('sessions'), JSON.stringify(this.state.sessions, null, 2));
    writeFileSync(this.filePath('orders'), JSON.stringify(this.state.orders, null, 2));
    writeFileSync(this.filePath('events'), JSON.stringify(this.state.events, null, 2));
    writeFileSync(this.filePath('audit'), JSON.stringify(this.state.audit, null, 2));
    writeFileSync(this.filePath('evidence'), JSON.stringify(this.state.evidence, null, 2));
  }

  private audit(action: string, entityType: string, entityId: string | null, detail: Record<string, unknown>): void {
    this.state.audit.push({
      id: randomUUID(),
      action,
      entityType,
      entityId,
      detail,
      createdAt: new Date().toISOString(),
    });
  }

  async close(): Promise<void> {
    this.persist();
  }

  getStoreConfig(): Promise<StoreConfig> {
    return Promise.resolve({ ...this.state.config });
  }

  async updateStoreConfig(input: unknown): Promise<StoreConfig> {
    if (input && typeof input === 'object') {
      const patch = input as Record<string, unknown>;
      if (typeof patch.presenceIntervalMinutes === 'number') {
        this.state.config.presenceIntervalMinutes = patch.presenceIntervalMinutes;
      }
      if (typeof patch.maxMissedPresence === 'number') {
        this.state.config.maxMissedPresence = patch.maxMissedPresence;
      }
    }
    this.persist();
    return { ...this.state.config };
  }

  listOffers(): Promise<OfferSnapshot[]> {
    return Promise.resolve([...this.state.offers]);
  }

  private hasActiveSession(): boolean {
    return this.state.sessions.some((session) => ACTIVE_SESSION_STATES.has(session.state));
  }

  async saveOffer(offer: OfferSnapshot): Promise<OfferSnapshot> {
    if (this.hasActiveSession()) {
      throw new Error('当前已有活动场次，不能修改商品快照');
    }
    if (offer.evidenceRefs.length > 0 && !this.allEvidenceIsRegisteredSync(offer.evidenceRefs)) {
      throw new Error('商品快照引用的证据未保全，仅已保全证据可支撑展示商品');
    }
    const index = this.state.offers.findIndex((existing) => existing.id === offer.id);
    if (index >= 0) this.state.offers[index] = offer;
    else this.state.offers.push(offer);
    this.audit('OFFER_SNAPSHOT_SAVED', 'OfferSnapshot', offer.id, {
      productId: offer.productId,
      priceCents: offer.priceCents,
    });
    this.persist();
    return offer;
  }

  listKnowledge(): Promise<KnowledgeItem[]> {
    return Promise.resolve([...this.state.knowledge]);
  }

  async saveKnowledge(item: KnowledgeItem): Promise<KnowledgeItem> {
    const index = this.state.knowledge.findIndex((existing) => existing.id === item.id);
    if (index >= 0) this.state.knowledge[index] = item;
    else this.state.knowledge.push(item);
    this.audit('KNOWLEDGE_SAVED', 'KnowledgeItem', item.id, { intent: item.intent });
    this.persist();
    return item;
  }

  async getKnowledge(id: string): Promise<KnowledgeItem | null> {
    return this.state.knowledge.find((item) => item.id === id) ?? null;
  }

  listSessions(): Promise<LiveSession[]> {
    return Promise.resolve([...this.state.sessions]);
  }

  async getLatestSession(): Promise<LiveSession | null> {
    return this.state.sessions[this.state.sessions.length - 1] ?? null;
  }

  async getSession(id: string): Promise<LiveSession | null> {
    return this.state.sessions.find((session) => session.id === id) ?? null;
  }

  async getActiveOffer(): Promise<OfferSnapshot | null> {
    const now = Date.now();
    return this.state.offers.find((offer) =>
      offer.status === 'ACTIVE' &&
      new Date(offer.validUntil).getTime() > now &&
      offer.evidenceRefs.length > 0 &&
      offer.evidenceRefs.every((ref: EvidenceRef) => evidenceMatchesStoredFile(ref)) &&
      this.allEvidenceIsRegisteredSync(offer.evidenceRefs),
    ) ?? null;
  }

  async createSession(session: LiveSession): Promise<LiveSession> {
    // 单例：若已存在活动场次（无论 DRAFT/PREFLIGHT_BLOCKED/READY/LIVE/PAUSED），
    // 直接返回既有的那一场，避免并发 createSession 产生多个场次（API 测试：并发返回同一 session）。
    const existing = this.state.sessions.find((s) => ACTIVE_SESSION_STATES.has(s.state));
    if (existing) return existing;
    this.state.sessions.push(session);
    this.audit('SESSION_CREATED', 'LiveSession', session.id, { state: session.state });
    this.persist();
    return session;
  }

  async saveSessionIfCurrent(
    session: LiveSession,
    _prevState: string,
    _prevUpdatedAt: string,
    action: string,
  ): Promise<LiveSession> {
    const index = this.state.sessions.findIndex((existing) => existing.id === session.id);
    if (index < 0) throw new Error('直播场次不存在');
    this.state.sessions[index] = session;
    this.audit(action, 'LiveSession', session.id, { state: session.state });
    this.persist();
    return session;
  }

  listOrders(): Promise<OrderOutcome[]> {
    return Promise.resolve([...this.state.orders]);
  }

  async saveOrder(order: OrderOutcome): Promise<OrderOutcome> {
    const index = this.state.orders.findIndex((existing) => existing.id === order.id);
    if (index >= 0) this.state.orders[index] = order;
    else this.state.orders.push(order);
    this.audit('ORDER_OUTCOME_SAVED', 'OrderOutcome', order.id, {
      completed: order.completedAt !== null,
      repeated: order.repeatPaidAt !== null,
    });
    this.persist();
    return order;
  }

  async countOrderRows(): Promise<number> {
    return this.state.orders.length;
  }

  listEvents(id: string, limit: number): Promise<RuntimeEvent[]> {
    const list = this.state.events
      .filter((event) => event.sessionId === id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-Math.max(1, limit));
    return Promise.resolve(list);
  }

  async appendEvent(event: RuntimeEvent): Promise<RuntimeEvent> {
    this.state.events.push(event);
    this.audit(event.type, 'RuntimeEvent', event.sessionId, { message: event.message });
    this.persist();
    return event;
  }

  async recordHardwareChange(before: unknown, after: unknown): Promise<void> {
    this.audit('HARDWARE_STATE_CHANGED', 'Hardware', null, { before, after });
    this.persist();
  }

  async recordEvidenceFile(id: string, meta: EvidenceMeta): Promise<void> {
    this.state.evidence[id] = meta;
    this.persist();
  }

  private allEvidenceIsRegisteredSync(refs: EvidenceRef[]): boolean {
    return refs.every((ref) => {
      const meta = this.state.evidence[ref.id];
      return Boolean(meta && meta.sha256 === ref.sha256);
    });
  }

  async allEvidenceIsRegistered(refs: EvidenceRef[]): Promise<boolean> {
    return this.allEvidenceIsRegisteredSync(refs);
  }

  listInvalidOrderIds(): Promise<string[]> {
    return Promise.resolve(
      this.state.orders
        .filter((order) => order.evidenceRefs.length === 0 || !this.allEvidenceIsRegisteredSync(order.evidenceRefs))
        .map((order) => order.id),
    );
  }

  listInvalidSessionIds(): Promise<string[]> {
    return Promise.resolve(
      this.state.sessions
        .filter((session) => !(
          session.startedAt &&
          session.endedAt &&
          session.trafficMode === 'NATURAL_ONLY' &&
          (session.state === 'STOPPED' || session.state === 'COMPLETED')
        ))
        .map((session) => session.id),
    );
  }

  listAudit(limit: number): Promise<AuditEntry[]> {
    const list = this.state.audit
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-Math.max(1, limit));
    return Promise.resolve(list);
  }

  async recordExport(type: string, meta: Record<string, unknown>): Promise<void> {
    this.audit('EXPORT_BUNDLE', type, null, meta);
    this.persist();
  }
}
