#!/usr/bin/env node
/**
 * 实景直播经营系统 —— Windows 发布包构建脚本。
 *
 * 流程（任一前置失败即停止，不产出半成品）：
 *   1. 全量构建（contracts / core / api / desktop）
 *   2. 自动测试（API 15 项 + Desktop 3 项），--skip-tests 可跳过
 *   3. pnpm deploy（node-linker=hoisted 平铺）生成内置 API 运行时 → apps/desktop/build/api-runtime-hoisted
 *   4. 复制白名单知识证据 → apps/desktop/build/docs/
 *   5. electron-builder 产出 NSIS 安装包 + 便携版（release/ 目录）；afterPack 钩子负责把 node_modules 复制进包
 *
 * 环境说明：
 *   - 需要 Node >=24.16 与 pnpm 11.5.0（见 E:\抖音直播\工作交接.json environment）
 *   - 本机 pnpm store 位于 E:\.pnpm-store；如 pnpm 无法自动定位，
 *     可设 LIVE_PNPM_BIN=<pnpm.cjs 绝对路径> 与 npm_config_store_dir=<store 父目录>
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
const pnpmBin = process.env.LIVE_PNPM_BIN;

function run(command, args, options = {}) {
  console.log(`\n$ ${command} ${args.join(' ')}`);
  // Windows 下 execFileSync 需要 shell 才能解析 npx/pnpm 这类 .cmd 命令（PATHEXT 查找）；
  // shell 拼接模式下含空格的可执行路径（如 C:\Program Files\nodejs\node.exe）必须加引号
  const cmd = process.platform === 'win32' && /[ "]/.test(command) && !/^"/.test(command) ? `"${command}"` : command;
  execFileSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...options });
}

function pnpm(args, options = {}) {
  // pnpm run 会隐式做依赖自检 → 触发 install → 在无 TTY 环境（本机沙箱/CI）被中止
  // （ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY）。对 run 类调用显式绕过该自检。
  const fullArgs = args[0] === 'run' || args[0] === 'exec'
    ? ['--config.verify-deps-before-run=false', ...args]
    : args;
  if (pnpmBin) {
    run(process.execPath, [pnpmBin, ...fullArgs], options);
    return;
  }
  run('npx', ['-y', 'pnpm@11.5.0', ...fullArgs], options);
}

function step(title) {
  console.log(`\n${'='.repeat(68)}\n== ${title}\n${'='.repeat(68)}`);
}

step('1/5 全量构建（typecheck 前置已含在 build 中）');
pnpm(['run', 'build']);

if (!skipTests) {
  step('2/5 自动测试（API + Desktop）');
  pnpm(['--filter', '@liveops/live-api', 'test']);
  pnpm(['--filter', '@liveops/live-desktop', 'test']);
} else {
  console.log('已通过 --skip-tests 跳过自动测试（仅限演练用，正式发布不允许）');
}

step('3/5 生成内置 API 运行时（pnpm deploy，hoisted 平铺布局）');
// 只管理 api-runtime-hoisted 子目录（旧 api-runtime 是被取代的符号链接布局残留，
// 可能被资源管理器/搜索索引占用无法删除——但打包不需要它，跳过即可）
mkdirSync(buildDir, { recursive: true });
const hoistedDir = join(buildDir, 'api-runtime-hoisted');
if (existsSync(hoistedDir)) {
  const backup = `${hoistedDir}-bak-${Date.now()}`;
  renameSync(hoistedDir, backup);
  console.log(`旧 api-runtime-hoisted 已改名备份：${backup}`);
}
// node-linker=hoisted：产物为 npm 风格平铺目录（无符号链接），
// electron-builder 才能把 node_modules 打进包；否则符号链接不被跟随导致内置 API 缺失。
// 若某版本解析需要联网（store 缓存未覆盖），走国内镜像 registry.npmmirror.com。
pnpm([
  '--filter', '@liveops/live-api', 'deploy', join(buildDir, 'api-runtime-hoisted'),
  '--prod', '--legacy', '--config.node-linker=hoisted',
], { env: { ...process.env, npm_config_registry: 'https://registry.npmmirror.com' } });

step('4/5 复制白名单知识证据');
const docsTarget = join(buildDir, 'docs');
mkdirSync(docsTarget, { recursive: true });
copyFileSync(
  join(root, 'docs', 'APPROVED_LIVE_KNOWLEDGE.md'),
  join(docsTarget, 'APPROVED_LIVE_KNOWLEDGE.md'),
);

step('5/5 electron-builder 打包（NSIS + 便携版）');
if (existsSync(releaseDir)) {
  const backup = `${releaseDir}-bak-${Date.now()}`;
  renameSync(releaseDir, backup);
  console.log(`旧 release 目录已改名备份：${backup}`);
}
mkdirSync(releaseDir, { recursive: true });
const electronBuilder = join(root, 'node_modules', '.bin', 'electron-builder');
if (!existsSync(electronBuilder)) {
  throw new Error(`未找到 electron-builder（${electronBuilder}），请先安装：pnpm add -D -w electron-builder`);
}
run(electronBuilder, ['--win', '--config', join(desktopDir, 'electron-builder.yml')], { cwd: desktopDir });

console.log(`\n✅ 发布包已生成：${releaseDir}`);
console.log('   - NSIS 安装包（推荐正式安装）');
console.log('   - 便携版 exe（免安装，可直接双击运行验证）');
console.log('冒烟验证：LIVE_CAPTURE_DIR=<目录> 运行便携版，应用会自动截图两窗口并退出（exit 0 为通过）。');
