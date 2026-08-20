import { createHash, verify } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, hostname, networkInterfaces, totalmem } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * 任务E·阶段3：离线授权（绑机器码，防复制传播）。
 *
 * 授权码格式：v1.<机器码>.<过期时间戳ms>.<Ed25519签名 base64url>
 * 签名负载：`${machineId}|${expiresAtMs}`，用卖家私钥签发。
 * 客户端内嵌公钥验签；激活状态写入数据目录 activation.json。
 * 拷贝 activation.json 到别的机器 → 机器码不匹配 → 失效。
 */

// 由 scripts/license/generate-keypair.mjs 生成的公钥（正式发布前可重新生成并替换）
export const LICENSE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAUvQgfBUfis8LBL/aQ/J0aevY1AASbCKlsOhLY6hZ/IU=
-----END PUBLIC KEY-----`;

export const LICENSE_VERSION = 'v1';

export interface ActivationState {
  activated: boolean;
  machineId: string;
  licenseCode: string | null;
  expiresAt: number | null;
  reason: string | null;
}

export interface ActivationRecord {
  machineId: string;
  licenseCode: string;
  activatedAt: string;
  expiresAt: number;
}

/** 生成稳定的本机机器码（CPU 型号 + 物理 MAC + 主机名 + 内存，SHA-256 前 32 位）。 */
export function deriveMachineId(): string {
  const macs = Object.values(networkInterfaces())
    .flat()
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry && !entry.internal && entry.mac && entry.mac !== '00:00:00:00:00:00'))
    .map((entry) => entry.mac)
    .sort();
  const cpu = cpus()[0]?.model ?? 'unknown';
  const seed = [hostname(), macs.join(','), cpu, String(totalmem())].join('|');
  return createHash('sha256').update(seed).digest('hex').slice(0, 32);
}

export function parseLicenseCode(code: string): { machineId: string; expiresAt: number; signature: string } | null {
  const parts = code.trim().split('.');
  if (parts.length !== 4 || parts[0] !== LICENSE_VERSION) return null;
  const [, machineIdRaw, expiresAtRaw, signatureRaw] = parts;
  if (!machineIdRaw || !expiresAtRaw || !signatureRaw) return null;
  if (!/^[0-9a-f]{16,64}$/.test(machineIdRaw)) return null;
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(signatureRaw)) return null;
  return { machineId: machineIdRaw, expiresAt, signature: signatureRaw };
}

export function verifyLicenseCode(code: string, machineId: string, publicKey = LICENSE_PUBLIC_KEY): { ok: true; expiresAt: number } | { ok: false; reason: string } {
  const parsed = parseLicenseCode(code);
  if (!parsed) return { ok: false, reason: '授权码格式不正确' };
  if (parsed.machineId !== machineId) return { ok: false, reason: '授权码与本机不匹配（授权码绑定机器码，无法跨机使用）' };
  if (parsed.expiresAt <= Date.now()) return { ok: false, reason: '授权码已过期' };
  const payload = `${parsed.machineId}|${parsed.expiresAt}`;
  let valid: boolean;
  try {
    valid = verify(null, Buffer.from(payload, 'utf8'), publicKey, Buffer.from(parsed.signature, 'base64url'));
  } catch {
    return { ok: false, reason: '授权码签名校验失败' };
  }
  if (!valid) return { ok: false, reason: '授权码签名无效' };
  return { ok: true, expiresAt: parsed.expiresAt };
}

export function activationFilePath(dataDir: string): string {
  return join(dataDir, 'activation.json');
}

/** 读取激活状态（数据目录 live-system 下；打包版由主进程传入 LIVE_PROJECT_ROOT）。 */
export function readActivation(dataDir: string, publicKey = LICENSE_PUBLIC_KEY): ActivationState {
  const machineId = deriveMachineId();
  const path = activationFilePath(dataDir);
  if (!existsSync(path)) {
    return { activated: false, machineId, licenseCode: null, expiresAt: null, reason: '未激活，请输入授权码后使用全部功能' };
  }
  let record: ActivationRecord;
  try {
    record = JSON.parse(readFileSync(path, 'utf8')) as ActivationRecord;
  } catch {
    return { activated: false, machineId, licenseCode: null, expiresAt: null, reason: '激活文件已损坏，请重新激活' };
  }
  if (record.machineId !== machineId) {
    return { activated: false, machineId, licenseCode: null, expiresAt: null, reason: '激活状态与当前机器不匹配，请重新激活' };
  }
  const result = verifyLicenseCode(record.licenseCode, machineId, publicKey);
  if (!result.ok) {
    return { activated: false, machineId, licenseCode: null, expiresAt: null, reason: result.reason };
  }
  return { activated: true, machineId, licenseCode: record.licenseCode, expiresAt: record.expiresAt, reason: null };
}

/** 激活：校验通过后写激活文件。 */
export function activateWithCode(dataDir: string, code: string, publicKey = LICENSE_PUBLIC_KEY): ActivationState {
  const machineId = deriveMachineId();
  const result = verifyLicenseCode(code, machineId, publicKey);
  if (!result.ok) return { activated: false, machineId, licenseCode: null, expiresAt: null, reason: result.reason };
  mkdirSync(resolve(dataDir), { recursive: true });
  const record: ActivationRecord = {
    machineId,
    licenseCode: code.trim(),
    activatedAt: new Date().toISOString(),
    expiresAt: result.expiresAt,
  };
  writeFileSync(activationFilePath(dataDir), JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
  return { activated: true, machineId, licenseCode: record.licenseCode, expiresAt: record.expiresAt, reason: null };
}
