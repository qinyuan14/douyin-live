import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { buildRunSheet } from './run-sheet.js';
import { LiveService } from './service.js';
import { projectRoot } from './runtime-auth.js';

test('run sheet covers exactly two hours without repeating one segment', () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const sourceUri = resolve(import.meta.dirname, '..', '..', '..', 'docs', 'APPROVED_LIVE_KNOWLEDGE.md');
  const sha256 = createHash('sha256').update(readFileSync(sourceUri)).digest('hex');
  const evidence = { id: 'merchant-rule', title: '已批准商户规则', sourceType: 'MERCHANT_RECORD' as const, sourceUri, capturedAt: new Date().toISOString(), validUntil: future, sha256 };
  const sheet = buildRunSheet([{
    id: crypto.randomUUID(), intent: 'scope', label: '服务范围', answer: '普通鞋基础洗护以有效商品说明为准。',
    decision: 'AUTO_ALLOWED', risk: 'LOW', evidenceRefs: [evidence], validUntil: future, status: 'ACTIVE',
  }], null, new Date(), () => true);
  assert.equal(sheet.length, 60);
  assert.equal(sheet.reduce((sum, segment) => sum + segment.durationSeconds, 0), 7_200);
  assert.equal(new Set(sheet.map((segment) => segment.script)).size, 60);
  assert.equal(sheet.filter((segment) => segment.approved).length, 48);
  assert.equal(buildRunSheet([{
    id: crypto.randomUUID(), intent: 'scope', label: '服务范围', answer: '普通鞋基础洗护以有效商品说明为准。',
    decision: 'AUTO_ALLOWED', risk: 'LOW', evidenceRefs: [evidence], validUntil: future, status: 'ACTIVE',
  }], null).some((segment) => segment.approved), false);
});

test('expired, unproven and forbidden scripts are never approved', () => {
  const past = new Date(Date.now() - 86_400_000).toISOString();
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const base = { id: crypto.randomUUID(), intent: 'unsafe', label: '不可播', decision: 'AUTO_ALLOWED' as const, risk: 'LOW' as const, status: 'ACTIVE' as const };
  const expired = buildRunSheet([{ ...base, answer: '普通说明', evidenceRefs: [{ id: 'old', title: '过期', sourceType: 'MERCHANT_RECORD' as const, sourceUri: null, capturedAt: past, validUntil: past, sha256: null }], validUntil: past }], null, new Date(), () => true);
  const unproven = buildRunSheet([{ ...base, answer: '普通说明', evidenceRefs: [], validUntil: future }], null, new Date(), () => true);
  const forbidden = buildRunSheet([{ ...base, answer: '保证洗净，恢复如新', evidenceRefs: [{ id: 'current', title: '当前', sourceType: 'MERCHANT_RECORD' as const, sourceUri: null, capturedAt: new Date().toISOString(), validUntil: future, sha256: null }], validUntil: future }], null, new Date(), () => true);
  const sourceUri = resolve(import.meta.dirname, '..', '..', '..', 'docs', 'APPROVED_LIVE_KNOWLEDGE.md');
  const sha256 = createHash('sha256').update(readFileSync(sourceUri)).digest('hex');
  const verifiedEvidence = [{ id: 'verified', title: '已验证', sourceType: 'MERCHANT_RECORD' as const, sourceUri, capturedAt: new Date().toISOString(), validUntil: future, sha256 }];
  const sensitive = buildRunSheet([{ ...base, answer: '皮革和翻毛鞋需要先判断', evidenceRefs: verifiedEvidence, validUntil: future }], null, new Date(), () => true);
  const efficacy = buildRunSheet([{ ...base, answer: '这项服务包含消毒', evidenceRefs: verifiedEvidence, validUntil: future }], null, new Date(), () => true);
  assert.equal(expired.some((segment) => segment.approved), false);
  assert.equal(unproven.some((segment) => segment.approved), false);
  assert.equal(forbidden.some((segment) => segment.approved), false);
  assert.equal(forbidden.some((segment) => segment.script.includes('保证洗净')), false);
  assert.equal(sensitive.some((segment) => segment.approved), false);
  assert.equal(sensitive.some((segment) => segment.script.includes('皮革')), false);
  assert.equal(efficacy.some((segment) => segment.approved), false);
  assert.equal(efficacy.some((segment) => segment.script.includes('消毒')), false);
  assert.equal(buildRunSheet([{
    ...base, answer: '普通说明', evidenceRefs: verifiedEvidence, validUntil: future,
  }], null, new Date(), () => true).filter((segment) => segment.approved).some((segment) => /退款|赔偿|投诉|皮革|翻毛|消毒/.test(segment.script)), false);
});

test('only registered privacy-confirmed evidence can back a displayed offer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mzg-live-api-evidence-registry-'));
  const previousRoot = process.env.MZG_PROJECT_ROOT;
  process.env.MZG_PROJECT_ROOT = root;
  const service = new LiveService();
  try {
    await service.onModuleInit();
    const fakePath = join(root, 'ordinary-file.txt');
    writeFileSync(fakePath, 'ordinary local file');
    const sha256 = createHash('sha256').update(readFileSync(fakePath)).digest('hex');
    const now = new Date().toISOString();
    const validUntil = new Date(Date.now() + 86_400_000).toISOString();
    await assert.rejects(() => service.saveOffer({
      id: crypto.randomUUID(), productId: 'fake', title: '伪证据商品', priceCents: 990, regularPriceCents: 5900,
      shoeTypes: ['运动鞋'], serviceAreas: ['钟山区主城区'], status: 'ACTIVE', capturedAt: now, validUntil,
      evidenceRefs: [{ id: crypto.randomUUID(), title: '普通文件', sourceType: 'MERCHANT_RECORD', sourceUri: fakePath, capturedAt: now, validUntil, sha256 }],
    }), /已保全/);
    const saved = await service.saveEvidenceFile({
      fileName: '商品来源.txt', mimeType: 'text/plain', contentBase64: Buffer.from('商品编号 fake，成交价 9.90元').toString('base64'), privacyConfirmed: true,
    });
    const offer = {
      id: crypto.randomUUID(), productId: 'real', title: '已保全商品', priceCents: 990, regularPriceCents: 5900,
      shoeTypes: ['运动鞋'], serviceAreas: ['钟山区主城区'], status: 'ACTIVE', capturedAt: now, validUntil,
      evidenceRefs: [{ id: saved.id, title: '商品来源', sourceType: 'MERCHANT_RECORD', sourceUri: saved.sourceUri, capturedAt: now, validUntil, sha256: saved.sha256 }],
    } as const;
    await service.saveOffer(offer);
    assert.equal((await service.bootstrap()).offers.some((offer) => offer.status === 'ACTIVE'), true);
    await service.createSession();
    await assert.rejects(() => service.saveOffer({ ...offer, priceCents: 1_090 }), /活动场次/);
    writeFileSync(saved.sourceUri, '证据已被改写');
    assert.equal((await service.bootstrap()).offers.some((item) => item.status === 'ACTIVE'), false);
  } finally {
    await service.onModuleDestroy();
    if (previousRoot === undefined) delete process.env.MZG_PROJECT_ROOT;
    else process.env.MZG_PROJECT_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test('external knowledge stays a reviewed draft and cannot enter automatic speech', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mzg-live-api-knowledge-gate-'));
  const previousRoot = process.env.MZG_PROJECT_ROOT;
  process.env.MZG_PROJECT_ROOT = root;
  const service = new LiveService();
  try {
    await service.onModuleInit();
    const ordinaryPath = join(root, 'ordinary-file.txt');
    writeFileSync(ordinaryPath, 'ordinary local file');
    const ordinarySha = createHash('sha256').update(readFileSync(ordinaryPath)).digest('hex');
    const now = new Date().toISOString();
    const validUntil = new Date(Date.now() + 86_400_000).toISOString();
    const injected = {
      id: crypto.randomUUID(), intent: 'injected-promise', label: '外部承诺', answer: '普通鞋基础洗护承诺十二小时送回',
      decision: 'AUTO_ALLOWED' as const, risk: 'LOW' as const, status: 'ACTIVE' as const, validUntil,
      evidenceRefs: [{ id: crypto.randomUUID(), title: '未登记文件', sourceType: 'MERCHANT_RECORD' as const, sourceUri: ordinaryPath, capturedAt: now, validUntil, sha256: ordinarySha }],
    };
    await assert.rejects(() => service.saveKnowledge(injected), /本工具保全/);
    const evidence = await service.saveEvidenceFile({
      fileName: '知识草稿依据.txt', mimeType: 'text/plain', contentBase64: Buffer.from('仅用于演练的员工知识草稿依据').toString('base64'), privacyConfirmed: true,
    });
    const saved = await service.saveKnowledge({
      ...injected,
      evidenceRefs: [{ ...injected.evidenceRefs[0], id: evidence.id, sourceUri: evidence.sourceUri, sha256: evidence.sha256 }],
    });
    assert.equal(saved.status, 'DRAFT');
    assert.equal(saved.decision, 'OPERATOR_REQUIRED');
    assert.equal(saved.risk, 'HIGH');
    const bootstrap = await service.bootstrap();
    assert.equal(bootstrap.runSheet.some((segment) => segment.script.includes(injected.answer)), false);
    const evaluation = await service.evaluate({ knowledgeItemId: saved.id, question: '多久送回', proposedAnswer: saved.answer });
    assert.equal(evaluation.decision, 'OPERATOR_REQUIRED');
    await assert.rejects(() => service.saveKnowledge({ ...injected, id: crypto.randomUUID(), answer: '联系13812345678确认' }), /完整隐私/);
  } finally {
    await service.onModuleDestroy();
    if (previousRoot === undefined) delete process.env.MZG_PROJECT_ROOT;
    else process.env.MZG_PROJECT_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test('fresh installation stays fail-closed and creates an auditable draft session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mzg-live-api-'));
  const previousRoot = process.env.MZG_PROJECT_ROOT;
  process.env.MZG_PROJECT_ROOT = root;
  const service = new LiveService();
  try {
    await service.onModuleInit();
    const preflight = await service.preflight();
    assert.equal(preflight.blocked, true);
    assert.equal(preflight.formalTrialUnlocked, false);
    const session = await service.createSession();
    assert.equal(session.state, 'PREFLIGHT_BLOCKED');
    await assert.rejects(() => service.transition(session.id, 'LIVE', null, true), /非法场次状态变化/);
    const audit = await service.audit(20);
    assert.equal(audit.some((entry) => entry.action === 'SESSION_CREATED'), true);
  } finally {
    await service.onModuleDestroy();
    if (previousRoot === undefined) delete process.env.MZG_PROJECT_ROOT;
    else process.env.MZG_PROJECT_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent session requests return the same single active session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mzg-live-api-race-'));
  const previousRoot = process.env.MZG_PROJECT_ROOT;
  process.env.MZG_PROJECT_ROOT = root;
  const service = new LiveService();
  try {
    await service.onModuleInit();
    const sessions = await Promise.all([service.createSession(), service.createSession()]);
    assert.equal(sessions[0].id, sessions[1].id);
    assert.equal((await service.bootstrap()).sessions.length, 1);
  } finally {
    await service.onModuleDestroy();
    if (previousRoot === undefined) delete process.env.MZG_PROJECT_ROOT;
    else process.env.MZG_PROJECT_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test('orders without a real finished live session and stored evidence never qualify', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mzg-live-api-finance-'));
  const previousRoot = process.env.MZG_PROJECT_ROOT;
  process.env.MZG_PROJECT_ROOT = root;
  const service = new LiveService();
  try {
    await service.onModuleInit();
    const report = await service.cohortReport();
    assert.equal(report.qualifies, false);
    assert.equal(report.quantitativeThresholdsMet, false);
    assert.equal(report.liveNights, 0);
    assert.ok(report.reasons.includes('尚无已结束且有真实时长的自然流量直播场次'));
  } finally {
    await service.onModuleDestroy();
    if (previousRoot === undefined) delete process.env.MZG_PROJECT_ROOT;
    else process.env.MZG_PROJECT_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test('evidence upload requires a privacy confirmation and rejects visible personal data in text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mzg-live-api-privacy-'));
  const previousRoot = process.env.MZG_PROJECT_ROOT;
  process.env.MZG_PROJECT_ROOT = root;
  const service = new LiveService();
  try {
    await service.onModuleInit();
    await assert.rejects(() => service.saveEvidenceFile({
      fileName: '结算.txt', mimeType: 'text/plain', contentBase64: Buffer.from('姓名：张三，电话13812345678').toString('base64'), privacyConfirmed: true,
    }), /完整隐私/);
    const saved = await service.saveEvidenceFile({
      fileName: '已脱敏.txt', mimeType: 'text/plain', contentBase64: Buffer.from('本地候选经营记录，原始标识已移除').toString('base64'), privacyConfirmed: true,
    });
    assert.equal(saved.sha256.length, 64);
  } finally {
    await service.onModuleDestroy();
    if (previousRoot === undefined) delete process.env.MZG_PROJECT_ROOT;
    else process.env.MZG_PROJECT_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test('project data path resolves from the explicit installation root', () => {
  const previousRoot = process.env.MZG_PROJECT_ROOT;
  process.env.MZG_PROJECT_ROOT = 'E:\\example-install-root';
  try {
    assert.equal(projectRoot(), 'E:\\example-install-root');
  } finally {
    if (previousRoot === undefined) delete process.env.MZG_PROJECT_ROOT;
    else process.env.MZG_PROJECT_ROOT = previousRoot;
  }
});
