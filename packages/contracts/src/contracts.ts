import { z } from 'zod';

/**
 * 共享类型与校验契约。
 * 这些 schema 同时被 apps/api（运行时校验请求体）与 apps/desktop（仅类型）使用。
 * 重建说明：原 packages/contracts 源码丢失，本文件依据消费方（apps/api、apps/desktop）
 * 的实际使用方式、docs/PRODUCT_SPEC.json 与 APPROVED_LIVE_KNOWLEDGE.md 反推字段后重建。
 */

export const EvidenceSourceTypeSchema = z.enum([
  'MERCHANT_RECORD',
  'OFFICIAL_WRITTEN',
  'COST_RECORD',
  'AUTHORIZED_ASSET',
]);
export type EvidenceSourceType = z.infer<typeof EvidenceSourceTypeSchema>;

export const EvidenceRefSchema = z.object({
  id: z.string(),
  title: z.string(),
  sourceType: EvidenceSourceTypeSchema,
  sourceUri: z.string().nullable(),
  capturedAt: z.string(),
  validUntil: z.string(),
  sha256: z.string().nullable(),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const OfferSnapshotSchema = z.object({
  id: z.string(),
  productId: z.string(),
  title: z.string(),
  priceCents: z.number(),
  regularPriceCents: z.number().nullable(),
  shoeTypes: z.array(z.string()),
  serviceAreas: z.array(z.string()),
  evidenceRefs: z.array(EvidenceRefSchema),
  // 流程精简（v8.1）：不再要求上传文件证据，改由商家逐项自查确认（真实合规把关仍保留）
  selfChecks: z.object({
    offerConfirmed: z.boolean(),
    costConfirmed: z.boolean(),
    assetConfirmed: z.boolean(),
  }).default({ offerConfirmed: false, costConfirmed: false, assetConfirmed: false }),
  capturedAt: z.string(),
  validUntil: z.string(),
  status: z.enum(['ACTIVE', 'EXPIRED', 'DRAFT']),
});
export type OfferSnapshot = z.infer<typeof OfferSnapshotSchema>;

export const KnowledgeRiskSchema = z.enum(['LOW', 'MEDIUM', 'HIGH']);
export type KnowledgeRisk = z.infer<typeof KnowledgeRiskSchema>;

export const KnowledgeDecisionSchema = z.enum(['AUTO_ALLOWED', 'OPERATOR_REQUIRED', 'BLOCKED']);
export type KnowledgeDecision = z.infer<typeof KnowledgeDecisionSchema>;

export const KnowledgeItemSchema = z.object({
  id: z.string(),
  intent: z.string(),
  label: z.string(),
  risk: KnowledgeRiskSchema,
  decision: KnowledgeDecisionSchema,
  answer: z.string(),
  validUntil: z.string(),
  evidenceRefs: z.array(EvidenceRefSchema),
  status: z.enum(['ACTIVE', 'DRAFT', 'RETIRED']),
});
export type KnowledgeItem = z.infer<typeof KnowledgeItemSchema>;

export const OrderOutcomeSchema = z.object({
  id: z.string(),
  externalRefHash: z.string(),
  customerRefHash: z.string(),
  newCustomerConfirmed: z.boolean(),
  offerSnapshotId: z.string(),
  liveSessionId: z.string(),
  firstPaidAt: z.string(),
  pickedUpAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  refundedAt: z.string().nullable(),
  repeatPaidAt: z.string().nullable(),
  repeatAtRegularPrice: z.boolean(),
  repeatPriceCents: z.number().nullable(),
  firstNetSettlementCents: z.number().nullable(),
  repeatNetSettlementCents: z.number().nullable(),
  platformFeeCents: z.number().nullable(),
  pickupDeliveryCostCents: z.number().nullable(),
  productionLaborCostCents: z.number().nullable(),
  materialCostCents: z.number().nullable(),
  liveLaborCostCents: z.number().nullable(),
  reworkCostCents: z.number().nullable(),
  compensationCostCents: z.number().nullable(),
  equipmentCostCents: z.number().nullable(),
  softwareCostCents: z.number().nullable(),
  evidenceRefs: z.array(EvidenceRefSchema),
  // v8.1 起订单也可自查确认（不再强制上传证据文件）：记录真实履约 + 成本按真实口径
  selfChecks: z.object({
    recordConfirmed: z.boolean(),
    costConfirmed: z.boolean(),
  }).default({ recordConfirmed: false, costConfirmed: false }),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type OrderOutcome = z.infer<typeof OrderOutcomeSchema>;

export const LiveSessionStateSchema = z.enum([
  'DRAFT',
  'PREFLIGHT_BLOCKED',
  'READY',
  'LIVE',
  'PAUSED',
  'STOPPED',
  'COMPLETED',
]);
export type LiveSessionState = z.infer<typeof LiveSessionStateSchema>;

export const LiveSessionSchema = z.object({
  id: z.string(),
  offerSnapshotId: z.string().nullable(),
  trafficMode: z.enum(['NATURAL_ONLY']),
  state: LiveSessionStateSchema,
  scheduledStart: z.string(),
  scheduledEnd: z.string(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  lastPresenceAt: z.string().nullable(),
  missedPresence: z.number(),
  stopReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LiveSession = z.infer<typeof LiveSessionSchema>;

export const RunSheetSceneSchema = z.enum([
  'WORKBENCH',
  'PROCESS_CLOSEUP',
  'SERVICE_FACTS',
  'Q_AND_A',
  'OFFER',
]);
export type RunSheetScene = z.infer<typeof RunSheetSceneSchema>;

export const RunSheetSegmentSchema = z.object({
  id: z.string(),
  title: z.string(),
  durationSeconds: z.number(),
  script: z.string(),
  scene: RunSheetSceneSchema,
  approved: z.boolean(),
  evidenceRefs: z.array(EvidenceRefSchema),
});
export type RunSheetSegment = z.infer<typeof RunSheetSegmentSchema>;

export const PreflightCheckStatusSchema = z.enum(['PASS', 'BLOCKED', 'MANUAL_REQUIRED']);
export type PreflightCheckStatus = z.infer<typeof PreflightCheckStatusSchema>;

export const PreflightCheckSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: PreflightCheckStatusSchema,
  detail: z.string(),
  required: z.boolean(),
});
export type PreflightCheck = z.infer<typeof PreflightCheckSchema>;

export const TtsConfigSchema = z.object({
  // 播报音色来源（v30 起只保留火山·豆包语音；system 为无 Key 时的系统语音兜底）
  provider: z.enum(['system', 'volcengine']),
  systemVoiceName: z.string().nullable(),
  volcengine: z.object({
    // 新版控制台统一 API Key（X-Api-Key 单头鉴权，走豆包语音合成大模型，音色自动匹配 1.0/2.0）
    apiKey: z.string(),
    // 旧版 AppID/Token 字段保留仅作数据兼容，不再使用
    appId: z.string(),
    accessToken: z.string(),
    cluster: z.string(),
    voiceType: z.string(),
  }),
});
export type TtsConfig = z.infer<typeof TtsConfigSchema>;

export const StoreConfigSchema = z.object({
  presenceIntervalMinutes: z.number(),
  maxMissedPresence: z.number(),
  // 任务E·阶段2：商家通用配置（首次启动向导写入，输出屏/商品快照/话术读取）
  storeName: z.string(),
  tagline: z.string(),
  serviceAreas: z.array(z.string()),
  serviceAreasConfirmed: z.boolean(),
  productCategories: z.array(z.string()),
  onboardingCompleted: z.boolean(),
  // v13.1：播报音色设置（v30 起只保留火山·豆包语音 + 系统语音兜底）
  tts: TtsConfigSchema.default({
    provider: 'system',
    systemVoiceName: null,
    volcengine: { apiKey: '', appId: '', accessToken: '', cluster: 'volcano_tts', voiceType: 'zh_female_cancan_uranus_bigtts' },
  }),
  // v31.1：话术稿（预生成音频用）——老板维护一组直播话术，一键预生成音频存本地，直播命中本地音频不消耗 API
  pregenScripts: z.array(z.string()).default([]),
  // v32：直播画面形态——camera（俯拍摄像头实景）| video（录屏视频素材，免摄像头）
  screenPlay: z.object({
    provider: z.enum(['camera', 'video']).default('camera'),
    videoFileName: z.string().default(''),   // 录屏素材：.data/media/videos/ 下的文件名
    videoPersona: z.string().default(''),    // 备注（可选）
  }).default({ provider: 'camera', videoFileName: '', videoPersona: '' }),
  // ===== 小白商用重构 v2（阶段1）=====
  // 完整初始化标记：4 步向导全部完成后置 true；老用户按兼容规则推导，不重走向导
  setupCompleted: z.boolean().default(false),
  // 配置快照：向导完成时间与各项确认，供审计与"重新配置"比对
  setupSnapshot: z.object({
    completedAt: z.string().default(''),
    version: z.number().default(2),
    confirmed: z.object({
      serviceAreas: z.boolean().default(false),
      offer: z.boolean().default(false),
      hardware: z.boolean().default(false),
    }).default({ serviceAreas: false, offer: false, hardware: false }),
  }).default({ completedAt: '', version: 2, confirmed: { serviceAreas: false, offer: false, hardware: false } }),
  // 监护确认落盘（替代 service 内存态）：首次确认后永久复用，除非主动重配
  hardwareConfirmed: z.boolean().default(false),
  hardwareConfirmedAt: z.string().nullable().default(null),
});
export type StoreConfig = z.infer<typeof StoreConfigSchema>;

export const RuntimeEventSeveritySchema = z.enum(['INFO', 'WARNING', 'CRITICAL']);
export type RuntimeEventSeverity = z.infer<typeof RuntimeEventSeveritySchema>;

export const RuntimeEventSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  type: z.string(),
  severity: RuntimeEventSeveritySchema,
  message: z.string(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;

export const ResponseEvaluationDecisionSchema = z.enum([
  'AUTO_ALLOWED',
  'OPERATOR_REQUIRED',
  'BLOCKED',
]);
export type ResponseEvaluationDecision = z.infer<typeof ResponseEvaluationDecisionSchema>;

export const ResponseEvaluationResultSchema = z.object({
  decision: ResponseEvaluationDecisionSchema,
  safeAnswer: z.string().optional(),
  reasons: z.array(z.string()),
  redactedQuestion: z.string().optional(),
});
export type ResponseEvaluationResult = z.infer<typeof ResponseEvaluationResultSchema>;

export const ResponseEvaluationRequestSchema = z.object({
  knowledgeItemId: z.string().nullable(),
  question: z.string(),
  proposedAnswer: z.string(),
});
export type ResponseEvaluationRequest = z.infer<typeof ResponseEvaluationRequestSchema>;

export const BackupSummarySchema = z.object({
  name: z.string(),
  dir: z.string(),
  createdAt: z.string(),
  label: z.string(),
  bytes: z.number(),
  fileCount: z.number(),
  counts: z.record(z.string(), z.number()),
  externalEvidenceIds: z.array(z.string()),
});
export type BackupSummary = z.infer<typeof BackupSummarySchema>;

export const BackupIntegritySchema = z.object({
  ok: z.boolean(),
  name: z.string(),
  dir: z.string(),
  manifest: z.unknown().nullable(),
  missing: z.array(z.string()),
  mismatched: z.array(z.string()),
  unlisted: z.array(z.string()),
  manifestDigestOk: z.boolean(),
  problems: z.array(z.string()),
});
export type BackupIntegrity = z.infer<typeof BackupIntegritySchema>;

export const RestoreResultSchema = z.object({
  restoredFrom: z.string(),
  dataDir: z.string(),
  safetyBackupDir: z.string(),
  restoredFiles: z.number(),
  removedStaleEvidenceFiles: z.number(),
  rewrittenPaths: z.number(),
  verifiedEvidenceFiles: z.number(),
  externalEvidenceIds: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type RestoreResult = z.infer<typeof RestoreResultSchema>;
