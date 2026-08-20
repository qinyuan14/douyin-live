// 临时工具：把 pnpm deploy 产物的符号链接 node_modules 解引用为真实文件
// 用法：node scripts/deref-api-runtime.mjs
import { cpSync, rmSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const staged = join(root, 'apps', 'desktop', 'build', 'api-runtime');
const deref = join(root, 'apps', 'desktop', 'build', 'api-runtime-real');

console.log(`staged=${staged}`);
rmSync(deref, { recursive: true, force: true });
console.log('开始复制并解引用...');
cpSync(staged, deref, { recursive: true, dereference: true });
console.log('复制完成，替换原目录...');
rmSync(staged, { recursive: true, force: true });
renameSync(deref, staged);
console.log('解引用完成');
