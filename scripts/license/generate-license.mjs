#!/usr/bin/env node
/**
 * 任务E·阶段3：生成离线激活码（卖家专用）。
 * 用法：node scripts/license/generate-license.mjs <机器码> [有效天数=3650]
 * 机器码由买家在客户端激活界面看到并发送给你；激活码绑定机器码，拷贝到别的机器无效。
 */
import { sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [, , machineId, daysArg] = process.argv;
const validDays = Number(daysArg ?? 3650);
if (!machineId || !/^[0-9a-f]{16,64}$/.test(machineId)) {
  console.error('用法：node scripts/license/generate-license.mjs <机器码> [有效天数]');
  console.error('机器码应为 16-64 位十六进制（客户端激活界面显示的内容）。');
  process.exit(1);
}
if (!Number.isFinite(validDays) || validDays <= 0 || validDays > 36500) {
  console.error('有效天数必须是 1-36500 之间的整数。');
  process.exit(1);
}

const privateKeyPath = join(import.meta.dirname, 'keys', 'vendor-private.pem');
let privatePem;
try {
  privatePem = readFileSync(privateKeyPath, 'utf8');
} catch {
  console.error(`找不到卖家私钥：${privateKeyPath}`);
  console.error('请先运行 node scripts/license/generate-keypair.mjs 生成密钥对。');
  process.exit(1);
}

const expiresAt = Date.now() + validDays * 86_400_000;
const payload = `${machineId}|${expiresAt}`;
const signature = sign(null, Buffer.from(payload, 'utf8'), privatePem).toString('base64url');
const license = `v1.${machineId}.${expiresAt}.${signature}`;

console.log(`✅ 已为机器码 ${machineId} 生成 ${validDays} 天激活码：`);
console.log('');
console.log(license);
console.log('');
console.log('发给买家，在客户端激活界面粘贴即可。');
