import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  deriveMachineId,
  parseLicenseCode,
  readActivation,
} from './activation.js';

// 用与客户端同款算法生成测试密钥对，验证签名/验签逻辑
// （生产私钥由 scripts/license/ 保管，不进仓库；此处仅验证算法链路）
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

function signLicense(machineId: string, expiresAt: number): string {
  const payload = `${machineId}|${expiresAt}`;
  const signature = sign(null, Buffer.from(payload, 'utf8'), PRIVATE_PEM).toString('base64url');
  return `v1.${machineId}.${expiresAt}.${signature}`;
}

/** 与 verifyLicenseCode 同逻辑，仅公钥不同（测试用临时公钥）。 */
function verifyWithKey(code: string, machineId: string): { ok: boolean; reason?: string } {
  const parsed = parseLicenseCode(code);
  if (!parsed) return { ok: false, reason: '格式错误' };
  if (parsed.machineId !== machineId) return { ok: false, reason: '机器码不匹配' };
  if (parsed.expiresAt <= Date.now()) return { ok: false, reason: '已过期' };
  const payload = `${parsed.machineId}|${parsed.expiresAt}`;
  const ok = verify(null, Buffer.from(payload, 'utf8'), PUBLIC_PEM, Buffer.from(parsed.signature, 'base64url'));
  return { ok, reason: ok ? undefined : '签名无效' };
}

test('activation: 合法授权码验签通过；篡改/过期/换机/格式错误全部拒绝', () => {
  const machineId = deriveMachineId();
  const future = Date.now() + 86_400_000;
  const good = signLicense(machineId, future);
  assert.equal(parseLicenseCode(good)?.machineId, machineId);
  assert.equal(verifyWithKey(good, machineId).ok, true);
  // 篡改机器码
  assert.equal(verifyWithKey(good.replace(machineId, 'a'.repeat(32)), machineId).ok, false);
  // 篡改签名
  assert.equal(verifyWithKey(`v1.${machineId}.${future}.AAAA`, machineId).ok, false);
  // 过期
  const past = signLicense(machineId, Date.now() - 1_000);
  assert.equal(verifyWithKey(past, machineId).ok, false);
  // 换机
  const otherMachine = 'f'.repeat(32);
  assert.equal(verifyWithKey(signLicense(otherMachine, future), machineId).ok, false);
  // 格式错误
  assert.equal(verifyWithKey('not-a-license', machineId).ok, false);
});

test('activation: 激活文件绑定机器码，篡改机器码后失效', () => {
  const machineId = deriveMachineId();
  const dir = mkdtempSync(join(tmpdir(), 'live-activation-'));
  try {
    const future = Date.now() + 86_400_000;
    const license = signLicense(machineId, future);
    // 模拟激活文件（真实写入由 activateWithCode 完成，依赖内嵌公钥；此处验证读取校验逻辑）
    writeFileSync(join(dir, 'activation.json'), JSON.stringify(
      { machineId, licenseCode: license, activatedAt: new Date().toISOString(), expiresAt: future }, null, 2,
    ));
    assert.equal(readActivation(dir, PUBLIC_PEM).activated, true);
    // 篡改机器码 → 失效
    writeFileSync(join(dir, 'activation.json'), JSON.stringify(
      { machineId: 'x'.repeat(32), licenseCode: license, activatedAt: new Date().toISOString(), expiresAt: future }, null, 2,
    ));
    assert.equal(readActivation(dir, PUBLIC_PEM).activated, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
