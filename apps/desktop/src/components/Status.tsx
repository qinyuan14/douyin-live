import { CircleCheck, CircleDashed, CircleX, Hand, TriangleAlert } from 'lucide-react';
import type { PreflightCheck } from '@liveops/live-contracts';

export function CheckIcon({ status }: { status: PreflightCheck['status'] }) {
  if (status === 'PASS') return <CircleCheck className="status-icon pass" aria-hidden="true" />;
  if (status === 'BLOCKED') return <CircleX className="status-icon blocked" aria-hidden="true" />;
  return <Hand className="status-icon manual" aria-hidden="true" />;
}

export function StateBadge({ state }: { state: string }) {
  const map: Record<string, { label: string; icon: typeof CircleDashed; tone: string }> = {
    DRAFT: { label: '草稿', icon: CircleDashed, tone: 'neutral' },
    PREFLIGHT_BLOCKED: { label: '试播未解锁', icon: CircleX, tone: 'blocked' },
    READY: { label: '本地就绪', icon: CircleCheck, tone: 'pass' },
    LIVE: { label: '直播中', icon: CircleCheck, tone: 'live' },
    PAUSED: { label: 'AI已暂停', icon: TriangleAlert, tone: 'manual' },
    STOPPED: { label: '已停止', icon: CircleX, tone: 'neutral' },
    COMPLETED: { label: '已完成', icon: CircleCheck, tone: 'pass' },
  };
  const item = map[state] ?? map.DRAFT!;
  const Icon = item.icon;
  return <span className={`state-badge ${item.tone}`}><Icon aria-hidden="true" />{item.label}</span>;
}

