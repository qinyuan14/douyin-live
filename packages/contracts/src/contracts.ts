import { z } from 'zod';

/**
 * 共享类型与校验契约。
 * 这些 schema 同时被 apps/api（运行时校验请求体）与 apps/desktop（仅类型）使用。
 * 重建说明：原 packages/contracts 源码丢失，本文件依据消费方（apps/api、apps/desktop）
 * 的实际使用方式、docs/PRODUCT_SPEC.md 与 APPROVED_LIVE_KNOWLEDGE.md 反推字段后重建。
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

export const StoreConfigSchema = z.object({
  presenceIntervalMinutes: z.number(),
  maxMissedPresence: z.number(),
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
