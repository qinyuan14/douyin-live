import type { EvidenceSourceType, OfferSnapshot, PreflightCheck } from '@liveops/live-contracts';

export interface PreflightInput {
  activeOffer: OfferSnapshot | null;
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
 * 试播硬门禁（PRODUCT_SPEC §5）。状态含义：
 * - PASS：已满足
 * - BLOCKED：必需的官方/成本/素材证据缺失，硬阻断
 * - MANUAL_REQUIRED：需员工在本机或直播伴侣内人工确认（摄像头/语音/接管、当次授权）
 * 当前实现「当次开播授权」永远为 MANUAL_REQUIRED（PRODUCT_SPEC §5 注释）。
 */
export function buildPreflightChecks(input: PreflightInput): PreflightCheck[] {
  const { activeOffer } = input;
  const hardwareReady = input.cameraReady && input.voiceReady && input.takeoverReady;

  return [
    {
      id: 'official-written',
      label: '官方书面客服答复',
      status: hasEvidence(activeOffer, 'OFFICIAL_WRITTEN') ? 'PASS' : 'BLOCKED',
      detail: hasEvidence(activeOffer, 'OFFICIAL_WRITTEN')
        ? '已绑定官方书面客服证据'
        : '缺少当前账号/商品/履约对应的官方书面客服答复',
      required: true,
    },
    {
      id: 'service-area',
      label: '真实可执行服务区清单',
      status: Boolean(activeOffer?.serviceAreas.length) ? 'PASS' : 'BLOCKED',
      detail: Boolean(activeOffer?.serviceAreas.length)
        ? `已确认服务区：${activeOffer!.serviceAreas.join('、')}`
        : '未导入真实可执行服务区清单',
      required: true,
    },
    {
      id: 'cost',
      label: '平台净结算与完整成本',
      status: hasEvidence(activeOffer, 'COST_RECORD') ? 'PASS' : 'BLOCKED',
      detail: hasEvidence(activeOffer, 'COST_RECORD')
        ? '已绑定平台净结算与完整成本证据'
        : '缺少平台净结算、取送/生产/耗材/值守/返工/售后成本证据',
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
        : '缺少已授权黑猫素材与 AI 主持标识审核记录',
      required: true,
    },
    {
      id: 'authorization',
      label: '当次开播授权',
      status: 'MANUAL_REQUIRED',
      detail: '需员工在抖音直播伴侣内人工确认本次账号/商品/日期与开播动作',
      required: true,
    },
  ];
}
