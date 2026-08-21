import type { OfferSnapshot, PreflightCheck, StoreConfig } from '@liveops/live-contracts';

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

/** 商家自查确认（v8.1 起替代文件上传：商品真实性 / 成本真实 / 素材自有） */
function selfChecked(offer: OfferSnapshot | null, key: 'offerConfirmed' | 'costConfirmed' | 'assetConfirmed'): boolean {
  return offer?.selfChecks?.[key] === true;
}

/**
 * 开播硬门禁（通用合规模板）。状态含义：
 * - PASS：已满足
 * - BLOCKED：必需的自查确认/服务区缺失，硬阻断
 * - MANUAL_REQUIRED：需在本机或直播伴侣内人工确认（摄像头/语音/接管、当次授权）
 * 服务区门禁必须商家在首次启动向导显式勾选确认（settings.serviceAreasConfirmed）。
 * v8.1 起不再要求上传文件证据与平台客服书面答复，改为商家逐项自查确认。
 */
export function buildPreflightChecks(input: PreflightInput): PreflightCheck[] {
  const { activeOffer, settings } = input;
  const hardwareReady = input.cameraReady && input.voiceReady && input.takeoverReady;
  const serviceAreaReady = settings.serviceAreasConfirmed && settings.serviceAreas.length > 0;
  const offerServiceAreas = activeOffer?.serviceAreas ?? [];

  return [
    {
      id: 'self-offer',
      label: '商品真实性与价格确认',
      status: selfChecked(activeOffer, 'offerConfirmed') ? 'PASS' : 'BLOCKED',
      detail: selfChecked(activeOffer, 'offerConfirmed')
        ? '已在商品快照中确认商品真实存在且价格如实'
        : '需在商品快照中勾选确认：商品真实存在、价格与店内一致',
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
      id: 'self-cost',
      label: '成本真实性确认',
      status: selfChecked(activeOffer, 'costConfirmed') ? 'PASS' : 'BLOCKED',
      detail: selfChecked(activeOffer, 'costConfirmed')
        ? '已在商品快照中确认按真实成本经营'
        : '需在商品快照中勾选确认：售价按真实成本经营，不构成超低价',
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
      id: 'self-asset',
      label: '素材与 AI 标识确认',
      status: selfChecked(activeOffer, 'assetConfirmed') ? 'PASS' : 'BLOCKED',
      detail: selfChecked(activeOffer, 'assetConfirmed')
        ? '已在商品快照中确认直播素材自有或已授权'
        : '需在商品快照中勾选确认：直播画面素材为自有拍摄或已取得授权',
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
