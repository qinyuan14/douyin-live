import type { LiveSessionState } from '@liveops/live-contracts';

/**
 * 流程精简（批次1）：开播前不再要求逐步走 DRAFT→READY→LIVE，
 * 允许 DRAFT/PREFLIGHT_BLOCKED（legacy）直接转 LIVE；preflight 检查
 * 只在真正转 LIVE 时执行一次（service 层）。READY 保留仅为兼容旧会话。
 */
const LEGAL_TRANSITIONS: Record<LiveSessionState, LiveSessionState[]> = {
  DRAFT: ['LIVE', 'STOPPED'],
  PREFLIGHT_BLOCKED: ['LIVE', 'STOPPED'],
  READY: ['LIVE', 'STOPPED', 'PAUSED'],
  LIVE: ['PAUSED', 'STOPPED', 'COMPLETED'],
  PAUSED: ['LIVE', 'STOPPED'],
  STOPPED: [],
  COMPLETED: [],
};

/**
 * 校验场次状态机流转。非法变化抛出「非法场次状态变化」。
 * 同一状态（原地更新，如 PAUSED→PAUSED 的在场确认）视为合法无操作。
 */
export function assertTransition(from: LiveSessionState, to: LiveSessionState): void {
  if (from === to) return;
  const allowed = LEGAL_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new Error('非法场次状态变化');
  }
}
