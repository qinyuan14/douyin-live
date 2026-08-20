// electron-builder afterPack 钩子：把内置 API 的 node_modules 复制进发布包
// 背景：extraResources 的 filter 即使 "**/*" 也会过滤 node_modules，
// 因此打包完成后手动补齐。api-runtime 是 hoisted（平铺）布局，无符号链接，可安全复制。
// 注意：本文件必须在 apps/desktop 内（electron-builder 限制 hook 路径不能越出 workspace 根）。
import { cpSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export default async function afterPack(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  if (electronPlatformName !== 'win32') return;

  const src = join(packager.projectDir, 'build', 'api-runtime-hoisted', 'node_modules');
  const dest = join(appOutDir, 'resources', 'api-runtime', 'node_modules');

  if (!existsSync(src)) {
    console.error('[afterPack] 源 node_modules 不存在:', src);
    return;
  }
  if (existsSync(dest)) {
    console.log('[afterPack] node_modules 已存在，跳过:', dest);
    return;
  }
  cpSync(src, dest, { recursive: true, dereference: true });
  const count = readdirSync(dest).length;
  console.log(`[afterPack] 已复制 api-runtime node_modules（${count} 个顶层包） -> ${dest}`);
}
