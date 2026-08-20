import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { EvidenceRef } from '@liveops/live-contracts';

/**
 * 比对证据引用与本地已保全文件：文件存在、sha256 一致、且在有效期内。
 * 用于「显示层面」校验（数据库注册校验另由 allEvidenceIsRegistered 负责）。
 */
export function evidenceMatchesStoredFile(ref: EvidenceRef, now: Date = new Date()): boolean {
  if (!ref.sha256 || !ref.sourceUri) return false;
  try {
    const bytes = readFileSync(ref.sourceUri);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== ref.sha256) return false;
    if (new Date(ref.validUntil).getTime() <= now.getTime()) return false;
    return true;
  } catch {
    return false;
  }
}
