import type {
  BackupIntegrity,
  BackupSummary,
  KnowledgeItem,
  LiveSession,
  LiveSessionState,
  OfferSnapshot,
  OrderOutcome,
  PreflightCheck,
  ResponseEvaluationResult,
  RestoreResult,
  RunSheetSegment,
  StoreConfig,
} from '@liveops/live-contracts';

const API_BASE = 'http://127.0.0.1:3188/api';

export interface CohortReport {
  totalOrders: number;
  completedOrders: number;
  refundedOrders: number;
  repeatOrders: number;
  completeCostOrders: number;
  contributionCents: number | null;
  acquisitionLossBreaches: number;
  dailyLossPoolBreaches: number;
  monthlyLossPoolBreaches: number;
  liveNights: number;
  liveMinutes: number;
  pilotLimitBreached: boolean;
  quantitativeThresholdsMet: boolean;
  qualifies: boolean;
  reasons: string[];
  totalRecordedOrders: number;
  eligibleOrders: number;
}

export interface PreflightResult {
  checks: PreflightCheck[];
  blocked: boolean;
  manualRequired: boolean;
  formalTrialUnlocked: boolean;
}

export interface ActivationState {
  activated: boolean;
  machineId: string;
  licenseCode: string | null;
  expiresAt: number | null;
  reason: string | null;
}

export interface BootstrapData {
  config: StoreConfig;
  offers: OfferSnapshot[];
  knowledge: KnowledgeItem[];
  session: LiveSession | null;
  sessions: LiveSession[];
  orders: OrderOutcome[];
  report: CohortReport;
  preflight: PreflightResult;
  runSheet: RunSheetSegment[];
  hardware: {
    cameraReady: boolean;
    cameraDeviceId: string | null;
    cameraLabel: string | null;
    cameraStreamActive: boolean;
    cameraFramingConfirmed: boolean;
    voiceReady: boolean;
    takeoverReady: boolean;
  };
  runtimeUnsafeReason: string | null;
  activation: ActivationState;
}

export interface StoredEvidenceFile {
  id: string;
  originalName: string;
  sourceUri: string;
  sha256: string;
  bytes: number;
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunkSize = 32_768;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export interface AuditEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = window.liveDesktop?.getLocalToken() ?? '';
  if (!token) throw new Error('本机桌面身份不可用，所有写入和AI播报已停止');
  const timeoutSignal = AbortSignal.timeout(5_000);
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal,
    headers: {
      'Content-Type': 'application/json',
      'X-Live-Local-Token': token,
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ message: '本地服务请求失败' })) as { message?: string };
    throw new Error(payload.message ?? `本地服务请求失败（${response.status}）`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  bootstrap: () => request<BootstrapData>('/bootstrap'),
  getActivation: () => request<ActivationState>('/activation'),
  activate: (code: string) => request<ActivationState>('/activation', { method: 'POST', body: JSON.stringify({ code }) }),
  saveConfig: (input: Partial<StoreConfig>) => request<StoreConfig>('/config', { method: 'PUT', body: JSON.stringify(input) }),
  // v32：录屏视频素材上传（multipart，不设 Content-Type 由浏览器生成 boundary）
  uploadVideo: async (file: File): Promise<{ fileName: string; size: number }> => {
    const token = window.liveDesktop?.getLocalToken() ?? '';
    if (!token) throw new Error('本机桌面身份不可用');
    const form = new FormData();
    form.append('file', file);
    const response = await fetch(`${API_BASE}/media/videos`, {
      method: 'POST',
      headers: { 'X-Live-Local-Token': token },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({ message: '视频上传失败' })) as { message?: string };
      throw new Error(payload.message ?? '视频上传失败');
    }
    return response.json() as Promise<{ fileName: string; size: number }>;
  },
  // v13.1：语音合成（text → mp3 base64）；provider/apiKey 可选（试听时跟随界面选择）
  tts: (input: { text: string; voiceType?: string; provider?: 'system' | 'volcengine'; apiKey?: string }) => request<{ audioBase64: string; format: string }>('/tts', { method: 'POST', body: JSON.stringify(input) }),
  // v31.1：话术预生成音频（存本地）与本地缓存查询（直播命中本地音频零 API）
  ttsPregen: (input: { text: string }) => request<{ cached: boolean; key: string; bytes: number }>('/tts/pregen', { method: 'POST', body: JSON.stringify(input) }),
  ttsPregenCheck: (input: { text: string }) => request<{ cached: boolean; audioBase64?: string; format?: string }>('/tts/pregen-check', { method: 'POST', body: JSON.stringify(input) }),
  saveOffer: (input: OfferSnapshot) => request<OfferSnapshot>('/offers', { method: 'POST', body: JSON.stringify(input) }),
  saveKnowledge: (input: KnowledgeItem) => request<KnowledgeItem>('/knowledge', { method: 'POST', body: JSON.stringify(input) }),
  evaluate: (input: { knowledgeItemId: string | null; question: string; proposedAnswer: string }) =>
    request<ResponseEvaluationResult>('/responses/evaluate', { method: 'POST', body: JSON.stringify(input) }),
  authorizeRunSheet: (script: string) => request<{ allowed: true; script: string; scene: RunSheetSegment['scene'] }>('/run-sheet/authorize', { method: 'POST', body: JSON.stringify({ script }) }),
  updateHardware: (input: Partial<BootstrapData['hardware']>) =>
    request<BootstrapData['hardware']>('/runtime/hardware', { method: 'POST', body: JSON.stringify(input) }),
  uploadEvidence: async (file: File, privacyConfirmed: true) => request<StoredEvidenceFile>('/evidence/files', {
    method: 'POST',
    body: JSON.stringify({ fileName: file.name, mimeType: file.type || 'application/octet-stream', contentBase64: await fileToBase64(file), privacyConfirmed }),
  }),
  createSession: () => request<LiveSession>('/sessions', { method: 'POST' }),
  transition: (id: string, state: LiveSessionState, reason: string | null, externalStartConfirmed = false) =>
    request<LiveSession>(`/sessions/${id}/transition`, {
      method: 'PATCH',
      body: JSON.stringify({ state, reason, externalStartConfirmed }),
    }),
  acknowledgePresence: (id: string) => request<LiveSession>(`/sessions/${id}/presence`, { method: 'POST' }),
  addEvent: (id: string, input: { type: 'OPERATOR_ACTION' | 'CAMERA_STATUS' | 'VOICE_STATUS' | 'RISK_ALERT'; severity: 'INFO' | 'WARNING' | 'CRITICAL'; message: string; payload?: Record<string, unknown> }) =>
    request(`/sessions/${id}/events`, { method: 'POST', body: JSON.stringify(input) }),
  saveOrder: (input: OrderOutcome) => request<OrderOutcome>('/orders', { method: 'POST', body: JSON.stringify(input) }),
  audit: () => request<AuditEntry[]>('/audit?limit=200'),
  exportCohort: () => request<Record<string, unknown>>('/exports/cohort', { method: 'POST' }),
  listBackups: () => request<BackupSummary[]>('/backups'),
  createBackup: (label?: string) => request<BackupSummary>('/backups', { method: 'POST', body: JSON.stringify({ label }) }),
  verifyBackup: (name: string) => request<BackupIntegrity>(`/backups/${encodeURIComponent(name)}/verify`),
  restoreBackup: (name: string) => request<RestoreResult>(`/backups/${encodeURIComponent(name)}/restore`, { method: 'POST' }),
};
