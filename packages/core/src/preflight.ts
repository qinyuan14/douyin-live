import type { OfferSnapshot, PreflightCheck, StoreConfig } from '@liveops/live-contracts';

export interface PreflightInput {
  activeOffer: OfferSnapshot | null;
  settings: StoreConfig;
  // 兼容字段保留（service 侧仍传入），门禁判定不再依赖实时硬件状态（v2 起用落盘配置）
  cameraReady: boolean;
  cameraDeviceId: string | null;
  cameraLabel: string | null;
  cameraStreamActive: boolean;
  cameraFramingConfirmed: boolean;
  voiceReady: boolean;
  takeoverReady: boolean;
}

/**
 * 开播检查（小白商用 v2：6 门禁收敛为 3 检查项）。
 * 理念：配置期（首次 4 步向导一次性确认，落盘 setupCompleted/hardwareConfirmed）
 *  vs 使用期（日常只剩「我已在直播伴侣开播」当次人工确认）。
 * 状态含义：
 * - PASS：已满足
 * - BLOCKED：缺少必要配置（商品未录入），硬阻断
 * - MANUAL_REQUIRED：需人工操作（补全首次设置 / 当次开播授权）
 */
export function buildPreflightChecks(input: PreflightInput): PreflightCheck[] {
  const { activeOffer, settings } = input;
  const setupReady = settings.setupCompleted && settings.hardwareConfirmed;

  return [
    {
      id: 'setup-complete',
      label: '首次设置已完成',
      status: setupReady ? 'PASS' : 'MANUAL_REQUIRED',
      detail: setupReady
        ? '店铺、商品、声音、监护已在首次向导中确认'
        : '首次使用请先完成初始化向导（约 5 分钟），之后打开即用',
      required: true,
    },
    {
      id: 'offer-active',
      label: '商品信息有效',
      status: activeOffer ? 'PASS' : 'BLOCKED',
      detail: activeOffer
        ? `当前商品：${activeOffer.title}（¥${(activeOffer.priceCents / 100).toFixed(2)}）`
        : '请先录入一个真实在售的商品',
      required: true,
    },
    {
      id: 'authorization',
      label: '本次开播授权',
      status: 'MANUAL_REQUIRED',
      detail: '需在抖音直播伴侣内人工开播后，点「我已在直播伴侣开播」',
      required: true,
    },
  ];
}
