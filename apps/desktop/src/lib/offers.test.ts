import assert from 'node:assert/strict';
import test from 'node:test';
import type { OfferSnapshot } from '@liveops/live-contracts';
import { selectCurrentOffer } from './offers.ts';

const now = new Date('2026-08-14T12:00:00.000Z');
const base: OfferSnapshot = {
  id: '11111111-1111-4111-8111-111111111111', productId: 'offer-1', title: '常规服务',
  priceCents: 990, regularPriceCents: 3900, shoeTypes: ['常规品类'], serviceAreas: ['主城区'],
  evidenceRefs: [{ id: 'merchant', title: '商品记录', sourceType: 'MERCHANT_RECORD', sourceUri: null, capturedAt: now.toISOString(), validUntil: '2026-08-15T00:00:00.000Z', sha256: null }],
  selfChecks: { offerConfirmed: true, costConfirmed: true, assetConfirmed: true },
  capturedAt: now.toISOString(), validUntil: '2026-08-15T00:00:00.000Z', status: 'ACTIVE',
};

test('an expired active offer is never selected for the broadcast output', () => {
  assert.equal(selectCurrentOffer([{ ...base, validUntil: now.toISOString() }], now), null);
  assert.equal(selectCurrentOffer([base], now)?.priceCents, 990);
});

test('the newest active offer wins when multiple snapshots exist', () => {
  const older = { ...base, id: 'older', priceCents: 990, validUntil: '2026-08-15T00:00:00.000Z' };
  const newer = { ...base, id: 'newer', priceCents: 1290, validUntil: '2026-08-18T00:00:00.000Z' };
  // 新商品即使排在列表末尾也要被选中（按有效期取最新，而不是列表顺序）
  assert.equal(selectCurrentOffer([older, newer], now)?.priceCents, 1290);
});
