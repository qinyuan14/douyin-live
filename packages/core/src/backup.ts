import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * 本地数据备份与恢复。
 *
 * 设计原则与产品「风险兜底 / 证据保全」一致：
 * 1. 备份带全量 SHA256 清单，恢复前先整体校验，任一文件缺失或被改写即整体拒绝（fail-closed），
 *    绝不做部分恢复——半套数据比没有数据更危险。
 * 2. 恢复前自动对当前数据做一次安全备份，使「恢复」这个动作本身也可回滚。
 * 3. 直播中（LIVE / PAUSED）禁止恢复，不允许在播报进行时把数据从脚下换掉。
 * 4. 只接管 8 个业务 JSON 与 evidence/ 证据目录；runtime-token、pglite/ 等非业务文件一律不碰，
 *    避免恢复后本机身份令牌被覆盖导致整机不可用。
 * 5. 证据 sourceUri 在库中是绝对路径，跨安装目录恢复必须重写路径并重新核对 SHA256，
 *    否则恢复出来的证据全部校验失败、全盘阻断。
 */

/** 受备份/恢复接管的 8 个业务 JSON（不含扩展名）。 */
export const MANAGED_JSON_FILES = [
  'config',
  'offers',
  'knowledge',
  'sessions',
  'orders',
  'events',
  'audit',
  'evidence',
] as const;

/** 证据文件子目录名。 */
export const EVIDENCE_DIR_NAME = 'evidence';

/** 备份包类型标识，防止把无关目录当成备份恢复进来。 */
export const BACKUP_KIND = 'LIVE_LOCAL_BACKUP';

/** 备份包内数据子目录名。 */
const DATA_DIR_NAME = 'data';
const MANIFEST_NAME = 'manifest.json';
const MANIFEST_DIGEST_NAME = 'manifest.sha256';

/** 这两个状态代表 AI 播报正在进行或中途暂停，此时禁止恢复。 */
const RESTORE_BLOCKING_SESSION_STATES = new Set(['LIVE', 'PAUSED']);

/** 含 sourceUri 绝对路径、跨安装目录恢复时需要重写的 JSON。 */
const PATH_BEARING_JSON_FILES = ['evidence', 'knowledge', 'offers', 'orders'] as const;

export interface BackupFileEntry {
  /** 相对备份包 data/ 目录的路径，统一用 / 分隔。 */
  path: string;
  bytes: number;
  sha256: string;
}

export interface BackupManifest {
  schemaVersion: 1;
  kind: typeof BACKUP_KIND;
  product: string;
  createdAt: string;
  /** 备份时的数据目录绝对路径，恢复时据此重写证据路径。 */
  sourceDataDir: string;
  label: string;
  counts: Record<string, number>;
  files: BackupFileEntry[];
  /** 证据元数据里指向数据目录之外的条目：备份覆盖不到，必须让人知道。 */
  externalEvidenceIds: string[];
  notice: string;
}

export interface BackupSummary {
  name: string;
  dir: string;
  createdAt: string;
  label: string;
  bytes: number;
  fileCount: number;
  counts: Record<string, number>;
  externalEvidenceIds: string[];
}

export interface BackupIntegrity {
  ok: boolean;
  name: string;
  dir: string;
  manifest: BackupManifest | null;
  /** 清单里有、包里缺的文件。 */
  missing: string[];
  /** 存在但 SHA256 与清单不符的文件。 */
  mismatched: string[];
  /** 包里有、清单里没登记的文件。 */
  unlisted: string[];
  manifestDigestOk: boolean;
  problems: string[];
}

export interface RestoreResult {
  restoredFrom: string;
  dataDir: string;
  /** 恢复前自动生成的安全备份，可用于回退本次恢复。 */
  safetyBackupDir: string;
  restoredFiles: number;
  /** 被清理的、备份中不存在的残留证据文件数（已收入安全备份）。 */
  removedStaleEvidenceFiles: number;
  /** 因换安装目录而重写的证据路径数量。 */
  rewrittenPaths: number;
  verifiedEvidenceFiles: number;
  externalEvidenceIds: string[];
  warnings: string[];
}

function sha256OfBuffer(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha256OfFile(path: string): string {
  return sha256OfBuffer(readFileSync(path));
}

/** 备份根目录默认与数据目录同级（.data/backups），避免备份被自己递归收进去。 */
export function defaultBackupsRoot(dataDir: string): string {
  return resolve(dataDir, '..', 'backups');
}

/** 只允许纯目录名，挡掉路径穿越。 */
export function isSafeBackupName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && name !== '.' && name !== '..';
}

function listEvidenceFiles(evidenceDir: string): string[] {
  if (!existsSync(evidenceDir)) return [];
  return readdirSync(evidenceDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function countOf(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  return 0;
}

/** Windows 路径大小写不敏感，比较前缀时要按平台处理。 */
function samePathPrefix(value: string, prefix: string): boolean {
  const normalizedValue = value.replace(/\\/g, '/');
  const normalizedPrefix = prefix.replace(/\\/g, '/');
  if (process.platform === 'win32') {
    return normalizedValue.toLowerCase().startsWith(normalizedPrefix.toLowerCase());
  }
  return normalizedValue.startsWith(normalizedPrefix);
}

/** 判断两个路径是否指向同一目录（Windows 下忽略大小写）。 */
function samePath(left: string, right: string): boolean {
  const a = resolve(left).replace(/\\/g, '/');
  const b = resolve(right).replace(/\\/g, '/');
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function rewritePathPrefix(value: string, oldDir: string, newDir: string): string {
  if (!samePathPrefix(value, oldDir)) return value;
  const rest = value.replace(/\\/g, '/').slice(oldDir.replace(/\\/g, '/').length).replace(/^\/+/, '');
  return rest ? resolve(newDir, rest) : resolve(newDir);
}

/** 只重写 sourceUri 字段，避免误伤其他文本内容。 */
function rewriteSourceUris(node: unknown, oldDir: string, newDir: string, counter: { count: number }): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => rewriteSourceUris(item, oldDir, newDir, counter));
  }
  if (node && typeof node === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'sourceUri' && typeof value === 'string') {
        const next = rewritePathPrefix(value, oldDir, newDir);
        if (next !== value) counter.count += 1;
        result[key] = next;
        continue;
      }
      result[key] = rewriteSourceUris(value, oldDir, newDir, counter);
    }
    return result;
  }
  return node;
}

interface EvidenceMetaLike {
  sha256?: unknown;
  sourceUri?: unknown;
  originalName?: unknown;
}

function readEvidenceRegistry(dataDir: string): Record<string, EvidenceMetaLike> {
  return readJsonFile<Record<string, EvidenceMetaLike>>(join(dataDir, 'evidence.json'), {});
}

/** 找出证据元数据里指向数据目录之外的条目——备份覆盖不到它们。 */
function findExternalEvidenceIds(dataDir: string): string[] {
  const registry = readEvidenceRegistry(dataDir);
  return Object.entries(registry)
    .filter(([, meta]) => typeof meta?.sourceUri === 'string' && !samePathPrefix(meta.sourceUri, dataDir))
    .map(([id]) => id)
    .sort();
}

function readSessionStates(dataDir: string): string[] {
  const sessions = readJsonFile<Array<{ state?: unknown }>>(join(dataDir, 'sessions.json'), []);
  return sessions.map((session) => (typeof session?.state === 'string' ? session.state : '')).filter(Boolean);
}

/**
 * 当前数据是否处于「不可恢复」状态。
 * 守卫放在 core 而不是只放在 service，是为了让这条安全规则和操作本身绑定，绕不过去。
 */
export function findRestoreBlockingState(dataDir: string): string | null {
  return readSessionStates(dataDir).find((state) => RESTORE_BLOCKING_SESSION_STATES.has(state)) ?? null;
}

export interface CreateBackupOptions {
  dataDir: string;
  backupsRoot?: string;
  label?: string;
  now?: Date;
}

/** 生成 backup-20260820-001732-<短id> 形式的目录名，可读且可排序。 */
function backupDirName(now: Date, label: string): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const suffix = sha256OfBuffer(Buffer.from(`${now.toISOString()}${label}${Math.random()}`)).slice(0, 6);
  return `backup-${stamp}-${suffix}`;
}

/**
 * 备份 8 个业务 JSON 与 evidence/ 目录，产出带 SHA256 清单的备份包。
 * 清单本身再写一份摘要文件，便于发现清单被意外损坏。
 */
export function createLocalBackup(options: CreateBackupOptions): BackupSummary {
  const dataDir = resolve(options.dataDir);
  if (!existsSync(dataDir)) throw new Error(`数据目录不存在，无法备份：${dataDir}`);
  const backupsRoot = resolve(options.backupsRoot ?? defaultBackupsRoot(dataDir));
  const now = options.now ?? new Date();
  const label = options.label ?? '手动备份';
  const name = backupDirName(now, label);
  const backupDir = join(backupsRoot, name);
  const dataTarget = join(backupDir, DATA_DIR_NAME);
  mkdirSync(dataTarget, { recursive: true });

  const files: BackupFileEntry[] = [];
  const counts: Record<string, number> = {};

  for (const jsonName of MANAGED_JSON_FILES) {
    const source = join(dataDir, `${jsonName}.json`);
    if (!existsSync(source)) {
      counts[jsonName] = 0;
      continue;
    }
    const bytes = readFileSync(source);
    const target = join(dataTarget, `${jsonName}.json`);
    writeFileSync(target, bytes);
    files.push({ path: `${jsonName}.json`, bytes: bytes.byteLength, sha256: sha256OfBuffer(bytes) });
    counts[jsonName] = countOf(readJsonFile<unknown>(source, null));
  }

  const evidenceDir = join(dataDir, EVIDENCE_DIR_NAME);
  const evidenceNames = listEvidenceFiles(evidenceDir);
  if (evidenceNames.length > 0) {
    mkdirSync(join(dataTarget, EVIDENCE_DIR_NAME), { recursive: true });
  }
  for (const fileName of evidenceNames) {
    const source = join(evidenceDir, fileName);
    const target = join(dataTarget, EVIDENCE_DIR_NAME, fileName);
    copyFileSync(source, target);
    const stats = statSync(target);
    files.push({
      path: `${EVIDENCE_DIR_NAME}/${fileName}`,
      bytes: stats.size,
      sha256: sha256OfFile(target),
    });
  }
  counts.evidenceFiles = evidenceNames.length;

  const manifest: BackupManifest = {
    schemaVersion: 1,
    kind: BACKUP_KIND,
    product: '实景直播经营系统',
    createdAt: now.toISOString(),
    sourceDataDir: dataDir,
    label,
    counts,
    files,
    externalEvidenceIds: findExternalEvidenceIds(dataDir),
    notice: '本备份仅为本地经营数据与已保全证据的副本，不代表已商用、已获授权或可对外收费。',
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  writeFileSync(join(backupDir, MANIFEST_NAME), manifestBytes);
  writeFileSync(join(backupDir, MANIFEST_DIGEST_NAME), `${sha256OfBuffer(manifestBytes)}\n`, 'utf8');

  return {
    name,
    dir: backupDir,
    createdAt: manifest.createdAt,
    label,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    fileCount: files.length,
    counts,
    externalEvidenceIds: manifest.externalEvidenceIds,
  };
}

function parseManifest(backupDir: string): { manifest: BackupManifest | null; digestOk: boolean; problems: string[] } {
  const manifestPath = join(backupDir, MANIFEST_NAME);
  const problems: string[] = [];
  if (!existsSync(manifestPath)) {
    return { manifest: null, digestOk: false, problems: ['备份包缺少 manifest.json，不是有效备份'] };
  }
  const bytes = readFileSync(manifestPath);
  const digestPath = join(backupDir, MANIFEST_DIGEST_NAME);
  let digestOk = false;
  if (existsSync(digestPath)) {
    digestOk = readFileSync(digestPath, 'utf8').trim() === sha256OfBuffer(bytes);
    if (!digestOk) problems.push('manifest.json 与其摘要文件不一致，清单可能已损坏或被改写');
  } else {
    problems.push('备份包缺少 manifest.sha256 摘要文件，无法确认清单未被改写');
  }
  let manifest: BackupManifest | null = null;
  try {
    manifest = JSON.parse(bytes.toString('utf8')) as BackupManifest;
  } catch {
    problems.push('manifest.json 无法解析');
    return { manifest: null, digestOk, problems };
  }
  if (manifest.kind !== BACKUP_KIND) {
    problems.push('备份包类型标识不符，拒绝识别为本系统备份');
    return { manifest: null, digestOk, problems };
  }
  if (!Array.isArray(manifest.files)) {
    problems.push('manifest.json 缺少文件清单');
    return { manifest: null, digestOk, problems };
  }
  return { manifest, digestOk, problems };
}

/** 只读校验一个备份包，不做任何写入。 */
export function inspectLocalBackup(backupDir: string): BackupIntegrity {
  const dir = resolve(backupDir);
  const name = dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;
  const { manifest, digestOk, problems } = parseManifest(dir);
  if (!manifest) {
    return { ok: false, name, dir, manifest: null, missing: [], mismatched: [], unlisted: [], manifestDigestOk: digestOk, problems };
  }

  const dataDir = join(dir, DATA_DIR_NAME);
  const missing: string[] = [];
  const mismatched: string[] = [];
  for (const entry of manifest.files) {
    const path = join(dataDir, entry.path);
    if (!existsSync(path)) {
      missing.push(entry.path);
      continue;
    }
    if (sha256OfFile(path) !== entry.sha256) mismatched.push(entry.path);
  }

  const listed = new Set(manifest.files.map((entry) => entry.path));
  const unlisted: string[] = [];
  if (existsSync(dataDir)) {
    for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
      if (entry.isFile() && !listed.has(entry.name)) unlisted.push(entry.name);
    }
    for (const fileName of listEvidenceFiles(join(dataDir, EVIDENCE_DIR_NAME))) {
      const relativePath = `${EVIDENCE_DIR_NAME}/${fileName}`;
      if (!listed.has(relativePath)) unlisted.push(relativePath);
    }
  }

  const allProblems = [...problems];
  if (missing.length > 0) allProblems.push(`备份缺少 ${missing.length} 个已登记文件`);
  if (mismatched.length > 0) allProblems.push(`备份中有 ${mismatched.length} 个文件的 SHA256 与清单不符`);
  if (unlisted.length > 0) allProblems.push(`备份中有 ${unlisted.length} 个未登记文件`);

  return {
    ok: allProblems.length === 0,
    name,
    dir,
    manifest,
    missing,
    mismatched,
    unlisted,
    manifestDigestOk: digestOk,
    problems: allProblems,
  };
}

/** 列出备份根目录下所有备份包（只读清单，不做全量校验）。 */
export function listLocalBackups(backupsRoot: string): BackupSummary[] {
  const root = resolve(backupsRoot);
  if (!existsSync(root)) return [];
  const summaries: BackupSummary[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const { manifest } = parseManifest(join(root, entry.name));
    if (!manifest) continue;
    summaries.push({
      name: entry.name,
      dir: join(root, entry.name),
      createdAt: manifest.createdAt,
      label: manifest.label,
      bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0),
      fileCount: manifest.files.length,
      counts: manifest.counts,
      externalEvidenceIds: manifest.externalEvidenceIds ?? [],
    });
  }
  return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function writeManagedFilesFrom(sourceDataDir: string, targetDataDir: string): number {
  let written = 0;
  for (const jsonName of MANAGED_JSON_FILES) {
    const source = join(sourceDataDir, `${jsonName}.json`);
    if (!existsSync(source)) continue;
    const target = join(targetDataDir, `${jsonName}.json`);
    const temporary = `${target}.restore-tmp`;
    writeFileSync(temporary, readFileSync(source));
    renameSync(temporary, target);
    written += 1;
  }
  const sourceEvidence = join(sourceDataDir, EVIDENCE_DIR_NAME);
  const targetEvidence = join(targetDataDir, EVIDENCE_DIR_NAME);
  const names = listEvidenceFiles(sourceEvidence);
  if (names.length > 0) mkdirSync(targetEvidence, { recursive: true });
  for (const fileName of names) {
    const temporary = join(targetEvidence, `${fileName}.restore-tmp`);
    copyFileSync(join(sourceEvidence, fileName), temporary);
    renameSync(temporary, join(targetEvidence, fileName));
    written += 1;
  }
  return written;
}

export interface RestoreBackupOptions {
  backupDir: string;
  dataDir: string;
  backupsRoot?: string;
  now?: Date;
}

/**
 * 从备份恢复本地数据。
 *
 * 顺序刻意如此：先整体校验 → 再查开播状态 → 再做安全备份 → 才动真实数据；
 * 任何一步失败都不留下半套数据。
 */
export function restoreLocalBackup(options: RestoreBackupOptions): RestoreResult {
  const backupDir = resolve(options.backupDir);
  const dataDir = resolve(options.dataDir);
  const backupsRoot = resolve(options.backupsRoot ?? defaultBackupsRoot(dataDir));
  const now = options.now ?? new Date();

  const integrity = inspectLocalBackup(backupDir);
  if (!integrity.ok || !integrity.manifest) {
    throw new Error(`备份完整性校验未通过，已拒绝恢复：${integrity.problems.join('；') || '未知原因'}`);
  }

  const blockingState = findRestoreBlockingState(dataDir);
  if (blockingState) {
    throw new Error(`当前场次状态为 ${blockingState}，直播进行或中途暂停时禁止恢复数据，请先安全结束场次`);
  }

  mkdirSync(dataDir, { recursive: true });
  const safety = createLocalBackup({
    dataDir,
    backupsRoot,
    label: `恢复前自动安全备份（来源 ${integrity.name}）`,
    now,
  });

  const backupDataDir = join(backupDir, DATA_DIR_NAME);
  const warnings: string[] = [];
  let restoredFiles = 0;
  let removedStaleEvidenceFiles = 0;
  let rewrittenPaths = 0;

  try {
    restoredFiles = writeManagedFilesFrom(backupDataDir, dataDir);

    // 清理备份中不存在的残留证据文件：它们已收进上一步的安全备份，可回退。
    const keep = new Set(listEvidenceFiles(join(backupDataDir, EVIDENCE_DIR_NAME)));
    const evidenceDir = join(dataDir, EVIDENCE_DIR_NAME);
    for (const fileName of listEvidenceFiles(evidenceDir)) {
      if (keep.has(fileName)) continue;
      rmSync(join(evidenceDir, fileName), { force: true });
      removedStaleEvidenceFiles += 1;
    }

    // 跨安装目录恢复：把证据绝对路径从备份时的数据目录重写到当前数据目录。
    if (!samePath(dataDir, integrity.manifest.sourceDataDir)) {
      const counter = { count: 0 };
      for (const jsonName of PATH_BEARING_JSON_FILES) {
        const path = join(dataDir, `${jsonName}.json`);
        if (!existsSync(path)) continue;
        const parsed = readJsonFile<unknown>(path, null);
        if (parsed === null) continue;
        const rewritten = rewriteSourceUris(parsed, integrity.manifest.sourceDataDir, dataDir, counter);
        writeFileSync(path, JSON.stringify(rewritten, null, 2));
      }
      rewrittenPaths = counter.count;
    }

    // 语义校验：恢复出来的证据文件必须与元数据 SHA256 一致，否则这份证据没有保全价值。
    const registry = readEvidenceRegistry(dataDir);
    let verifiedEvidenceFiles = 0;
    const brokenEvidence: string[] = [];
    const externalEvidenceIds: string[] = [];
    for (const [id, meta] of Object.entries(registry)) {
      const sourceUri = typeof meta?.sourceUri === 'string' ? meta.sourceUri : null;
      const expected = typeof meta?.sha256 === 'string' ? meta.sha256 : null;
      if (!sourceUri || !expected) {
        brokenEvidence.push(`${id}（元数据缺少路径或指纹）`);
        continue;
      }
      if (!samePathPrefix(sourceUri, dataDir)) {
        externalEvidenceIds.push(id);
        continue;
      }
      if (!existsSync(sourceUri)) {
        brokenEvidence.push(`${id}（文件缺失）`);
        continue;
      }
      if (sha256OfFile(sourceUri) !== expected) {
        brokenEvidence.push(`${id}（指纹不符）`);
        continue;
      }
      verifiedEvidenceFiles += 1;
    }
    if (brokenEvidence.length > 0) {
      throw new Error(`恢复后证据校验失败：${brokenEvidence.join('、')}`);
    }
    if (externalEvidenceIds.length > 0) {
      warnings.push(`有 ${externalEvidenceIds.length} 条证据指向数据目录之外，备份不覆盖这些文件，需人工确认它们仍然存在且未被改写`);
    }

    return {
      restoredFrom: backupDir,
      dataDir,
      safetyBackupDir: safety.dir,
      restoredFiles,
      removedStaleEvidenceFiles,
      rewrittenPaths,
      verifiedEvidenceFiles,
      externalEvidenceIds,
      warnings,
    };
  } catch (error) {
    // 回滚：把恢复前的安全备份写回去，绝不留下半套数据。
    const rollbackSource = join(safety.dir, DATA_DIR_NAME);
    let rollbackNote = '已回滚到恢复前状态';
    try {
      const evidenceDir = join(dataDir, EVIDENCE_DIR_NAME);
      const keep = new Set(listEvidenceFiles(join(rollbackSource, EVIDENCE_DIR_NAME)));
      for (const fileName of listEvidenceFiles(evidenceDir)) {
        if (!keep.has(fileName)) rmSync(join(evidenceDir, fileName), { force: true });
      }
      writeManagedFilesFrom(rollbackSource, dataDir);
    } catch (rollbackError) {
      const detail = rollbackError instanceof Error ? rollbackError.message : '未知错误';
      rollbackNote = `自动回滚同时失败（${detail}），请手动从安全备份恢复：${safety.dir}`;
    }
    const message = error instanceof Error ? error.message : '未知恢复错误';
    throw new Error(`${message}；${rollbackNote}（安全备份：${safety.dir}）`);
  }
}
