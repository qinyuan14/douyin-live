import assert from 'node:assert/strict';
import test from 'node:test';
import type { OfferSnapshot } from '@mzg/live-contracts';
import { selectCurrentOffer } from './offers.ts';

const now = new Date('2026-08-14T12:00:00.000Z');
const base: OfferSnapshot = {
  id: '11111111-1111-4111-8111-111111111111', productId: 'offer-1', title: '普通鞋基础洗护',
  priceCents: 990, regularPriceCents: 3900, shoeTypes: ['运动鞋'], serviceAreas: ['钟山区主城区'],
  evidenceRefs: [{ id: 'merchant', title: '商品记录', sourceType: 'MERCHANT_RECORD', sourceUri: null, capturedAt: now.toISOString(), validUntil: '2026-08-15T00:00:00.000Z', sha256: null }],
  capturedAt: now.toISOString(), validUntil: '2026-08-15T00:00:00.000Z', status: 'ACTIVE',
};

test('an expired active offer is never selected for the broadcast output', () => {
  assert.equal(selectCurrentOffer([{ ...base, validUntil: now.toISOString() }], now), null);
  assert.equal(selectCurrentOffer([base], now)?.priceCents, 990);
});
