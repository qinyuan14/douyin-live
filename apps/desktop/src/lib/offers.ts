import type { OfferSnapshot } from '@liveops/live-contracts';

/**
 * 取当前展示商品：ACTIVE 且未过期中 validUntil 最晚（最新保存/有效期最长）的一份。
 * 多次「更新商品快照」会产生多条 ACTIVE 记录，这里始终取最新的，避免显示旧商品。
 */
export function selectCurrentOffer(offers: OfferSnapshot[], now = new Date()): OfferSnapshot | null {
  const active = offers.filter((offer) => offer.status === 'ACTIVE' && new Date(offer.validUntil).getTime() > now.getTime());
  if (active.length === 0) return null;
  return active.reduce((latest, offer) =>
    new Date(offer.validUntil).getTime() > new Date(latest.validUntil).getTime() ? offer : latest);
}
