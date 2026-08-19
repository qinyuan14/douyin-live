import type { LiveSessionState } from '@mzg/live-contracts';

const LEGAL_TRANSITIONS: Record<LiveSessionState, LiveSessionState[]> = {
  DRAFT: ['READY', 'STOPPED'],
  PREFLIGHT_BLOCKED: ['READY', 'STOPPED'],
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
