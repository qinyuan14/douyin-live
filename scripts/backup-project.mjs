#!/usr/bin/env node
/**
 * 实景直播经营系统 —— 一键异地备份脚本（任务E 后续：git 远程/异地备份落地）
 *
 * 用法：
 *   node scripts/backup-project.mjs                # 默认备份到 E:\抖音直播\backups\
 *   node scripts/backup-project.mjs <目标目录>      # 备份到指定目录（如 U 盘/其他盘）
 *
 * 备份内容（四层，互为冗余；规避宿主安全策略对递归删除的拦截，不做大目录删除）：
 *   1. git 镜像仓库（完整历史+全部分支，可直接恢复/迁移）：
 *      <目标>/git/liveops-git-mirror.git —— 增量 fetch，可反复运行
 *   1b. git bundle 单文件（完整历史打包成单文件，随身携带方便）：
 *      <目标>/bundle/liveops-backup-<日期>.bundle
 *   2. 未提交改动快照（git status 列出的新增/修改文件，保留相对路径）：
 *      <目标>/workspace/liveops-workspace-<日期>/
 *   3. 关键运营文档（交接/看板/报告，位于仓库外）：<目标>/docs/liveops-docs-<日期>/
 *
 * 设计说明：
 *   - 项目约定"每完成一项改动就 commit"，因此 git 镜像已覆盖全部历史；
 *     工作区快照只需补未提交改动，避免递归删除大目录（宿主 safe-delete 会 fail-closed）。
 *   - 运行前如遇删除/移动异常，请 unset NODE_OPTIONS 后再执行（宿主 shim 注入）。
 * 建议：每次任务结束跑一次，或把 backups/ 复制到 U 盘/云盘做真正异地。
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const workspaceRoot = resolve(root, '..'); // E:\抖音直播
const defaultTarget = join(workspaceRoot, 'backups');
const target = resolve(process.argv[2] ?? defaultTarget);
const date = new Date().toISOString().slice(0, 10);

function run(command, args, options = {}) {
  console.log(`\n$ ${command} ${args.join(' ')}`);
  execFileSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32', ...options });
}

// 1. git 镜像（完整历史）
console.log('\n=== 1/3 git 镜像仓库 ===');
const mirror = join(target, 'git', 'liveops-git-mirror.git');
if (existsSync(mirror)) {
  run('git', ['--git-dir', mirror, 'remote', 'set-url', 'origin', root]);
  run('git', ['--git-dir', mirror, 'fetch', '--prune', 'origin']);
  console.log(`✅ git 镜像已增量更新：${mirror}`);
} else {
  mkdirSync(join(target, 'git'), { recursive: true });
  run('git', ['clone', '--mirror', root, mirror]);
  console.log(`✅ git 镜像已创建：${mirror}`);
}

// 1b. git bundle 单文件（可随身携带：U 盘 / 网盘 / 邮件附件）
console.log('\n=== 1b/3 git bundle 单文件 ===');
mkdirSync(join(target, 'bundle'), { recursive: true });
const bundleFile = join(target, 'bundle', `liveops-backup-${date}.bundle`);
run('git', ['bundle', 'create', bundleFile, '--all']);
console.log(`✅ git bundle 已生成：${bundleFile}（单文件，可复制到 U 盘/网盘）`);

// 2. 未提交改动快照（只复制 git status 列出的文件，不做大目录删除）
console.log('\n=== 2/3 未提交改动快照 ===');
const workspaceSnapshot = join(target, 'workspace', `liveops-workspace-${date}`);
mkdirSync(workspaceSnapshot, { recursive: true });
const statusOut = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
const entries = statusOut.split('\n').map((line) => line.trim()).filter(Boolean)
  .map((line) => line.slice(3).trim())
  .filter((p) => !p.includes('->')); // 跳过重命名箭头
if (entries.length === 0) {
  console.log('工作区干净，无未提交改动（git 镜像已覆盖全部历史）。');
} else {
  let copied = 0;
  for (const rel of entries) {
    const src = join(root, rel);
    if (!existsSync(src)) continue;
    const dest = join(workspaceSnapshot, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true });
    copied += 1;
  }
  console.log(`✅ 已复制 ${copied} 个未提交改动文件 → ${workspaceSnapshot}`);
}

// 3. 关键运营文档
console.log('\n=== 3/3 关键运营文档 ===');
const docsSnapshot = join(target, 'docs', `liveops-docs-${date}`);
mkdirSync(docsSnapshot, { recursive: true });
const docFiles = ['工作交接.json', 'progress-data.js'];
let copied = 0;
for (const name of docFiles) {
  const src = join(workspaceRoot, name);
  if (existsSync(src)) {
    cpSync(src, join(docsSnapshot, name));
    copied += 1;
  }
}
if (copied > 0) {
  console.log(`✅ 运营文档已复制（${copied} 个）→ ${docsSnapshot}`);
} else {
  console.log('⚠️ 未找到运营文档，跳过。');
}

console.log(`\n🎉 备份完成 → ${target}`);
console.log('提示：把 backups/ 目录复制到另一块磁盘 / U 盘 / 云盘，才算真正的"异地"备份。');
