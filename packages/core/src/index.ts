export { LiveDatabase, projectRoot } from './database.js';
export type { AuditEntry, EvidenceMeta } from './database.js';
export {
  BLOCKED_CLAIMS,
  EVIDENCE_REQUIRED_CLAIMS,
  SENSITIVE_INTENTS,
  findBlockedClaims,
  findSensitiveIntent,
  redactPersonalData,
  evaluateResponse,
} from './evaluation.js';
export type { EvaluateResponseInput } from './evaluation.js';
export { assertTransition } from './transition.js';
export { buildPreflightChecks } from './preflight.js';
export type { PreflightInput } from './preflight.js';
export { calculateCohortReport } from './cohort.js';
export type { CohortReportBase } from './cohort.js';
export { evidenceMatchesStoredFile } from './evidence.js';
export {
  BACKUP_KIND,
  MANAGED_JSON_FILES,
  createLocalBackup,
  defaultBackupsRoot,
  findRestoreBlockingState,
  inspectLocalBackup,
  isSafeBackupName,
  listLocalBackups,
  restoreLocalBackup,
} from './backup.js';
export type {
  BackupFileEntry,
  BackupIntegrity,
  BackupManifest,
  BackupSummary,
  RestoreResult,
} from './backup.js';

