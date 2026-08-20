import type { EvidenceSourceType, OfferSnapshot, PreflightCheck, StoreConfig } from '@liveops/live-contracts';

export interface PreflightInput {
  activeOffer: OfferSnapshot | null;
  settings: StoreConfig;
  cameraReady: boolean;
  cameraDeviceId: string | null;
  cameraLabel: string | null;
  cameraStreamActive: boolean;
  cameraFramingConfirmed: boolean;
  voiceReady: boolean;
  takeoverReady: boolean;
}

function hasEvidence(offer: OfferSnapshot | null, sourceType: EvidenceSourceType): boolean {
  return Boolean(offer?.evidenceRefs.some((ref) => ref.sourceType === sourceType && ref.sha256));
}

/**
 * 开播硬门禁（通用合规模板，任务E 由原品牌专属改大众化）。状态含义：
 * - PASS：已满足
 * - BLOCKED：必需的书面/成本/素材证据缺失，硬阻断
 * - MANUAL_REQUIRED：需在本机或直播伴侣内人工确认（摄像头/语音/接管、当次授权）
 * 服务区门禁不再「非空即过」：必须商家在首次启动向导显式勾选确认（settings.serviceAreasConfirmed）。
 */
export function buildPreflightChecks(input: PreflightInput): PreflightCheck[] {
  const { activeOffer, settings } = input;
  const hardwareReady = input.cameraReady && input.voiceReady && input.takeoverReady;
  const serviceAreaReady = settings.serviceAreasConfirmed && settings.serviceAreas.length > 0;
  const offerServiceAreas = activeOffer?.serviceAreas ?? [];

  return [
    {
      id: 'official-written',
      label: '平台规则书面确认',
      status: hasEvidence(activeOffer, 'OFFICIAL_WRITTEN') ? 'PASS' : 'BLOCKED',
      detail: hasEvidence(activeOffer, 'OFFICIAL_WRITTEN')
        ? '已绑定平台规则书面确认证据'
        : '缺少当前账号/商品/履约对应的平台规则书面确认答复',
      required: true,
    },
    {
      id: 'service-area',
      label: '服务范围已确认且可执行',
      status: serviceAreaReady ? 'PASS' : 'BLOCKED',
      detail: serviceAreaReady
        ? `已确认服务范围：${settings.serviceAreas.join('、')}${offerServiceAreas.length ? `（商品覆盖：${offerServiceAreas.join('、')}）` : ''}`
        : '未在初始化向导中确认真实可执行的服务范围清单',
      required: true,
    },
    {
      id: 'cost',
      label: '平台净结算与完整成本',
      status: hasEvidence(activeOffer, 'COST_RECORD') ? 'PASS' : 'BLOCKED',
      detail: hasEvidence(activeOffer, 'COST_RECORD')
        ? '已绑定平台净结算与完整成本证据'
        : '缺少平台净结算、履约/生产/耗材/值守/返工/售后成本证据',
      required: true,
    },
    {
      id: 'hardware',
      label: '摄像头 / 语音 / 人工接管',
      status: hardwareReady ? 'PASS' : 'MANUAL_REQUIRED',
      detail: hardwareReady
        ? '摄像头、中文语音与人工接管均已在本地预览确认'
        : '需在直播输出窗口确认俯拍无脸、中文语音可闻、真人接管就绪',
      required: true,
    },
    {
      id: 'asset',
      label: '素材权利与 AI 标识',
      status: hasEvidence(activeOffer, 'AUTHORIZED_ASSET') ? 'PASS' : 'BLOCKED',
      detail: hasEvidence(activeOffer, 'AUTHORIZED_ASSET')
        ? '已绑定素材权利与 AI 标识审核证据'
        : '缺少已授权素材与 AI 主持标识审核记录',
      required: true,
    },
    {
      id: 'authorization',
      label: '当次开播授权',
      status: 'MANUAL_REQUIRED',
      detail: '需在抖音直播伴侣内人工确认本次账号/商品/日期与开播动作',
      required: true,
    },
  ];
}
