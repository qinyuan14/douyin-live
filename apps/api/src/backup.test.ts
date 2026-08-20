import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  createLocalBackup,
  findRestoreBlockingState,
  inspectLocalBackup,
  listLocalBackups,
  restoreLocalBackup,
} from '@liveops/live-core';

/** 造一份最小但完整的业务数据目录。 */
function buildDataDir(dataDir: string): { evidencePath: string; evidenceSha256: string } {
  mkdirSync(dataDir, { recursive: true });
  const evidenceDir = join(dataDir, 'evidence');
  mkdirSync(evidenceDir, { recursive: true });
  const evidenceBytes = Buffer.from('证据原文：服务规则 v1', 'utf8');
  const evidencePath = join(evidenceDir, 'e1.md');
  writeFileSync(evidencePath, evidenceBytes);
  const evidenceSha256 = createHash('sha256').update(evidenceBytes).digest('hex');
  const now = new Date().toISOString();
  const validUntil = new Date(Date.now() + 86_400_000).toISOString();
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ presenceIntervalMinutes: 5, maxMissedPresence: 2 }, null, 2));
  writeFileSync(join(dataDir, 'offers.json'), JSON.stringify([{
    id: 'offer-1', productId: 'p1', title: '常规服务', priceCents: 1990, regularPriceCents: 3990,
    shoeTypes: ['常规品类'], serviceAreas: ['主城区'], status: 'ACTIVE', capturedAt: now, validUntil,
    evidenceRefs: [{ id: 'e1', title: '服务规则', sourceType: 'MERCHANT_RECORD', sourceUri: resolve(evidencePath), capturedAt: now, validUntil, sha256: evidenceSha256 }],
  }], null, 2));
  writeFileSync(join(dataDir, 'knowledge.json'), '[]');
  writeFileSync(join(dataDir, 'sessions.json'), '[]');
  writeFileSync(join(dataDir, 'orders.json'), '[]');
  writeFileSync(join(dataDir, 'events.json'), '[]');
  writeFileSync(join(dataDir, 'audit.json'), '[]');
  writeFileSync(join(dataDir, 'evidence.json'), JSON.stringify({
    e1: { originalName: 'e1.md', mimeType: 'text/markdown', bytes: evidenceBytes.byteLength, sha256: evidenceSha256, sourceUri: resolve(evidencePath), privacyConfirmed: true },
  }, null, 2));
  return { evidencePath, evidenceSha256 };
}

test('backup: 备份-篡改-恢复闭环，数据与证据完整回归', async () => {
  const root = await mkdtemp(join(tmpdir(), 'live-backup-roundtrip-'));
  try {
    const dataDir = join(root, 'live-system');
    const { evidencePath, evidenceSha256 } = buildDataDir(dataDir);
    const summary = createLocalBackup({ dataDir, label: '闭环测试' });
    assert.equal(summary.fileCount, 9); // 8 个 JSON + 1 个证据文件

    // 篡改现场：删证据文件、改商品
    rmSync(evidencePath);
    const offers = JSON.parse(readFileSync(join(dataDir, 'offers.json'), 'utf8')) as Array<{ title: string }>;
    offers[0]!.title = '被篡改的商品';
    writeFileSync(join(dataDir, 'offers.json'), JSON.stringify(offers, null, 2));

    const result = restoreLocalBackup({ backupDir: summary.dir, dataDir });
    assert.equal(result.restoredFiles, 9);
    assert.equal(result.verifiedEvidenceFiles, 1);
    assert.equal(result.removedStaleEvidenceFiles, 0);

    // 证据文件回来了且指纹一致
    const restoredEvidence = readFileSync(evidencePath);
    assert.equal(createHash('sha256').update(restoredEvidence).digest('hex'), evidenceSha256);
    const restoredOffers = JSON.parse(readFileSync(join(dataDir, 'offers.json'), 'utf8')) as Array<{ title: string }>;
    assert.equal(restoredOffers[0]!.title, '常规服务');
    assert.equal(findRestoreBlockingState(dataDir), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('backup: 备份文件被篡改后整体拒绝恢复，现场数据保持不动', async () => {
  const root = await mkdtemp(join(tmpdir(), 'live-backup-tamper-'));
  try {
    const dataDir = join(root, 'live-system');
    const { evidencePath } = buildDataDir(dataDir);
    const summary = createLocalBackup({ dataDir, label: '篡改测试' });

    // 改备份包里的证据文件
    const backedEvidence = join(summary.dir, 'data', 'evidence', 'e1.md');
    writeFileSync(backedEvidence, Buffer.from('被人改过的证据', 'utf8'));

    const integrity = inspectLocalBackup(summary.dir);
    assert.equal(integrity.ok, false);
    assert.equal(integrity.mismatched.length, 1);

    // 现场再做一次标记，恢复失败后标记应仍在
    writeFileSync(join(dataDir, 'offers.json'), '[{"title":"现场标记"}]');
    assert.throws(
      () => restoreLocalBackup({ backupDir: summary.dir, dataDir }),
      /校验未通过|SHA256/,
    );
    const untouched = readFileSync(join(dataDir, 'offers.json'), 'utf8');
    assert.equal(untouched, '[{"title":"现场标记"}]');
    assert.equal(createHash('sha256').update(readFileSync(evidencePath)).digest('hex').length, 64);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('backup: 直播中（LIVE/PAUSED）禁止恢复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'live-backup-live-'));
  try {
    const dataDir = join(root, 'live-system');
    buildDataDir(dataDir);
    const summary = createLocalBackup({ dataDir, label: '直播拦截测试' });

    const now = new Date().toISOString();
    writeFileSync(join(dataDir, 'sessions.json'), JSON.stringify([{
      id: 's1', offerSnapshotId: null, trafficMode: 'NATURAL_ONLY', state: 'LIVE',
      scheduledStart: now, scheduledEnd: now, startedAt: now, endedAt: null,
      lastPresenceAt: now, missedPresence: 0, stopReason: null, createdAt: now, updatedAt: now,
    }], null, 2));
    assert.equal(findRestoreBlockingState(dataDir), 'LIVE');
    assert.throws(
      () => restoreLocalBackup({ backupDir: summary.dir, dataDir }),
      /禁止恢复/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('backup: 跨安装目录恢复会重写证据路径并保持指纹校验通过，不碰身份令牌', async () => {
  const root = await mkdtemp(join(tmpdir(), 'live-backup-rehome-'));
  try {
    const backupsRoot = join(root, 'backups');
    const dirA = join(root, 'install-a', 'live-system');
    const dirB = join(root, 'install-b', 'live-system');
    const { evidencePath } = buildDataDir(dirA);
    const shaBefore = createHash('sha256').update(readFileSync(evidencePath)).digest('hex');

    const summary = createLocalBackup({ dataDir: dirA, backupsRoot, label: '搬家测试' });

    // 目标目录已有另一份身份令牌，恢复后不得被覆盖
    mkdirSync(dirB, { recursive: true });
    writeFileSync(join(dirB, 'runtime-token'), 'local-token-must-survive');

    const result = restoreLocalBackup({ backupDir: summary.dir, dataDir: dirB, backupsRoot });
    // evidence.json 与 offers.json 各有一处证据路径指向旧安装目录，都会被重写
    assert.ok(result.rewrittenPaths >= 1);

    const registry = JSON.parse(readFileSync(join(dirB, 'evidence.json'), 'utf8')) as Record<string, { sourceUri: string; sha256: string }>;
    assert.ok(registry.e1!.sourceUri.startsWith(resolve(dirB)), `证据路径应重写到新安装目录，实际：${registry.e1!.sourceUri}`);
    assert.equal(registry.e1!.sha256, shaBefore);
    const restoredBytes = readFileSync(registry.e1!.sourceUri);
    assert.equal(createHash('sha256').update(restoredBytes).digest('hex'), shaBefore);
    assert.equal(readFileSync(join(dirB, 'runtime-token'), 'utf8'), 'local-token-must-survive');
    assert.equal(result.verifiedEvidenceFiles, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('backup: 恢复前自动生成安全备份，列表可读', async () => {
  const root = await mkdtemp(join(tmpdir(), 'live-backup-safety-'));
  try {
    const backupsRoot = join(root, 'backups');
    const dataDir = join(root, 'live-system');
    buildDataDir(dataDir);
    const summary = createLocalBackup({ dataDir, backupsRoot, label: '安全备份测试' });

    // 清空现场再恢复
    rmSync(join(dataDir, 'offers.json'));
    const result = restoreLocalBackup({ backupDir: summary.dir, dataDir, backupsRoot });
    assert.equal(result.restoredFiles, 9);

    const backups = listLocalBackups(backupsRoot);
    assert.equal(backups.length, 2); // 原始备份 + 恢复前自动安全备份
    const original = backups.find((item) => item.name === summary.name);
    assert.ok(original, '原始备份应仍在列表中');
    assert.equal(original!.fileCount, 9);
    // 恢复前 offers.json 已被删，因此安全备份只有 8 个文件，恰好证明它记录的是恢复前真实状态
    assert.ok(backups.some((item) => item.label.includes('自动安全备份') && item.fileCount === 8));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
