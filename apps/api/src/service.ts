import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import {
  KnowledgeItemSchema,
  OfferSnapshotSchema,
  OrderOutcomeSchema,
  type LiveSession,
  type LiveSessionState,
  type RuntimeEvent,
} from '@mzg/live-contracts';
import {
  LiveDatabase,
  assertTransition,
  buildPreflightChecks,
  calculateCohortReport,
  evidenceMatchesStoredFile,
  evaluateResponse,
  redactPersonalData,
} from '@mzg/live-core';
import { buildRunSheet } from './run-sheet.js';

const APPROVED_KNOWLEDGE_EVIDENCE_ID = '00000000-0000-4000-8000-000000000014';
const APPROVED_KNOWLEDGE_DEFINITIONS = [
  {
    id: '00000000-0000-4000-8000-000000000101', intent: 'service-scope', label: '洗哪些部位', risk: 'LOW' as const, decision: 'AUTO_ALLOWED' as const,
    answer: '普通鞋基础洗护包含鞋面、鞋底、鞋带和可拆鞋垫的基础清洁，也包含基础除味、自然晾干、质检和独立包装。',
  },
  {
    id: '00000000-0000-4000-8000-000000000102', intent: 'shoe-types', label: '哪些鞋能洗', risk: 'HIGH' as const, decision: 'OPERATOR_REQUIRED' as const,
    answer: '这款服务适用于运动鞋、小白鞋、帆布鞋和网面鞋。皮革、翻毛等特殊材质需要先由员工评估。',
  },
  {
    id: '00000000-0000-4000-8000-000000000103', intent: 'turnaround', label: '多久完成', risk: 'MEDIUM' as const, decision: 'AUTO_ALLOWED' as const,
    answer: '普通鞋在实际取回后，正常洗护目标是二到四天；如果出现真实异常，我们会主动联系说明。',
  },
  {
    id: '00000000-0000-4000-8000-000000000104', intent: 'refund', label: '退款问题', risk: 'HIGH' as const, decision: 'OPERATOR_REQUIRED' as const,
    answer: '退款需要结合鞋子是否已经取回、是否开始清洗和订单实际状态，由员工核实后答复。',
  },
  {
    id: '00000000-0000-4000-8000-000000000105', intent: 'special-material', label: '特殊材质', risk: 'HIGH' as const, decision: 'OPERATOR_REQUIRED' as const,
    answer: '特殊材质和高风险鞋需要员工现场评估并与顾客确认后才能承接。',
  },
  {
    id: '00000000-0000-4000-8000-000000000106', intent: 'complaint', label: '投诉赔偿', risk: 'HIGH' as const, decision: 'OPERATOR_REQUIRED' as const,
    answer: '投诉和赔偿由员工根据订单、收鞋照片和实际履约记录核实处理。',
  },
] as const;
const APPROVED_KNOWLEDGE_IDS = new Set<string>(APPROVED_KNOWLEDGE_DEFINITIONS.map((item) => item.id));

@Injectable()
export class LiveService implements OnModuleInit, OnModuleDestroy {
  private database!: LiveDatabase;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatRunning = false;
  private runtimeUnsafeReason: string | null = null;
  private readonly hardware = {
    cameraReady: false,
    cameraDeviceId: null as string | null,
    cameraLabel: null as string | null,
    cameraStreamActive: false,
    cameraFramingConfirmed: false,
    voiceReady: false,
    takeoverReady: false,
  };

  async onModuleInit(): Promise<void> {
    this.database = await LiveDatabase.open();
    await this.seedKnowledge().catch((error: unknown) => console.error('直播白名单知识保持阻断：本地证据无法建立', error));
    this.heartbeatTimer = setInterval(() => void this.triggerSafetyHeartbeat(), 30_000);
    this.heartbeatTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await this.database.close();
  }

  health() {
    return {
      ok: true,
      product: '猫掌柜 AI 实景直播经营系统',
      status: 'LOCAL_COMMERCIAL_CANDIDATE',
      platformAdapter: 'MANUAL',
      now: new Date().toISOString(),
    };
  }

  async bootstrap() {
    const [config, offers, knowledge, session, sessions, orders, report, preflight] = await Promise.all([
      this.getConfig(),
      this.listOffers(),
      this.listKnowledge(),
      this.latestSession(),
      this.database.listSessions(),
      this.listOrders(),
      this.cohortReport(),
      this.preflight(),
    ]);
    const visibleOffers = await Promise.all(offers.map(async (offer) => (
      offer.status === 'ACTIVE'
      && (!offer.evidenceRefs.length
        || !offer.evidenceRefs.every((evidence) => evidenceMatchesStoredFile(evidence))
        || !await this.database.allEvidenceIsRegistered(offer.evidenceRefs))
        ? { ...offer, status: 'EXPIRED' as const }
        : offer
    )));
    const activeOffer = visibleOffers.find((offer) => offer.status === 'ACTIVE' && new Date(offer.validUntil).getTime() > Date.now()) ?? null;
    return {
      config,
      offers: visibleOffers,
      knowledge,
      session: session && this.runtimeUnsafeReason && session.state === 'LIVE'
        ? { ...session, state: 'PAUSED' as const, stopReason: this.runtimeUnsafeReason }
        : session,
      sessions,
      orders,
      report,
      preflight,
      runSheet: buildRunSheet(await this.verifiedApprovedKnowledge(knowledge), activeOffer, new Date(), () => true),
      hardware: this.hardware,
      runtimeUnsafeReason: this.runtimeUnsafeReason,
    };
  }

  getConfig() {
    return this.database.getStoreConfig();
  }

  updateConfig(input: unknown) {
    return this.database.updateStoreConfig(input);
  }

  listOffers() {
    return this.database.listOffers();
  }

  saveOffer(input: unknown) {
    return this.database.saveOffer(OfferSnapshotSchema.parse(input));
  }

  listKnowledge() {
    return this.database.listKnowledge();
  }

  async authorizeRunSheetScript(script: string) {
    if (this.runtimeUnsafeReason) throw new Error(this.runtimeUnsafeReason);
    const [knowledge, activeOffer] = await Promise.all([this.database.listKnowledge(), this.database.getActiveOffer()]);
    const verifiedKnowledge = await this.verifiedApprovedKnowledge(knowledge);
    const match = buildRunSheet(verifiedKnowledge, activeOffer, new Date(), () => true).find((segment) => segment.script === script);
    if (!match?.approved) throw new Error('话术已过期、证据不足或命中禁止表达，AI播报已阻断');
    return { allowed: true as const, script: match.script, scene: match.scene };
  }

  async saveKnowledge(input: unknown) {
    const parsed = KnowledgeItemSchema.parse(input);
    if (APPROVED_KNOWLEDGE_IDS.has(parsed.id)) throw new Error('系统锁定白名单不可通过普通知识接口修改');
    if (redactPersonalData(parsed.answer) !== parsed.answer) throw new Error('知识答案包含完整隐私，请先脱敏');
    if (!parsed.evidenceRefs.every((evidence) => evidenceMatchesStoredFile(evidence))
      || !await this.database.allEvidenceIsRegistered(parsed.evidenceRefs)) {
      throw new Error('知识草稿必须绑定由本工具保全、隐私已确认且校验一致的证据');
    }
    return this.database.saveKnowledge({
      ...parsed,
      decision: 'OPERATOR_REQUIRED',
      risk: 'HIGH',
      status: 'DRAFT',
    });
  }

  async evaluate(input: { knowledgeItemId: string | null; question: string; proposedAnswer: string }) {
    if (this.runtimeUnsafeReason) throw new Error(this.runtimeUnsafeReason);
    const knowledgeItem = input.knowledgeItemId
      ? await this.database.getKnowledge(input.knowledgeItemId)
      : null;
    const verifiedKnowledge = knowledgeItem
      && this.matchesApprovedDefinition(knowledgeItem)
      && redactPersonalData(knowledgeItem.answer) === knowledgeItem.answer
      && knowledgeItem.evidenceRefs.every((evidence) => evidenceMatchesStoredFile(evidence))
      && await this.database.allEvidenceIsRegistered(knowledgeItem.evidenceRefs)
      ? knowledgeItem : null;
    const result = evaluateResponse({ ...input, knowledgeItem: verifiedKnowledge, evidenceVerified: verifiedKnowledge !== null });
    const session = await this.database.getLatestSession();
    if (session) {
      await this.database.appendEvent({
        id: crypto.randomUUID(),
        sessionId: session.id,
        type: 'RESPONSE_DECISION',
        severity: result.decision === 'BLOCKED' ? 'CRITICAL' : result.decision === 'OPERATOR_REQUIRED' ? 'WARNING' : 'INFO',
        message: result.reasons.join('；'),
        payload: { decision: result.decision, question: result.redactedQuestion },
        createdAt: new Date().toISOString(),
      });
    }
    return result;
  }

  async updateHardware(input: Partial<typeof this.hardware>) {
    const before = { ...this.hardware };
    if (input.cameraDeviceId !== undefined) this.hardware.cameraDeviceId = input.cameraDeviceId;
    if (input.cameraLabel !== undefined) this.hardware.cameraLabel = input.cameraLabel;
    if (input.cameraStreamActive !== undefined) this.hardware.cameraStreamActive = input.cameraStreamActive;
    if (input.cameraFramingConfirmed !== undefined) this.hardware.cameraFramingConfirmed = input.cameraFramingConfirmed;
    if (input.voiceReady !== undefined) this.hardware.voiceReady = input.voiceReady;
    if (input.takeoverReady !== undefined) this.hardware.takeoverReady = input.takeoverReady;
    this.hardware.cameraReady = Boolean(
      this.hardware.cameraDeviceId
      && this.hardware.cameraStreamActive
      && this.hardware.cameraFramingConfirmed,
    );
    await this.database.recordHardwareChange(before, this.hardware);
    return { ...this.hardware };
  }

  async saveEvidenceFile(input: { fileName: string; mimeType: string; contentBase64: string; privacyConfirmed: true }) {
    if (input.privacyConfirmed !== true) throw new Error('保存证据前必须确认文件已经人工脱敏');
    const allowedMime = new Set(['image/png', 'image/jpeg', 'application/pdf', 'text/plain', 'application/json']);
    if (!allowedMime.has(input.mimeType)) throw new Error('仅支持 PNG、JPG、PDF、TXT 或 JSON 证据文件');
    const bytes = Buffer.from(input.contentBase64, 'base64');
    if (bytes.byteLength === 0 || bytes.byteLength > 10 * 1024 * 1024) throw new Error('证据文件必须在1字节到10MB之间');
    const extension = extname(input.fileName).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.pdf', '.txt', '.json'].includes(extension)) throw new Error('证据文件扩展名不受支持');
    if (input.mimeType === 'text/plain' || input.mimeType === 'application/json') {
      const text = bytes.toString('utf8');
      if (redactPersonalData(text) !== text) {
        throw new Error('文本证据检测到姓名、联系方式、地址、订单号或其他完整隐私，请先脱敏后再上传');
      }
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const id = crypto.randomUUID();
    const directory = join(this.database.dataDir, 'evidence');
    await mkdir(directory, { recursive: true });
    const storedName = `${id}${extension}`;
    const sourceUri = join(directory, storedName);
    await writeFile(sourceUri, bytes, { flag: 'wx' });
    await this.database.recordEvidenceFile(id, {
      originalName: basename(input.fileName),
      mimeType: input.mimeType,
      bytes: bytes.byteLength,
      sha256,
      sourceUri: resolve(sourceUri),
      privacyConfirmed: input.privacyConfirmed,
    });
    return { id, originalName: basename(input.fileName), sourceUri, sha256, bytes: bytes.byteLength };
  }

  async preflight() {
    const activeOffer = await this.database.getActiveOffer();
    const checks = buildPreflightChecks({ activeOffer, ...this.hardware });
    return {
      checks,
      blocked: checks.some((check) => check.status === 'BLOCKED'),
      manualRequired: checks.some((check) => check.status === 'MANUAL_REQUIRED'),
      formalTrialUnlocked: false,
    };
  }

  async createSession(): Promise<LiveSession> {
    const current = await this.database.getLatestSession();
    if (current && ['DRAFT', 'PREFLIGHT_BLOCKED', 'READY', 'LIVE', 'PAUSED'].includes(current.state)) return current;
    const offer = await this.database.getActiveOffer();
    const preflight = await this.preflight();
    const start = new Date();
    start.setHours(20, 0, 0, 0);
    if (start.getTime() < Date.now() - 7_200_000) start.setDate(start.getDate() + 1);
    const end = new Date(start.getTime() + 7_200_000);
    const timestamp = new Date().toISOString();
    return this.database.createSession({
      id: crypto.randomUUID(),
      offerSnapshotId: offer?.id ?? null,
      trafficMode: 'NATURAL_ONLY',
      state: (preflight.blocked || preflight.manualRequired) ? 'PREFLIGHT_BLOCKED' : 'DRAFT',
      scheduledStart: start.toISOString(),
      scheduledEnd: end.toISOString(),
      startedAt: null,
      endedAt: null,
      lastPresenceAt: null,
      missedPresence: 0,
      stopReason: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  latestSession() {
    return this.database.getLatestSession();
  }

  async transition(id: string, state: LiveSessionState, reason: string | null, externalStartConfirmed: boolean): Promise<LiveSession> {
    const session = await this.requireSession(id);
    assertTransition(session.state, state);

    if (state === 'READY') {
      const preflight = await this.preflight();
      if (preflight.blocked || preflight.manualRequired) throw new Error('试播前检查仍有阻断或现场确认项，不能进入就绪状态');
      const currentOffer = await this.database.getActiveOffer();
      if (!currentOffer || session.offerSnapshotId !== currentOffer.id) {
        throw new Error('场次绑定商品与当前有效商品不一致，请安全结束场次后重新建立');
      }
    }

    if (state === 'LIVE' && !externalStartConfirmed) {
      throw new Error('必须由员工确认已经在抖音直播伴侣人工完成本次开播');
    }
    if (state === 'LIVE') {
      const preflight = await this.preflight();
      if (preflight.blocked || preflight.manualRequired) throw new Error('试播门禁未全部通过，不能标记为直播中');
      const currentOffer = await this.database.getActiveOffer();
      if (!currentOffer || session.offerSnapshotId !== currentOffer.id) {
        throw new Error('场次绑定商品与当前有效商品不一致，请安全结束场次后重新建立');
      }
    }

    const timestamp = new Date().toISOString();
    const next: LiveSession = {
      ...session,
      state,
      startedAt: state === 'LIVE' && !session.startedAt ? timestamp : session.startedAt,
      endedAt: ['STOPPED', 'COMPLETED'].includes(state) ? timestamp : session.endedAt,
      lastPresenceAt: state === 'LIVE' ? timestamp : session.lastPresenceAt,
      missedPresence: state === 'LIVE' ? 0 : session.missedPresence,
      stopReason: ['STOPPED', 'PAUSED'].includes(state) ? reason : session.stopReason,
      updatedAt: timestamp,
    };
    await this.database.saveSessionIfCurrent(next, session.state, session.updatedAt, 'SESSION_TRANSITION');
    if (state === 'LIVE') this.runtimeUnsafeReason = null;
    await this.database.appendEvent({
      id: crypto.randomUUID(),
      sessionId: id,
      type: 'SESSION_TRANSITION',
      severity: state === 'STOPPED' ? 'WARNING' : 'INFO',
      message: `场次状态变更为 ${state}${reason ? `：${reason}` : ''}`,
      payload: { from: session.state, to: state },
      createdAt: timestamp,
    });
    return next;
  }

  async acknowledgePresence(id: string): Promise<LiveSession> {
    const session = await this.requireSession(id);
    const timestamp = new Date().toISOString();
    const next = await this.database.saveSessionIfCurrent({
      ...session,
      lastPresenceAt: timestamp,
      missedPresence: 0,
      updatedAt: timestamp,
    }, session.state, session.updatedAt, 'PRESENCE_ACKNOWLEDGED');
    await this.database.appendEvent({
      id: crypto.randomUUID(),
      sessionId: id,
      type: 'PRESENCE_ACK',
      severity: 'INFO',
      message: '员工已确认在场',
      payload: {},
      createdAt: timestamp,
    });
    return next;
  }

  listEvents(id: string, limit: number) {
    return this.database.listEvents(id, limit);
  }

  async addEvent(id: string, input: Omit<RuntimeEvent, 'id' | 'sessionId' | 'createdAt'>) {
    await this.requireSession(id);
    return this.database.appendEvent({
      id: crypto.randomUUID(),
      sessionId: id,
      createdAt: new Date().toISOString(),
      ...input,
    });
  }

  listOrders() {
    return this.database.listOrders();
  }

  saveOrder(input: unknown) {
    return this.database.saveOrder(OrderOutcomeSchema.parse(input));
  }

  async cohortReport() {
    const [orders, totalRecordedOrders, sessions, offers] = await Promise.all([this.database.listOrders(), this.database.countOrderRows(), this.database.listSessions(), this.database.listOffers()]);
    const sessionById = new Map(sessions.map((session) => [session.id, session]));
    const offerById = new Map(offers.map((offer) => [offer.id, offer]));
    const registeredEvidence = new Map(await Promise.all(orders.map(async (order) => [order.id, await this.database.allEvidenceIsRegistered(order.evidenceRefs)] as const)));
    const validOfferEvidence = new Map(await Promise.all(offers.map(async (offer) => [offer.id,
      offer.evidenceRefs.every((evidence) => evidenceMatchesStoredFile(evidence))
      && await this.database.allEvidenceIsRegistered(offer.evidenceRefs),
    ] as const)));
    const eligibleOrders = orders.filter((order) => {
      if (!order.liveSessionId || !order.customerRefHash || !order.newCustomerConfirmed) return false;
      const session = sessionById.get(order.liveSessionId);
      const offer = offerById.get(order.offerSnapshotId);
      if (!session?.startedAt || !session.endedAt || !['STOPPED', 'COMPLETED'].includes(session.state)) return false;
      if (!offer || validOfferEvidence.get(offer.id) !== true || session.offerSnapshotId !== offer.id || session.trafficMode !== 'NATURAL_ONLY') return false;
      const paidAt = new Date(order.firstPaidAt).getTime();
      if (paidAt < new Date(session.startedAt).getTime() || paidAt > new Date(session.endedAt).getTime()) return false;
      if (!order.evidenceRefs.every((evidence) => evidenceMatchesStoredFile(evidence)) || registeredEvidence.get(order.id) !== true) return false;
      const costEvidence = order.evidenceRefs.find((evidence) => evidence.sourceType === 'COST_RECORD');
      const newCustomerEvidence = order.evidenceRefs.find((evidence) => evidence.sourceType === 'MERCHANT_RECORD');
      if (!costEvidence || !newCustomerEvidence || costEvidence.sourceUri === newCustomerEvidence.sourceUri) return false;
      return !order.repeatPaidAt || (offer.regularPriceCents !== null && order.repeatPriceCents === offer.regularPriceCents);
    });
    const base = calculateCohortReport(eligibleOrders);
    const finished = sessions.filter((session) => session.startedAt && session.endedAt
      && session.trafficMode === 'NATURAL_ONLY'
      && ['STOPPED', 'COMPLETED'].includes(session.state));
    const shanghaiDay = (value: string) => new Date(new Date(value).getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const liveNights = new Set(finished.map((session) => shanghaiDay(session.startedAt!))).size;
    const totalLiveMilliseconds = finished.reduce((sum, session) => {
      const duration = new Date(session.endedAt!).getTime() - new Date(session.startedAt!).getTime();
      return sum + Math.max(0, duration);
    }, 0);
    const liveMinutes = Math.floor(totalLiveMilliseconds / 60_000);
    const pilotLimitBreached = liveNights > 30 || liveMinutes > 3_600;
    const invalidRecords = totalRecordedOrders - eligibleOrders.length;
    const trialMissing = liveNights === 0 || liveMinutes === 0;
    const quantitativeThresholdsMet = base.qualifies && !pilotLimitBreached && !trialMissing && invalidRecords === 0;
    const extraReasons = [
      ...(pilotLimitBreached ? ['试播超过30晚或累计60小时上限'] : []),
      ...(trialMissing ? ['尚无已结束且有真实时长的自然流量直播场次'] : []),
      ...(invalidRecords > 0 ? [`有${invalidRecords}笔记录缺少有效商品、场次或可校验证据，未计入判定`] : []),
      ...(quantitativeThresholdsMet ? ['量化门槛已满足，但证据内容、平台归因和经营口径仍需独立人工复核后写入公司权威台账'] : []),
    ];
    return {
      ...base,
      totalRecordedOrders,
      eligibleOrders: eligibleOrders.length,
      liveNights,
      liveMinutes,
      pilotLimitBreached,
      quantitativeThresholdsMet,
      qualifies: false,
      reasons: [...base.reasons, ...extraReasons],
    };
  }

  async exportCohort() {
    const [config, offers, orders, report, quarantinedOrderIds, quarantinedSessionIds] = await Promise.all([
      this.database.getStoreConfig(),
      this.database.listOffers(),
      this.database.listOrders(),
      this.cohortReport(),
      this.database.listInvalidOrderIds(),
      this.database.listInvalidSessionIds(),
    ]);
    const bundle = {
      schemaVersion: 1,
      product: '猫掌柜 AI 实景直播经营系统',
      productStatus: 'LOCAL_COMMERCIAL_CANDIDATE',
      generatedAt: new Date().toISOString(),
      authorityNotice: '本文件是本地复核包，不是公司权威经营台账，不证明已商用或已经赚钱。',
      config,
      offerSnapshots: offers,
      orderOutcomes: orders,
      quarantinedOrderIds,
      quarantinedSessionIds,
      cohortReport: report,
    };
    await this.database.recordExport('COHORT_REVIEW_BUNDLE', {
      orderCount: orders.length,
      qualifies: report.qualifies,
      generatedAt: bundle.generatedAt,
    });
    return bundle;
  }

  audit(limit: number) {
    return this.database.listAudit(limit);
  }

  private async requireSession(id: string): Promise<LiveSession> {
    const session = await this.database.getSession(id);
    if (!session) throw new Error('直播场次不存在');
    return session;
  }

  private async checkPresence(): Promise<void> {
    const session = await this.database.getLatestSession();
    if (!session || session.state !== 'LIVE' || !session.lastPresenceAt) return;
    const config = await this.database.getStoreConfig();
    const intervalMs = config.presenceIntervalMinutes * 60_000;
    const elapsed = Date.now() - new Date(session.lastPresenceAt).getTime();
    const missed = Math.floor(elapsed / intervalMs);
    if (missed <= session.missedPresence) return;
    const timestamp = new Date().toISOString();
    const nextMissed = Math.min(missed, config.maxMissedPresence);
    if (nextMissed >= config.maxMissedPresence) {
      const paused: LiveSession = {
        ...session,
        state: 'PAUSED',
        missedPresence: nextMissed,
        stopReason: '连续两次未确认员工在场，AI播报已停止',
        updatedAt: timestamp,
      };
      await this.database.saveSessionIfCurrent(paused, session.state, session.updatedAt, 'PRESENCE_FAILSAFE_PAUSED');
      await this.database.appendEvent({
        id: crypto.randomUUID(),
        sessionId: session.id,
        type: 'RISK_ALERT',
        severity: 'CRITICAL',
        message: paused.stopReason ?? '员工失联',
        payload: { missedPresence: nextMissed },
        createdAt: timestamp,
      });
      return;
    }
    await this.database.saveSessionIfCurrent({ ...session, missedPresence: nextMissed, updatedAt: timestamp }, session.state, session.updatedAt, 'PRESENCE_MISSED');
  }

  private async runSafetyHeartbeat(): Promise<void> {
    const session = await this.database.getLatestSession();
    if (!session || session.state !== 'LIVE') return;
    const startedAt = session.startedAt ? new Date(session.startedAt).getTime() : Date.now();
    const mustEndAt = Math.min(startedAt + 7_200_000, new Date(session.scheduledEnd).getTime());
    if (Date.now() >= mustEndAt) {
      const timestamp = new Date().toISOString();
      const completed: LiveSession = {
        ...session, state: 'COMPLETED', endedAt: timestamp, stopReason: '单场两小时或预定结束时间已到，AI播报已停止', updatedAt: timestamp,
      };
      await this.database.saveSessionIfCurrent(completed, session.state, session.updatedAt, 'SESSION_DURATION_COMPLETED');
      await this.database.appendEvent({
        id: crypto.randomUUID(), sessionId: session.id, type: 'SESSION_TRANSITION', severity: 'INFO',
        message: completed.stopReason ?? '单场结束', payload: { from: 'LIVE', to: 'COMPLETED' }, createdAt: timestamp,
      });
      return;
    }
    if (!this.hardware.cameraReady || !this.hardware.voiceReady || !this.hardware.takeoverReady) {
      const timestamp = new Date().toISOString();
      const paused: LiveSession = {
        ...session,
        state: 'PAUSED',
        stopReason: '设备或人工接管门禁失效，AI播报已停止',
        updatedAt: timestamp,
      };
      await this.database.saveSessionIfCurrent(paused, session.state, session.updatedAt, 'HARDWARE_FAILSAFE_PAUSED');
      await this.database.appendEvent({
        id: crypto.randomUUID(), sessionId: session.id, type: 'RISK_ALERT', severity: 'CRITICAL',
        message: paused.stopReason ?? '硬件门禁失效', payload: { hardware: this.hardware }, createdAt: timestamp,
      });
      return;
    }
    const activeOffer = await this.database.getActiveOffer();
    if (!activeOffer || activeOffer.id !== session.offerSnapshotId) {
      const timestamp = new Date().toISOString();
      const paused: LiveSession = {
        ...session,
        state: 'PAUSED',
        stopReason: '商品快照或证据已经失效，AI播报和价格展示已停止',
        updatedAt: timestamp,
      };
      await this.database.saveSessionIfCurrent(paused, session.state, session.updatedAt, 'OFFER_EVIDENCE_FAILSAFE_PAUSED');
      await this.database.appendEvent({
        id: crypto.randomUUID(), sessionId: session.id, type: 'RISK_ALERT', severity: 'CRITICAL',
        message: paused.stopReason ?? '商品快照证据失效', payload: {}, createdAt: timestamp,
      });
      return;
    }
    await this.checkPresence();
  }

  private async triggerSafetyHeartbeat(): Promise<void> {
    if (this.heartbeatRunning) return;
    this.heartbeatRunning = true;
    try {
      await this.runSafetyHeartbeat();
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知安全心跳异常';
      this.runtimeUnsafeReason = `安全心跳异常，AI播报已停止，需要员工复核：${message}`;
      const session = await this.database.getLatestSession().catch(() => null);
      if (session?.state === 'LIVE') {
        const timestamp = new Date().toISOString();
        await this.database.saveSessionIfCurrent({
          ...session,
          state: 'PAUSED',
          stopReason: this.runtimeUnsafeReason,
          updatedAt: timestamp,
        }, session.state, session.updatedAt, 'SAFETY_HEARTBEAT_FAILED_PAUSED').catch(() => undefined);
        await this.database.appendEvent({
          id: crypto.randomUUID(), sessionId: session.id, type: 'RISK_ALERT', severity: 'CRITICAL',
          message: this.runtimeUnsafeReason, payload: {}, createdAt: timestamp,
        }).catch((auditError: unknown) => console.error('安全心跳审计失败', auditError));
      } else if (session) {
        await this.database.appendEvent({
          id: crypto.randomUUID(), sessionId: session.id, type: 'RISK_ALERT', severity: 'WARNING',
          message: `安全心跳本轮未执行：${message}`, payload: {}, createdAt: new Date().toISOString(),
        }).catch((auditError: unknown) => console.error('安全心跳审计失败', auditError));
      } else {
        console.error('安全心跳失败且没有可关联场次', error);
      }
    } finally {
      this.heartbeatRunning = false;
    }
  }

  private async seedKnowledge(): Promise<void> {
    const existing = await this.database.listKnowledge();
    const capturedAt = '2026-08-14T00:00:00.000Z';
    const validUntil = '2026-09-13T15:59:59.000Z';
    const sourceUri = resolve(import.meta.dirname, '..', '..', '..', 'docs', 'APPROVED_LIVE_KNOWLEDGE.md');
    const evidenceBytes = await readFile(sourceUri);
    const expectedSha256 = '70be1a0a2228664e39e93289cb79c15ef68413832ce857c0622d7bf0408e5320';
    const actualSha256 = createHash('sha256').update(evidenceBytes).digest('hex');
    if (actualSha256 !== expectedSha256) throw new Error('直播白名单知识证据已变化，必须重新人工复核后更新程序指纹');
    const evidenceDirectory = join(this.database.dataDir, 'evidence');
    const storedEvidencePath = join(evidenceDirectory, `${APPROVED_KNOWLEDGE_EVIDENCE_ID}.md`);
    await mkdir(evidenceDirectory, { recursive: true });
    try {
      await writeFile(storedEvidencePath, evidenceBytes, { flag: 'wx' });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
    const storedEvidenceBytes = await readFile(storedEvidencePath);
    if (createHash('sha256').update(storedEvidenceBytes).digest('hex') !== expectedSha256) {
      throw new Error('已保全直播白名单知识证据被改写，自动播报保持阻断');
    }
    await this.database.recordEvidenceFile(APPROVED_KNOWLEDGE_EVIDENCE_ID, {
      originalName: 'APPROVED_LIVE_KNOWLEDGE.md',
      mimeType: 'text/markdown',
      bytes: storedEvidenceBytes.byteLength,
      sha256: expectedSha256,
      sourceUri: resolve(storedEvidencePath),
      privacyConfirmed: true,
      systemPinned: true,
    });
    const evidence = {
      id: APPROVED_KNOWLEDGE_EVIDENCE_ID,
      title: '猫掌柜公司经营规则库（本地记录，正式试播前复核）',
      sourceType: 'MERCHANT_RECORD' as const,
      sourceUri: resolve(storedEvidencePath),
      capturedAt,
      validUntil,
      sha256: expectedSha256,
    };
    for (const item of existing.filter((existingItem) => !APPROVED_KNOWLEDGE_IDS.has(existingItem.id))) {
      await this.database.saveKnowledge({
        ...item,
        decision: 'OPERATOR_REQUIRED',
        risk: 'HIGH',
        status: item.status === 'RETIRED' ? 'RETIRED' : 'DRAFT',
      });
    }
    for (const item of APPROVED_KNOWLEDGE_DEFINITIONS) {
      await this.database.saveKnowledge({ ...item, evidenceRefs: [evidence], validUntil, status: 'ACTIVE' });
    }
  }

  private matchesApprovedDefinition(item: Awaited<ReturnType<LiveDatabase['listKnowledge']>>[number]): boolean {
    const approved = APPROVED_KNOWLEDGE_DEFINITIONS.find((definition) => definition.id === item.id);
    return Boolean(approved
      && item.intent === approved.intent
      && item.label === approved.label
      && item.answer === approved.answer
      && item.risk === approved.risk
      && item.decision === approved.decision
      && item.status === 'ACTIVE'
      && item.evidenceRefs.length === 1
      && item.evidenceRefs[0]?.id === APPROVED_KNOWLEDGE_EVIDENCE_ID);
  }

  private async verifiedApprovedKnowledge(items: Awaited<ReturnType<LiveDatabase['listKnowledge']>>) {
    const verified = await Promise.all(items.map(async (item) => (
      this.matchesApprovedDefinition(item)
      && redactPersonalData(item.answer) === item.answer
      && item.evidenceRefs.every((evidence) => evidenceMatchesStoredFile(evidence))
      && await this.database.allEvidenceIsRegistered(item.evidenceRefs)
        ? item : null
    )));
    return verified.filter((item): item is NonNullable<typeof item> => item !== null);
  }
}
