export type LiveMessage =
  | { type: 'speak'; text: string; source: 'AUTO' | 'OPERATOR'; mode: 'REHEARSAL' | 'LIVE'; id: string }
  | { type: 'caption'; text: string }
  | { type: 'scene'; scene: 'WORKBENCH' | 'PROCESS_CLOSEUP' | 'SERVICE_FACTS' | 'Q_AND_A' | 'OFFER' }
  | { type: 'state'; state: string; offerTitle: string | null; priceCents: number | null }
  | { type: 'presence'; acknowledgedAt: string }
  | { type: 'voice-test'; id: string }
  | { type: 'voice-test-result'; id: string; generated: boolean; voiceName: string | null }
  | { type: 'stop-speech'; reason: string };

export function createLiveChannel(): BroadcastChannel {
  return new BroadcastChannel('mzg-live-runtime-v1');
}
