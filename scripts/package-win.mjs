#!/usr/bin/env node
/**
 * 猫掌柜直播经营系统 —— Windows 发布包构建脚本。
 *
 * 流程（任一前置失败即停止，不产出半成品）：
 *   1. 全量构建（contracts / core / api / desktop）
 *   2. 自动测试（API 15 项 + Desktop 3 项），--skip-tests 可跳过
 *   3. pnpm deploy 展平内置 API 运行时 → apps/desktop/build/api-runtime
 *   4. 复制白名单知识证据 → apps/desktop/build/docs/
 *   5. electron-builder 产出 NSIS 安装包 + 便携版（release/ 目录）
 *
 * 环境说明：
 *   - 需要 Node >=24.16 与 pnpm 11.5.0（见工作交接.md §3）
 *   - 本机 pnpm store 位于 E:\.pnpm-store；如 pnpm 无法自动定位，
 *     可设 MZG_PNPM_BIN=<pnpm.cjs 绝对路径> 与 npm_config_store_dir=<store 父目录>
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const desktopDir = join(root, 'apps', 'desktop');
const apiDir = join(root, 'apps', 'api');
const buildDir = join(desktopDir, 'build');
const releaseDir = join(root, 'release');
const skipTests = process.argv.includes('--skip-tests');
const pnpmBin = process.env.MZG_PNPM_BIN;

function run(command, args, options = {}) {
  console.log(`\n$ ${command} ${args.join(' ')}`);
  execFileSync(command, args, { stdio: 'inherit', ...options });
}

function pnpm(args, options = {}) {
  if (pnpmBin) {
    run(process.execPath, [pnpmBin, ...args], options);
    return;
  }
  run('npx', ['-y', 'pnpm@11.5.0', ...args], options);
}

function step(title) {
  console.log(`\n${'='.repeat(68)}\n== ${title}\n${'='.repeat(68)}`);
}

step('1/5 全量构建（typecheck 前置已含在 build 中）');
pnpm(['run', 'build']);

if (!skipTests) {
  step('2/5 自动测试（API + Desktop）');
  pnpm(['--filter', '@mzg/live-api', 'test']);
  pnpm(['--filter', '@mzg/live-desktop', 'test']);
} else {
  console.log('已通过 --skip-tests 跳过自动测试（仅限演练用，正式发布不允许）');
}

step('3/5 展平内置 API 运行时（pnpm deploy）');
rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });
pnpm(['--filter', '@mzg/live-api', 'deploy', join(buildDir, 'api-runtime'), '--prod', '--legacy']);

// pnpm deploy 产物的 node_modules 是指向全局 store 的符号链接/硬链接，
// electron-builder 打包 extraResources 时不会跟随，导致发布包缺 node_modules。
// 这里把整个目录解引用成真实文件，保证发布包自包含、可独立运行。
step('3b/5 解引用 api-runtime（符号链接 → 真实文件）');
const staged = join(buildDir, 'api-runtime');
const derefDir = join(buildDir, 'api-runtime-real');
rmSync(derefDir, { recursive: true, force: true });
mkdirSync(derefDir, { recursive: true });
cpSync(staged, derefDir, { recursive: true, dereference: true });
rmSync(staged, { recursive: true, force: true });
renameSync(derefDir, staged);
console.log(`  解引用完成：${staged}`);

step('4/5 复制白名单知识证据');
const docsTarget = join(buildDir, 'docs');
mkdirSync(docsTarget, { recursive: true });
copyFileSync(
  join(root, 'docs', 'APPROVED_LIVE_KNOWLEDGE.md'),
  join(docsTarget, 'APPROVED_LIVE_KNOWLEDGE.md'),
);

step('5/5 electron-builder 打包（NSIS + 便携版）');
rmSync(releaseDir, { recursive: true, force: true });
mkdirSync(releaseDir, { recursive: true });
const electronBuilder = join(root, 'node_modules', '.bin', 'electron-builder');
if (!existsSync(electronBuilder)) {
  throw new Error(`未找到 electron-builder（${electronBuilder}），请先安装：pnpm add -D -w electron-builder`);
}
run(electronBuilder, ['--win', '--config', join(desktopDir, 'electron-builder.yml')], { cwd: desktopDir });

console.log(`\n✅ 发布包已生成：${releaseDir}`);
console.log('   - NSIS 安装包（推荐正式安装）');
console.log('   - 便携版 exe（免安装，可直接双击运行验证）');
console.log('冒烟验证：MZG_CAPTURE_DIR=<目录> 运行便携版，应用会自动截图两窗口并退出（exit 0 为通过）。');
