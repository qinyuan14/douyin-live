import assert from 'node:assert/strict';
import test from 'node:test';
import { isPublicHealthRequest, localRequestIsAuthorized } from './runtime-auth.js';

test('only health is public and all operating data requires the runtime token', () => {
  const expectedToken = 'a'.repeat(64);
  assert.equal(isPublicHealthRequest('GET', '/api/health'), true);
  assert.equal(localRequestIsAuthorized({ method: 'GET', url: '/api/bootstrap', expectedToken }), false);
  assert.equal(localRequestIsAuthorized({ method: 'GET', url: '/api/audit', tokenHeader: 'wrong', expectedToken }), false);
  assert.equal(localRequestIsAuthorized({ method: 'GET', url: '/api/audit', tokenHeader: expectedToken, expectedToken }), true);
  assert.equal(localRequestIsAuthorized({ method: 'POST', url: '/api/sessions', tokenHeader: expectedToken, expectedToken }), true);
});
