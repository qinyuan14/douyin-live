import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const rounds = Number(process.env.LIVE_STRESS_ROUNDS ?? 5);
const holdSeconds = Number(process.env.LIVE_STRESS_HOLD_SECONDS ?? 7200);
const apiEntry = resolve('apps/api/dist/main.js');

for (let round = 1; round <= rounds; round += 1) {
  let occupied = false;
  try {
    occupied = (await fetch('http://127.0.0.1:3188/api/health')).ok;
  } catch { /* expected when the port is free */ }
  if (occupied) throw new Error('3188端口已有本地服务，压力测试已停止，避免误把其他进程当作本轮结果');

  const root = await mkdtemp(join(tmpdir(), `live-stress-${round}-`));
  const child = spawn(process.execPath, [apiEntry], {
    cwd: process.cwd(),
    env: { ...process.env, LIVE_PROJECT_ROOT: root },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  try {
    const deadline = Date.now() + 30_000;
    let healthy = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      try {
        const response = await fetch('http://127.0.0.1:3188/api/health');
        if (response.ok) { healthy = true; break; }
      } catch { /* wait for this round's local service */ }
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
    if (!healthy) throw new Error(`第${round}轮本地服务没有启动：${stderr}`);
    const token = (await readFile(join(root, '.data', 'live-system', 'runtime-token'), 'utf8')).trim();
    const holdUntil = Date.now() + holdSeconds * 1000;
    while (Date.now() < holdUntil) {
      if (child.exitCode !== null) throw new Error(`第${round}轮本地服务提前退出：${stderr}`);
      const response = await fetch('http://127.0.0.1:3188/api/bootstrap', { headers: { 'X-Live-Local-Token': token } });
      if (!response.ok) throw new Error(`第${round}轮健康巡检失败：${response.status}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(30_000, Math.max(1_000, holdUntil - Date.now()))));
    }
    process.stdout.write(`第${round}/${rounds}轮通过，持续${holdSeconds}秒\n`);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolveExit) => child.once('exit', resolveExit));
    }
    await rm(root, { recursive: true, force: true });
  }
}
