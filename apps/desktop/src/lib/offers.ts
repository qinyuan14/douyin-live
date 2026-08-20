import type { OfferSnapshot } from '@liveops/live-contracts';

export function selectCurrentOffer(offers: OfferSnapshot[], now = new Date()): OfferSnapshot | null {
  return offers.find((offer) => offer.status === 'ACTIVE' && new Date(offer.validUntil).getTime() > now.getTime()) ?? null;
}
