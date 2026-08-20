#!/usr/bin/env node
/**
 * 任务E·阶段3：生成离线授权密钥对（卖家专用，只跑一次）。
 * 用法：node scripts/license/generate-keypair.mjs [输出目录]
 * 产出：
 *   vendor-private.pem —— 私钥，卖家自留，严禁外泄/提交 git
 *   vendor-public.pem   —— 公钥，需内嵌到 packages/core/src/activation.ts 的 LICENSE_PUBLIC_KEY
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const outDir = resolve(process.argv[2] ?? join(import.meta.dirname, 'keys'));
mkdirSync(outDir, { recursive: true });

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

writeFileSync(join(outDir, 'vendor-public.pem'), publicPem, { encoding: 'utf8', mode: 0o644 });
writeFileSync(join(outDir, 'vendor-private.pem'), privatePem, { encoding: 'utf8', mode: 0o600 });

console.log(`✅ 密钥对已生成：${outDir}`);
console.log('');
console.log('=== 公钥（复制进 packages/core/src/activation.ts 的 LICENSE_PUBLIC_KEY）===');
console.log(publicPem);
console.log('=== 注意 ===');
console.log('- vendor-private.pem 是卖家私钥，必须妥善保管（生成激活码用），已 gitignore');
console.log('- 每次正式发布前如更换密钥对，老授权码将全部失效，请谨慎');
