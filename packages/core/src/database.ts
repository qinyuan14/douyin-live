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
} from '@liveops/live-contracts';
import { evidenceMatchesStoredFile } from './evidence.js';

export function projectRoot(): string {
  return process.env.LIVE_PROJECT_ROOT
    ? resolve(process.env.LIVE_PROJECT_ROOT)
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
  // 流程精简（批次2）：在场确认间隔由 5 分钟放宽到 15 分钟，减少直播中打扰
  presenceIntervalMinutes: 15,
  maxMissedPresence: 2,
  storeName: '',
  tagline: '',
  serviceAreas: [],
  serviceAreasConfirmed: false,
  productCategories: [],
  onboardingCompleted: false,
  // v13.1：播报音色（默认系统语音；火山引擎/火山方舟需在设置中填密钥后切换）
  tts: {
    provider: 'system',
    systemVoiceName: null,
    volcengine: { appId: '', accessToken: '', cluster: 'volcano_tts', voiceType: 'BV700_streaming' },
    ark: { apiKey: '', model: '', voiceType: 'zh_female_cancan_moon_bigtts' },
  },
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
    // 旧配置迁移（批次2）：早期版本默认在场间隔 5 分钟，从未显式改过的旧数据
    // 会通过 DEFAULT_CONFIG 合并拿到 15 分钟；用户显式设置过的值保持不变。
    const rawConfig = this.readJson<StoreConfig>('config', DEFAULT_CONFIG);
    if (typeof rawConfig.presenceIntervalMinutes === 'number' && rawConfig.presenceIntervalMinutes === 5 && this.configWasNeverTouched()) {
      rawConfig.presenceIntervalMinutes = 15;
    }
    this.state = {
      // 与 DEFAULT_CONFIG 合并：老数据文件可能缺任务E新增的商家配置字段（tts 深合并，旧数据缺子字段也能补默认）
      config: { ...DEFAULT_CONFIG, ...rawConfig, tts: { ...DEFAULT_CONFIG.tts, ...rawConfig.tts, volcengine: { ...DEFAULT_CONFIG.tts.volcengine, ...rawConfig.tts?.volcengine }, ark: { ...DEFAULT_CONFIG.tts.ark, ...rawConfig.tts?.ark } } },
      offers: this.readJson<OfferSnapshot[]>('offers', []),
      knowledge: this.readJson<KnowledgeItem[]>('knowledge', []),
      sessions: this.readJson<LiveSession[]>('sessions', []),
      orders: this.readJson<OrderOutcome[]>('orders', []),
      events: this.readJson<RuntimeEvent[]>('events', []),
      audit: this.readJson<AuditEntry[]>('audit', []),
      evidence: this.readJson<Record<string, EvidenceMeta>>('evidence', {}),
    };
  }

  /** 旧配置迁移辅助：仅当配置文件缺失（全新安装）或从未写入过 presenceIntervalMinutes 时视为"未显式设置" */
  private configWasNeverTouched(): boolean {
    const path = this.filePath('config');
    if (!existsSync(path)) return true;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      return !('presenceIntervalMinutes' in raw);
    } catch {
      return true;
    }
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

  /**
   * 把内存状态落盘。
   * 备份前必须调用：否则备份到的是磁盘上的旧快照，与运行中的真实状态不一致。
   */
  async flush(): Promise<void> {
    this.persist();
  }

  /**
   * 从磁盘重新载入状态。
   * 恢复数据后必须调用：否则下一次 persist() 会用内存里的旧状态把刚恢复的文件覆盖回去。
   */
  async reload(): Promise<void> {
    await this.load();
  }

  /** 当前是否存在正在播报或中途暂停的场次（此时禁止恢复数据）。 */
  hasBroadcastingSession(): boolean {
    return this.state.sessions.some((session) => session.state === 'LIVE' || session.state === 'PAUSED');
  }

  /** 记录备份/恢复这类数据维护动作，保证可追溯。 */
  async recordDataMaintenance(action: string, meta: Record<string, unknown>): Promise<void> {
    this.audit(action, 'LocalBackup', null, meta);
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
      if (typeof patch.storeName === 'string') {
        this.state.config.storeName = patch.storeName;
      }
      if (typeof patch.tagline === 'string') {
        this.state.config.tagline = patch.tagline;
      }
      if (Array.isArray(patch.serviceAreas)) {
        this.state.config.serviceAreas = patch.serviceAreas.map((item) => String(item)).filter(Boolean);
      }
      if (typeof patch.serviceAreasConfirmed === 'boolean') {
        this.state.config.serviceAreasConfirmed = patch.serviceAreasConfirmed;
      }
      if (Array.isArray(patch.productCategories)) {
        this.state.config.productCategories = patch.productCategories.map((item) => String(item)).filter(Boolean);
      }
      if (typeof patch.onboardingCompleted === 'boolean') {
        this.state.config.onboardingCompleted = patch.onboardingCompleted;
      }
      // v13.1：播报音色设置（系统语音 / 火山引擎 / 火山方舟）
      if (patch.tts && typeof patch.tts === 'object') {
        const tts = patch.tts as Record<string, unknown>;
        const next = { ...DEFAULT_CONFIG.tts, ...this.state.config.tts, ...tts };
        if (tts.provider === 'system' || tts.provider === 'volcengine' || tts.provider === 'ark') next.provider = tts.provider;
        if (typeof tts.systemVoiceName === 'string' || tts.systemVoiceName === null) next.systemVoiceName = tts.systemVoiceName;
        if (tts.volcengine && typeof tts.volcengine === 'object') {
          const v = tts.volcengine as Record<string, unknown>;
          next.volcengine = {
            ...next.volcengine,
            ...(typeof v.appId === 'string' ? { appId: v.appId } : {}),
            ...(typeof v.accessToken === 'string' ? { accessToken: v.accessToken } : {}),
            ...(typeof v.cluster === 'string' ? { cluster: v.cluster } : {}),
            ...(typeof v.voiceType === 'string' ? { voiceType: v.voiceType } : {}),
          };
        }
        if (tts.ark && typeof tts.ark === 'object') {
          const a = tts.ark as Record<string, unknown>;
          next.ark = {
            ...next.ark,
            ...(typeof a.apiKey === 'string' ? { apiKey: a.apiKey } : {}),
            ...(typeof a.model === 'string' ? { model: a.model } : {}),
            ...(typeof a.voiceType === 'string' ? { voiceType: a.voiceType } : {}),
          };
        }
        this.state.config.tts = next;
      }
    }
    this.persist();
    return { ...this.state.config };
  }

  listOffers(): Promise<OfferSnapshot[]> {
    return Promise.resolve([...this.state.offers]);
  }

  /** 是否正在真实直播（LIVE/PAUSED）：此时商品快照必须冻结，禁止修改 */
  private hasLiveSession(): boolean {
    return this.state.sessions.some((session) => session.state === 'LIVE' || session.state === 'PAUSED');
  }

  async saveOffer(offer: OfferSnapshot): Promise<OfferSnapshot> {
    // v9.1：仅真实直播中（LIVE/PAUSED）冻结商品快照；开播前的 DRAFT/PREFLIGHT_BLOCKED/READY
    // 允许保存/更新商品（一键开播自动建场次后仍可补齐商品信息）
    if (this.hasLiveSession()) {
      throw new Error('当前正在直播，不能修改商品快照');
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
    // v9.1 起商品快照为自查模式（evidenceRefs 可为空）：自查快照直接视为有效；
    // 仍携带文件证据的旧快照才校验证据是否有效。多条有效记录取 validUntil 最新。
    const candidates = this.state.offers.filter((offer) => {
      if (offer.status !== 'ACTIVE' || new Date(offer.validUntil).getTime() <= now) return false;
      if (offer.evidenceRefs.length === 0) return true;
      return offer.evidenceRefs.every((ref: EvidenceRef) => evidenceMatchesStoredFile(ref))
        && this.allEvidenceIsRegisteredSync(offer.evidenceRefs);
    });
    if (candidates.length === 0) return null;
    return [...candidates].sort((a, b) => new Date(b.validUntil).getTime() - new Date(a.validUntil).getTime())[0] ?? null;
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
