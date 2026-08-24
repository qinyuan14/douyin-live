import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import {
  KnowledgeItemSchema,
  OfferSnapshotSchema,
  OrderOutcomeSchema,
  type LiveSession,
  type LiveSessionState,
  type RuntimeEvent,
} from '@liveops/live-contracts';
import {
  LiveDatabase,
  activateWithCode,
  assertTransition,
  buildPreflightChecks,
  calculateCohortReport,
  createLocalBackup,
  defaultBackupsRoot,
  evidenceMatchesStoredFile,
  evaluateResponse,
  inspectLocalBackup,
  isSafeBackupName,
  listLocalBackups,
  readActivation,
  redactPersonalData,
  restoreLocalBackup,
} from '@liveops/live-core';
import type { BackupIntegrity, BackupSummary, RestoreResult } from '@liveops/live-contracts';
import { buildRunSheet } from './run-sheet.js';

/** v16.1：经典音色 → 豆包大模型音色 映射（经典接口遇授权类错误时自动换大模型接口重试） */
const MEGA_VOICE_FALLBACK: Record<string, string> = {
  BV700_streaming: 'zh_female_cancan_moon_bigtts',
  BV701_streaming: 'zh_male_yunyang_moon_bigtts',
};

const APPROVED_KNOWLEDGE_EVIDENCE_ID = '00000000-0000-4000-8000-000000000014';
const APPROVED_KNOWLEDGE_DEFINITIONS = [
  {
    id: '00000000-0000-4000-8000-000000000101', intent: 'service-scope', label: '服务范围', risk: 'LOW' as const, decision: 'AUTO_ALLOWED' as const,
    answer: '我们提供常规的线下服务，具体服务内容、流程和适用条件以直播间当前有效商品说明为准。',
  },
  {
    id: '00000000-0000-4000-8000-000000000102', intent: 'eligibility', label: '哪些情况可承接', risk: 'HIGH' as const, decision: 'OPERATOR_REQUIRED' as const,
    answer: '常规情形按有效商品说明承接；特殊情形和高风险需求需要先由员工现场评估。',
  },
  {
    id: '00000000-0000-4000-8000-000000000103', intent: 'turnaround', label: '多久完成', risk: 'MEDIUM' as const, decision: 'AUTO_ALLOWED' as const,
    answer: '常规服务在实际接收后，完成时间是合理的目标范围而不是绝对承诺；如果出现真实异常，我们会主动联系说明。',
  },
  {
    id: '00000000-0000-4000-8000-000000000104', intent: 'refund', label: '退款问题', risk: 'HIGH' as const, decision: 'OPERATOR_REQUIRED' as const,
    answer: '退款需要结合订单实际状态和履约记录，由员工核实后答复。',
  },
  {
    id: '00000000-0000-4000-8000-000000000105', intent: 'special-case', label: '特殊情形', risk: 'HIGH' as const, decision: 'OPERATOR_REQUIRED' as const,
    answer: '特殊情形和高风险需求需要员工现场评估并与顾客确认后才能承接。',
  },
  {
    id: '00000000-0000-4000-8000-000000000106', intent: 'complaint', label: '投诉赔偿', risk: 'HIGH' as const, decision: 'OPERATOR_REQUIRED' as const,
    answer: '投诉和赔偿由员工根据订单、现场记录和真实履约情况核实处理。',
  },
] as const;
const APPROVED_KNOWLEDGE_IDS = new Set<string>(APPROVED_KNOWLEDGE_DEFINITIONS.map((item) => item.id));

@Injectable()
export class LiveService implements OnModuleInit, OnModuleDestroy {
  private database!: LiveDatabase;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatRunning = false;
  private runtimeUnsafeReason: string | null = null;
  private readonly hardware = {
    cameraReady: false,
    cameraDeviceId: null as string | null,
    cameraLabel: null as string | null,
    cameraStreamActive: false,
    cameraFramingConfirmed: false,
    voiceReady: false,
    takeoverReady: false,
  };

  async onModuleInit(): Promise<void> {
    this.database = await LiveDatabase.open();
    await this.seedKnowledge().catch((error: unknown) => console.error('直播白名单知识保持阻断：本地证据无法建立', error));
    this.heartbeatTimer = setInterval(() => void this.triggerSafetyHeartbeat(), 30_000);
    this.heartbeatTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await this.database.close();
  }

  health() {
    return {
      ok: true,
      product: '实景直播经营系统',
      status: 'LOCAL_COMMERCIAL_CANDIDATE',
      platformAdapter: 'MANUAL',
      now: new Date().toISOString(),
    };
  }

  async bootstrap() {
    const [config, offers, knowledge, session, sessions, orders, report, preflight] = await Promise.all([
      this.getConfig(),
      this.listOffers(),
      this.listKnowledge(),
      this.latestSession(),
      this.database.listSessions(),
      this.listOrders(),
      this.cohortReport(),
      this.preflight(),
    ]);
    // v2：监护确认落盘恢复——重启后从配置恢复三项确认（不再每次开播重勾）
    if (config.hardwareConfirmed && !(this.hardware.cameraFramingConfirmed && this.hardware.voiceReady && this.hardware.takeoverReady)) {
      this.hardware.cameraFramingConfirmed = true;
      this.hardware.voiceReady = true;
      this.hardware.takeoverReady = true;
    }
    // v8.1 起商品快照以自查确认为准（evidenceRefs 可为空）；仅对仍携带文件证据的
    // 旧快照校验证据是否失效（文件缺失/未注册则过期），自查模式快照不受影响。
    const visibleOffers = await Promise.all(offers.map(async (offer) => (
      offer.status === 'ACTIVE'
      && offer.evidenceRefs.length > 0
      && (!offer.evidenceRefs.every((evidence) => evidenceMatchesStoredFile(evidence))
        || !await this.database.allEvidenceIsRegistered(offer.evidenceRefs))
        ? { ...offer, status: 'EXPIRED' as const }
        : offer
    )));
    // v9.1：自查模式快照（evidenceRefs 为空）直接展示；多条有效记录取 validUntil 最新
    const validOffers = visibleOffers.filter((offer) => offer.status === 'ACTIVE' && new Date(offer.validUntil).getTime() > Date.now());
    const activeOffer = validOffers.length === 0
      ? null
      : [...validOffers].sort((a, b) => new Date(b.validUntil).getTime() - new Date(a.validUntil).getTime())[0] ?? null;
    return {
      config,
      offers: visibleOffers,
      knowledge,
      session: session && this.runtimeUnsafeReason && session.state === 'LIVE'
        ? { ...session, state: 'PAUSED' as const, stopReason: this.runtimeUnsafeReason }
        : session,
      sessions,
      orders,
      report,
      preflight,
      runSheet: buildRunSheet(await this.verifiedApprovedKnowledge(knowledge), activeOffer, new Date(), () => true, config),
      hardware: this.hardware,
      runtimeUnsafeReason: this.runtimeUnsafeReason,
      activation: readActivation(this.database.dataDir),
    };
  }

  getActivation() {
    return readActivation(this.database.dataDir);
  }

  activate(code: string) {
    return activateWithCode(this.database.dataDir, code);
  }

  getConfig() {
    return this.database.getStoreConfig();
  }

  updateConfig(input: unknown) {
    return this.database.updateStoreConfig(input);
  }

  /**
   * v13.1：语音合成代理。
   * v16.1：火山双接口自动识别 + v18.1 火山方舟直连。
   * v21.1：新增「微软免费在线语音（Edge TTS）」——零密钥、无需开通，走
   * wss://speech.platform.bing.com 合成 mp3；音色自然（晓晓/云希/云扬等）。
   * v25.1：超时类错误统一翻译为大白话（signal timed out 等不再裸抛）。
   */
  async tts(input: unknown): Promise<{ audioBase64: string; format: string }> {
    try {
      return await this.ttsInner(input);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/signal timed out|timeout|timed out|abort/i.test(msg)) {
        throw new Error('语音服务响应超时：网络较慢或服务暂时不可达。请点「重试」再试一次；若持续超时，可先改用「系统语音」播报，或换一个「免费在线音色」。');
      }
      throw error;
    }
  }

  private async ttsInner(input: unknown): Promise<{ audioBase64: string; format: string }> {
    const parsed = z.object({
      text: z.string().min(1).max(500),
      voiceType: z.string().optional(),
      // 试听时前端传当前界面选择的来源（覆盖已保存配置），实现"所见即所得"；播报不传，用已保存配置
      provider: z.enum(['system', 'volcengine']).optional(),
      // 试听时前端传火山 API Key（覆盖已保存，避免"界面填了 Key 却没保存就走旧接口"）
      apiKey: z.string().optional(),
    }).parse(input);
    const config = await this.database.getStoreConfig();
    const ttsConfig = config.tts;
    const effectiveProvider = parsed.provider ?? ttsConfig?.provider;
    const v = ttsConfig?.volcengine;
    const apiKey = (parsed.apiKey?.trim() || v?.apiKey?.trim() || '').trim();
    if (effectiveProvider !== 'volcengine' || (!apiKey && !v?.accessToken?.trim())) {
      throw new Error('尚未开启火山·豆包语音：请在「播报音色」中填写火山 API Key（新版控制台「API 管理」复制），并选一个音色');
    }
    const voiceType = (parsed.voiceType || v.voiceType || 'zh_female_cancan_moon_bigtts').trim();
    // v26.1：新版控制台统一 API Key → 豆包语音合成大模型（X-Api-Key 单头鉴权，音色自动匹配 1.0/2.0）
    // 无需 AppID/Token/Cluster/推理接入点——官方文档 volcengine.com/docs/6269/1598757
    if (apiKey) {
      return this.volcBigTtsRequest(apiKey, voiceType, parsed.text);
    }
    const appId = v.appId.trim();
    const accessToken = v.accessToken.trim();
    const customCluster = (v.cluster || '').trim();

    // 组装尝试序列：首选音色（接口由音色代码或自定义 Cluster 决定），授权类错误时自动补试豆包大模型音色
    const isMegaRequested = voiceType.startsWith('zh_') || customCluster === 'volcano_mega';
    const attempts: Array<{ voice: string; cluster: string }> = [
      { voice: voiceType, cluster: customCluster || (isMegaRequested ? 'volcano_mega' : 'volcano_tts') },
    ];
    const megaFallback = MEGA_VOICE_FALLBACK[voiceType];
    if (!isMegaRequested && megaFallback) {
      attempts.push({ voice: megaFallback, cluster: 'volcano_mega' });
    }

    let lastError = '';
    for (let index = 0; index < attempts.length; index += 1) {
      const attempt = attempts[index]!;
      try {
        return await this.volcTtsRequest(appId, accessToken, attempt.cluster, attempt.voice, parsed.text);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        const isGrant = /load grant|grant not found|access denied|forbidden|unauthorized|鉴权失败|not authorized|invalid token/i.test(lastError);
        // 仅授权/令牌类错误继续尝试另一套接口；音色/额度等其他错误直接抛出
        if (!isGrant || index >= attempts.length - 1) break;
      }
    }
    const triedNote = attempts.length > 1 ? '（已自动尝试 经典语音 与 豆包大模型 两套接口，仍失败）' : '';
    throw new Error(`火山引擎语音合成失败：${this.describeVolcTtsError(lastError)}（原始返回：${lastError.slice(0, 200)}）${triedNote}`);
  }

  /**
   * v26.1：豆包语音合成大模型（新版控制台统一 API Key 鉴权）。
   * POST https://openspeech.bytedance.com/api/v3/tts/unidirectional（HTTP Chunked 流式）
   * Headers：X-Api-Key（控制台「API Key 管理」）、X-Api-Resource-Id: seed-tts-2.0（语音合成大模型2.0）、X-Api-Request-Id
   * Body：{ user:{uid}, req_params:{ text, speaker, audio_params:{format:'mp3',sample_rate:24000} } }
   * 响应：chunked JSON，data 字段为 base64 音频；结束 code=20000000。
   * 官方文档：volcengine.com/docs/6269/1598757
   */
  private async volcBigTtsRequest(apiKey: string, voiceType: string, text: string): Promise<{ audioBase64: string; format: string }> {
    if (voiceType.startsWith('ICL_')) {
      throw new Error('这个音色是「对话式音色」（ICL 开头），不支持普通播报合成。请换用普通音色：灿灿、云扬、Vivi 2.0、小何 2.0 等。');
    }
    // 音色与版本不匹配（55000000）时自动换另一个版本重试，不再靠猜
    const candidates = voiceType.includes('uranus') ? ['seed-tts-2.0', 'seed-tts-1.0'] : ['seed-tts-1.0', 'seed-tts-2.0'];
    let lastError = '';
    for (let attempt = 0; attempt < candidates.length; attempt += 1) {
      try {
        return await this.volcBigTtsAttempt(apiKey, voiceType, text, candidates[attempt]!);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes('55000000') || msg.includes('资源不匹配')) {
          lastError = msg;
          continue; // 换版本重试
        }
        throw error;
      }
    }
    throw new Error(`${lastError || '豆包语音合成失败'}（已自动尝试 1.0/2.0 两个版本，均不匹配）。若均已开通仍报错，请把此提示发给技术处理`);
  }

  /** 单次豆包语音大模型合成（X-Api-Key 鉴权，HTTP Chunked 流式） */
  private async volcBigTtsAttempt(apiKey: string, voiceType: string, text: string, resourceId: string): Promise<{ audioBase64: string; format: string }> {
    const response = await fetch('https://openspeech.bytedance.com/api/v3/tts/unidirectional', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': apiKey,
        'X-Api-Resource-Id': resourceId,
        'X-Api-Request-Id': crypto.randomUUID(),
      },
      body: JSON.stringify({
        user: { uid: 'liveops-local' },
        req_params: {
          text,
          speaker: voiceType,
          audio_params: { format: 'mp3', sample_rate: 24000 },
        },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}${raw ? `：${raw.slice(0, 200)}` : ''}`);
    }
    // 流式收集文本，按完整 JSON 对象切分（chunk 间可能无换行，用平衡括号解析）
    let allText = '';
    const reader = response.body?.getReader();
    if (!reader) throw new Error('无法读取语音合成响应');
    const decoder = new TextDecoder('utf-8');
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      allText += decoder.decode(value, { stream: true });
    }
    const audioParts: string[] = [];
    let rest = allText;
    while (rest.trim().length > 0) {
      const start = rest.search(/\{/);
      if (start === -1) break;
      rest = rest.slice(start);
      let depth = 0;
      let inString = false;
      let escaped = false;
      let end = -1;
      for (let i = 0; i < rest.length; i += 1) {
        const ch = rest[i];
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') inString = true;
        else if (ch === '{') depth += 1;
        else if (ch === '}') {
          depth -= 1;
          if (depth === 0) { end = i; break; }
        }
      }
      if (end === -1) break;
      const line = rest.slice(0, end + 1);
      rest = rest.slice(end + 1);
      try {
        const parsed = JSON.parse(line) as { code?: number; message?: string; data?: string | null };
        if (parsed.code === 0 && typeof parsed.data === 'string' && parsed.data.length > 0) {
          audioParts.push(parsed.data);
        } else if (parsed.code !== 0 && parsed.code !== 20000000) {
          if (parsed.code === 55000000) {
            throw new Error(`音色与模型版本不匹配（code=55000000）：音色「${voiceType}」不属于资源 ${resourceId}`);
          }
          throw new Error(`豆包语音合成失败（code=${parsed.code ?? '?'}）：${parsed.message || '未知错误'}。若提示未开通/未授权，请到火山控制台「开通管理」开通「语音合成大模型」服务`);
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('豆包语音合成失败')) throw error;
        if (error instanceof Error && error.message.includes('55000000')) throw error;
        // 非完整 JSON 片段，忽略继续
      }
    }
    if (audioParts.length === 0) {
      throw new Error('豆包语音合成没有返回音频：请核对 API Key 是否正确、音色是否存在；若提示未开通，请到火山控制台「开通管理」开通「语音合成大模型」服务');
    }
    // 校验并探测拼接后的音频真实格式（火山个别情况下可能返回 ogg_opus 而非 mp3，自适应避免"无法播放"）
    const audioBuf = Buffer.from(audioParts.join(''), 'base64');
    const isMp3 = (audioBuf.length > 3 && audioBuf[0] === 0x49 && audioBuf[1] === 0x44 && audioBuf[2] === 0x33)
      || (audioBuf.length > 1 && audioBuf[0] === 0xff && (audioBuf[1]! & 0xe0) === 0xe0);
    const isOgg = audioBuf.length > 4 && audioBuf[0] === 0x4f && audioBuf[1] === 0x67 && audioBuf[2] === 0x67 && audioBuf[3] === 0x53; // OggS
    const isWav = audioBuf.length > 4 && audioBuf[0] === 0x52 && audioBuf[1] === 0x49 && audioBuf[2] === 0x46 && audioBuf[3] === 0x46; // RIFF
    let format = 'mp3';
    if (isMp3) format = 'mp3';
    else if (isOgg) format = 'ogg';
    else if (isWav) format = 'wav';
    else {
      throw new Error(`试听音频格式异常（前 8 字节：${audioBuf.subarray(0, 8).toString('hex')}，共 ${audioBuf.length} 字节）。火山返回的不是可播放音频，请换一个音色重试，或把此提示发给技术处理`);
    }
    return { audioBase64: audioBuf.toString('base64'), format };
  }

  /** 单次火山 TTS 请求：按 cluster 自动选 v1 经典或 v3 豆包大模型接口 */
  private async volcTtsRequest(appId: string, token: string, cluster: string, voiceType: string, text: string): Promise<{ audioBase64: string; format: string }> {
    const isMega = cluster === 'volcano_mega';
    const url = isMega ? 'https://openspeech.bytedance.com/api/v3/tts' : 'https://openspeech.bytedance.com/api/v1/tts';
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer;${token}` },
      body: JSON.stringify({
        app: { appid: appId, token, cluster },
        user: { uid: 'liveops-local' },
        audio: { voice_type: voiceType, encoding: 'mp3', speed_ratio: 1.0, volume_ratio: 1.0, pitch_ratio: 1.0 },
        request: { reqid: crypto.randomUUID(), text, operation: 'query' },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json().catch(() => null) as { code?: number; message?: string; data?: { audio?: string } } | null;
    if (!response.ok || payload?.code !== 3000 || !payload.data?.audio) {
      const raw = typeof payload?.message === 'string' && payload.message.length > 0
        ? payload.message
        : `HTTP ${response.status}`;
      throw new Error(raw);
    }
    return { audioBase64: payload.data.audio, format: 'mp3' };
  }

  /**
   * v21.1：微软免费在线语音（Edge TTS）。
   * v25.1：连接/超时类失败自动重试一次（微软服务偶发慢），并统一翻译超时错误为大白话。
   */
  /** 把火山引擎返回的原始错误翻译成大白话（常见鉴权/音色/限流/资源未开通场景） */
  private describeVolcTtsError(raw: string): string {
    // 「资源未授权」：AppID 在语音合成 SaaS 里没开通 volc.tts.default 资源 →
    // 大概率账号根本没有语音合成服务（只有方舟），引导切到方舟模式
    if (/resource.*not granted|not granted|resource_id|资源.*未.*授权|未开通/.test(raw)) {
      return '「未开通语音合成服务」——你当前用的是「火山·语音合成」模式，但这个账号没有开通语音合成服务。如果你持有的是「火山方舟」API Key（sk- 开头），请把音色来源切换到「火山方舟」，填 API Key 和模型/推理接入点 ID（方舟控制台→在线推理→创建推理接入点→选择语音合成模型）；若确认要用语音合成，请先到火山控制台开通「语音技术→语音合成」服务并绑定应用。';
    }
    const grantPatterns = ['load grant', 'grant not found', 'grant type', 'access denied', 'forbidden', 'unauthorized', '鉴权失败', 'invalid token', 'not authorized'];
    if (grantPatterns.some((pattern) => raw.toLowerCase().includes(pattern))) {
      return '「访问令牌无效」——请回火山控制台核对：① 进入 语音技术→语音合成→应用管理，复制「同一个应用」的 AppID 和 Access Token（完整复制，别带空格/漏字符）；② 确认该应用已开通语音合成服务；③ 若重置过令牌请用最新那个。';
    }
    if (/4040|voice.*not.*found|音色.*不存在|voice type/.test(raw)) {
      return '「音色代码不存在」——请在下拉里换个音色，或确认手动输入的代码正确（经典如 BV700_streaming；豆包大模型如 zh_female_cancan_moon_bigtts）。';
    }
    if (/4004|app.*not.*found|应用.*不存在/.test(raw)) {
      return '「AppID 无效」——请核对控制台里的 AppID 是否完整复制。';
    }
    if (/4064|并发|qps|limit|quota|flow/.test(raw)) {
      return '「并发或额度超限」——免费额度用完了或同时请求太多，稍等再试或检查控制台额度。';
    }
    return raw;
  }

  listOffers() {
    return this.database.listOffers();
  }

  saveOffer(input: unknown) {
    return this.database.saveOffer(OfferSnapshotSchema.parse(input));
  }

  listKnowledge() {
    return this.database.listKnowledge();
  }

  async authorizeRunSheetScript(script: string) {
    if (this.runtimeUnsafeReason) throw new Error(this.runtimeUnsafeReason);
    const [knowledge, activeOffer, config] = await Promise.all([
      this.database.listKnowledge(),
      this.database.getActiveOffer(),
      this.database.getStoreConfig(),
    ]);
    const verifiedKnowledge = await this.verifiedApprovedKnowledge(knowledge);
    const match = buildRunSheet(verifiedKnowledge, activeOffer, new Date(), () => true, config).find((segment) => segment.script === script);
    if (!match?.approved) throw new Error('话术已过期、证据不足或命中禁止表达，AI播报已阻断');
    return { allowed: true as const, script: match.script, scene: match.scene };
  }

  async saveKnowledge(input: unknown) {
    const parsed = KnowledgeItemSchema.parse(input);
    if (APPROVED_KNOWLEDGE_IDS.has(parsed.id)) throw new Error('系统锁定白名单不可通过普通知识接口修改');
    if (redactPersonalData(parsed.answer) !== parsed.answer) throw new Error('知识答案包含完整隐私，请先脱敏');
    if (!parsed.evidenceRefs.every((evidence) => evidenceMatchesStoredFile(evidence))
      || !await this.database.allEvidenceIsRegistered(parsed.evidenceRefs)) {
      throw new Error('知识草稿必须绑定由本工具保全、隐私已确认且校验一致的证据');
    }
    return this.database.saveKnowledge({
      ...parsed,
      decision: 'OPERATOR_REQUIRED',
      risk: 'HIGH',
      status: 'DRAFT',
    });
  }

  async evaluate(input: { knowledgeItemId: string | null; question: string; proposedAnswer: string }) {
    if (this.runtimeUnsafeReason) throw new Error(this.runtimeUnsafeReason);
    const knowledgeItem = input.knowledgeItemId
      ? await this.database.getKnowledge(input.knowledgeItemId)
      : null;
    const verifiedKnowledge = knowledgeItem
      && this.matchesApprovedDefinition(knowledgeItem)
      && redactPersonalData(knowledgeItem.answer) === knowledgeItem.answer
      && knowledgeItem.evidenceRefs.every((evidence) => evidenceMatchesStoredFile(evidence))
      && await this.database.allEvidenceIsRegistered(knowledgeItem.evidenceRefs)
      ? knowledgeItem : null;
    const result = evaluateResponse({ ...input, knowledgeItem: verifiedKnowledge, evidenceVerified: verifiedKnowledge !== null });
    const session = await this.database.getLatestSession();
    if (session) {
      await this.database.appendEvent({
        id: crypto.randomUUID(),
        sessionId: session.id,
        type: 'RESPONSE_DECISION',
        severity: result.decision === 'BLOCKED' ? 'CRITICAL' : result.decision === 'OPERATOR_REQUIRED' ? 'WARNING' : 'INFO',
        message: result.reasons.join('；'),
        payload: { decision: result.decision, question: result.redactedQuestion },
        createdAt: new Date().toISOString(),
      });
    }
    return result;
  }

  async updateHardware(input: Partial<typeof this.hardware>) {
    const before = { ...this.hardware };
    if (input.cameraDeviceId !== undefined) this.hardware.cameraDeviceId = input.cameraDeviceId;
    if (input.cameraLabel !== undefined) this.hardware.cameraLabel = input.cameraLabel;
    if (input.cameraStreamActive !== undefined) this.hardware.cameraStreamActive = input.cameraStreamActive;
    if (input.cameraFramingConfirmed !== undefined) this.hardware.cameraFramingConfirmed = input.cameraFramingConfirmed;
    if (input.voiceReady !== undefined) this.hardware.voiceReady = input.voiceReady;
    if (input.takeoverReady !== undefined) this.hardware.takeoverReady = input.takeoverReady;
    this.hardware.cameraReady = Boolean(
      this.hardware.cameraDeviceId
      && this.hardware.cameraStreamActive
      && this.hardware.cameraFramingConfirmed,
    );
    await this.database.recordHardwareChange(before, this.hardware);
    // v2：监护三项（画面/语音/接管）全部确认 → 落盘复用（重启不重确认）；任一取消 → 落盘取消
    if (this.hardware.cameraFramingConfirmed && this.hardware.voiceReady && this.hardware.takeoverReady) {
      await this.database.updateStoreConfig({ hardwareConfirmed: true });
    } else if (input.cameraFramingConfirmed === false || input.voiceReady === false || input.takeoverReady === false) {
      await this.database.updateStoreConfig({ hardwareConfirmed: false });
    }
    return { ...this.hardware };
  }

  async saveEvidenceFile(input: { fileName: string; mimeType: string; contentBase64: string; privacyConfirmed: true }) {
    if (input.privacyConfirmed !== true) throw new Error('保存证据前必须确认文件已经人工脱敏');
    const allowedMime = new Set(['image/png', 'image/jpeg', 'application/pdf', 'text/plain', 'application/json']);
    if (!allowedMime.has(input.mimeType)) throw new Error('仅支持 PNG、JPG、PDF、TXT 或 JSON 证据文件');
    const bytes = Buffer.from(input.contentBase64, 'base64');
    if (bytes.byteLength === 0 || bytes.byteLength > 10 * 1024 * 1024) throw new Error('证据文件必须在1字节到10MB之间');
    const extension = extname(input.fileName).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.pdf', '.txt', '.json'].includes(extension)) throw new Error('证据文件扩展名不受支持');
    if (input.mimeType === 'text/plain' || input.mimeType === 'application/json') {
      const text = bytes.toString('utf8');
      if (redactPersonalData(text) !== text) {
        throw new Error('文本证据检测到姓名、联系方式、地址、订单号或其他完整隐私，请先脱敏后再上传');
      }
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const id = crypto.randomUUID();
    const directory = join(this.database.dataDir, 'evidence');
    await mkdir(directory, { recursive: true });
    const storedName = `${id}${extension}`;
    const sourceUri = join(directory, storedName);
    await writeFile(sourceUri, bytes, { flag: 'wx' });
    await this.database.recordEvidenceFile(id, {
      originalName: basename(input.fileName),
      mimeType: input.mimeType,
      bytes: bytes.byteLength,
      sha256,
      sourceUri: resolve(sourceUri),
      privacyConfirmed: input.privacyConfirmed,
    });
    return { id, originalName: basename(input.fileName), sourceUri, sha256, bytes: bytes.byteLength };
  }

  async preflight() {
    const [activeOffer, settings] = await Promise.all([
      this.database.getActiveOffer(),
      this.database.getStoreConfig(),
    ]);
    const checks = buildPreflightChecks({ activeOffer, settings, ...this.hardware });
    return {
      checks,
      blocked: checks.some((check) => check.status === 'BLOCKED'),
      manualRequired: checks.some((check) => check.status === 'MANUAL_REQUIRED'),
      formalTrialUnlocked: false,
    };
  }

  async createSession(): Promise<LiveSession> {
    const current = await this.database.getLatestSession();
    if (current && ['DRAFT', 'PREFLIGHT_BLOCKED', 'READY', 'LIVE', 'PAUSED'].includes(current.state)) return current;
    const offer = await this.database.getActiveOffer();
    const start = new Date();
    start.setHours(20, 0, 0, 0);
    if (start.getTime() < Date.now() - 7_200_000) start.setDate(start.getDate() + 1);
    const end = new Date(start.getTime() + 7_200_000);
    const timestamp = new Date().toISOString();
    return this.database.createSession({
      id: crypto.randomUUID(),
      offerSnapshotId: offer?.id ?? null,
      trafficMode: 'NATURAL_ONLY',
      // 流程精简（批次1）：建场次不再预跑 preflight，统一恒定 DRAFT；
      // 全部检查推迟到真正转 LIVE 时一次性执行（transition 内保留合规底线）。
      state: 'DRAFT',
      scheduledStart: start.toISOString(),
      scheduledEnd: end.toISOString(),
      startedAt: null,
      endedAt: null,
      lastPresenceAt: null,
      missedPresence: 0,
      stopReason: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  latestSession() {
    return this.database.getLatestSession();
  }

  async transition(id: string, state: LiveSessionState, reason: string | null, externalStartConfirmed: boolean): Promise<LiveSession> {
    const session = await this.requireSession(id);
    assertTransition(session.state, state);

    // 流程精简（批次1）：READY 中间态不再用于新场次（DRAFT 可直接转 LIVE），
    // preflight 只在真正转 LIVE 时执行一次，检查与确认全部集中在下方的 LIVE 分支。

    if (state === 'LIVE' && !externalStartConfirmed) {
      throw new Error('必须由员工确认已经在抖音直播伴侣人工完成本次开播');
    }
    if (state === 'LIVE') {
      const preflight = await this.preflight();
      if (preflight.blocked || preflight.manualRequired) throw new Error('试播门禁未全部通过，不能标记为直播中');
      const currentOffer = await this.database.getActiveOffer();
      // v9.1：场次可能先建后补商品（offerSnapshotId 为 null），开播时允许绑定当前有效商品；
      // 已绑定过商品的场次必须与当前有效商品一致（防开播后改价播报不一致）。
      if (!currentOffer) {
        throw new Error('尚未冻结开播商品快照，不能开播');
      }
      if (session.offerSnapshotId !== null && session.offerSnapshotId !== currentOffer.id) {
        throw new Error('场次绑定商品与当前有效商品不一致，请安全结束场次后重新建立');
      }
    }

    const timestamp = new Date().toISOString();
    const next: LiveSession = {
      ...session,
      state,
      startedAt: state === 'LIVE' && !session.startedAt ? timestamp : session.startedAt,
      endedAt: ['STOPPED', 'COMPLETED'].includes(state) ? timestamp : session.endedAt,
      lastPresenceAt: state === 'LIVE' ? timestamp : session.lastPresenceAt,
      missedPresence: state === 'LIVE' ? 0 : session.missedPresence,
      stopReason: ['STOPPED', 'PAUSED'].includes(state) ? reason : session.stopReason,
      updatedAt: timestamp,
    };
    await this.database.saveSessionIfCurrent(next, session.state, session.updatedAt, 'SESSION_TRANSITION');
    if (state === 'LIVE') this.runtimeUnsafeReason = null;
    await this.database.appendEvent({
      id: crypto.randomUUID(),
      sessionId: id,
      type: 'SESSION_TRANSITION',
      severity: state === 'STOPPED' ? 'WARNING' : 'INFO',
      message: `场次状态变更为 ${state}${reason ? `：${reason}` : ''}`,
      payload: { from: session.state, to: state },
      createdAt: timestamp,
    });
    return next;
  }

  async acknowledgePresence(id: string): Promise<LiveSession> {
    const session = await this.requireSession(id);
    const timestamp = new Date().toISOString();
    const next = await this.database.saveSessionIfCurrent({
      ...session,
      lastPresenceAt: timestamp,
      missedPresence: 0,
      updatedAt: timestamp,
    }, session.state, session.updatedAt, 'PRESENCE_ACKNOWLEDGED');
    await this.database.appendEvent({
      id: crypto.randomUUID(),
      sessionId: id,
      type: 'PRESENCE_ACK',
      severity: 'INFO',
      message: '员工已确认在场',
      payload: {},
      createdAt: timestamp,
    });
    return next;
  }

  listEvents(id: string, limit: number) {
    return this.database.listEvents(id, limit);
  }

  async addEvent(id: string, input: Omit<RuntimeEvent, 'id' | 'sessionId' | 'createdAt'>) {
    await this.requireSession(id);
    return this.database.appendEvent({
      id: crypto.randomUUID(),
      sessionId: id,
      createdAt: new Date().toISOString(),
      ...input,
    });
  }

  listOrders() {
    return this.database.listOrders();
  }

  saveOrder(input: unknown) {
    return this.database.saveOrder(OrderOutcomeSchema.parse(input));
  }

  async cohortReport() {
    const [orders, totalRecordedOrders, sessions, offers] = await Promise.all([this.database.listOrders(), this.database.countOrderRows(), this.database.listSessions(), this.database.listOffers()]);
    const sessionById = new Map(sessions.map((session) => [session.id, session]));
    const offerById = new Map(offers.map((offer) => [offer.id, offer]));
    const registeredEvidence = new Map(await Promise.all(orders.map(async (order) => [order.id, await this.database.allEvidenceIsRegistered(order.evidenceRefs)] as const)));
    const validOfferEvidence = new Map(await Promise.all(offers.map(async (offer) => [offer.id,
      offer.evidenceRefs.every((evidence) => evidenceMatchesStoredFile(evidence))
      && await this.database.allEvidenceIsRegistered(offer.evidenceRefs),
    ] as const)));
    const eligibleOrders = orders.filter((order) => {
      if (!order.liveSessionId || !order.customerRefHash || !order.newCustomerConfirmed) return false;
      const session = sessionById.get(order.liveSessionId);
      const offer = offerById.get(order.offerSnapshotId);
      if (!session?.startedAt || !session.endedAt || !['STOPPED', 'COMPLETED'].includes(session.state)) return false;
      if (!offer || validOfferEvidence.get(offer.id) !== true || session.offerSnapshotId !== offer.id || session.trafficMode !== 'NATURAL_ONLY') return false;
      const paidAt = new Date(order.firstPaidAt).getTime();
      if (paidAt < new Date(session.startedAt).getTime() || paidAt > new Date(session.endedAt).getTime()) return false;
      if (!order.evidenceRefs.every((evidence) => evidenceMatchesStoredFile(evidence)) || registeredEvidence.get(order.id) !== true) return false;
      // v8.1 起自查模式与文件证据二选一：自查确认（记录真实履约+成本真实）或 传统文件证据
      const selfChecked = order.selfChecks?.recordConfirmed === true && order.selfChecks?.costConfirmed === true;
      const hasFileEvidence = order.evidenceRefs.some((evidence) => evidence.sourceType === 'COST_RECORD')
        && order.evidenceRefs.some((evidence) => evidence.sourceType === 'MERCHANT_RECORD');
      if (!selfChecked && !hasFileEvidence) return false;
      return !order.repeatPaidAt || (offer.regularPriceCents !== null && order.repeatPriceCents === offer.regularPriceCents);
    });
    const base = calculateCohortReport(eligibleOrders);
    const finished = sessions.filter((session) => session.startedAt && session.endedAt
      && session.trafficMode === 'NATURAL_ONLY'
      && ['STOPPED', 'COMPLETED'].includes(session.state));
    const shanghaiDay = (value: string) => new Date(new Date(value).getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const liveNights = new Set(finished.map((session) => shanghaiDay(session.startedAt!))).size;
    const totalLiveMilliseconds = finished.reduce((sum, session) => {
      const duration = new Date(session.endedAt!).getTime() - new Date(session.startedAt!).getTime();
      return sum + Math.max(0, duration);
    }, 0);
    const liveMinutes = Math.floor(totalLiveMilliseconds / 60_000);
    const pilotLimitBreached = liveNights > 30 || liveMinutes > 3_600;
    const invalidRecords = totalRecordedOrders - eligibleOrders.length;
    const trialMissing = liveNights === 0 || liveMinutes === 0;
    const quantitativeThresholdsMet = base.qualifies && !pilotLimitBreached && !trialMissing && invalidRecords === 0;
    const extraReasons = [
      ...(pilotLimitBreached ? ['试播超过30晚或累计60小时上限'] : []),
      ...(trialMissing ? ['尚无已结束且有真实时长的自然流量直播场次'] : []),
      ...(invalidRecords > 0 ? [`有${invalidRecords}笔记录缺少有效商品、场次或可校验证据，未计入判定`] : []),
      ...(quantitativeThresholdsMet ? ['量化门槛已满足，但证据内容、平台归因和经营口径仍需独立人工复核后写入公司权威台账'] : []),
    ];
    return {
      ...base,
      totalRecordedOrders,
      eligibleOrders: eligibleOrders.length,
      liveNights,
      liveMinutes,
      pilotLimitBreached,
      quantitativeThresholdsMet,
      qualifies: false,
      reasons: [...base.reasons, ...extraReasons],
    };
  }

  async exportCohort() {
    const [config, offers, orders, report, quarantinedOrderIds, quarantinedSessionIds] = await Promise.all([
      this.database.getStoreConfig(),
      this.database.listOffers(),
      this.database.listOrders(),
      this.cohortReport(),
      this.database.listInvalidOrderIds(),
      this.database.listInvalidSessionIds(),
    ]);
    const bundle = {
      schemaVersion: 1,
      product: '实景直播经营系统',
      productStatus: 'LOCAL_COMMERCIAL_CANDIDATE',
      generatedAt: new Date().toISOString(),
      authorityNotice: '本文件是本地复核包，不是公司权威经营台账，不证明已商用或已经赚钱。',
      config,
      offerSnapshots: offers,
      orderOutcomes: orders,
      quarantinedOrderIds,
      quarantinedSessionIds,
      cohortReport: report,
    };
    await this.database.recordExport('COHORT_REVIEW_BUNDLE', {
      orderCount: orders.length,
      qualifies: report.qualifies,
      generatedAt: bundle.generatedAt,
    });
    return bundle;
  }

  audit(limit: number) {
    return this.database.listAudit(limit);
  }

  async createBackup(label?: string): Promise<BackupSummary> {
    const summary = createLocalBackup({
      dataDir: this.database.dataDir,
      label: label || '值班台手动备份',
    });
    await this.database.recordDataMaintenance('BACKUP_CREATED', {
      backupDir: summary.dir,
      label: summary.label,
      fileCount: summary.fileCount,
      bytes: summary.bytes,
      createdAt: summary.createdAt,
      externalEvidenceIds: summary.externalEvidenceIds,
    });
    return summary;
  }

  listBackups(): BackupSummary[] {
    return listLocalBackups(defaultBackupsRoot(this.database.dataDir));
  }

  verifyBackup(name: string): BackupIntegrity {
    if (!isSafeBackupName(name)) throw new Error('备份名称不合法');
    const dir = resolve(defaultBackupsRoot(this.database.dataDir), name);
    const integrity = inspectLocalBackup(dir);
    if (!integrity.ok && integrity.problems.length > 0) {
      throw new Error(integrity.problems[0]);
    }
    return integrity;
  }

  async restoreBackup(name: string): Promise<RestoreResult> {
    const dir = resolve(defaultBackupsRoot(this.database.dataDir), name);
    if (!isSafeBackupName(name)) throw new Error('备份名称不合法');
    if (this.database.hasBroadcastingSession()) {
      throw new Error('当前有直播中或暂停的场次，禁止恢复数据；请先安全结束场次');
    }
    // 先把运行中的内存状态落盘，确保恢复前的自动安全备份反映的是真实当前状态。
    await this.database.flush();
    const result = restoreLocalBackup({
      backupDir: dir,
      dataDir: this.database.dataDir,
    });
    // 恢复后重载内存，避免下一次 persist() 用旧状态把恢复结果覆盖回去。
    await this.database.reload();
    // 恢复可能带回旧版白名单知识，重新执行白名单种子，让标准话术与本程序指纹保持一致。
    await this.seedKnowledge().catch((error: unknown) => {
      result.warnings.push(`白名单知识重新断言失败（${error instanceof Error ? error.message : '未知错误'}），AI 播报将保持阻断，需人工复核`);
    });
    await this.database.recordDataMaintenance('BACKUP_RESTORED', {
      restoredFrom: result.restoredFrom,
      safetyBackupDir: result.safetyBackupDir,
      restoredFiles: result.restoredFiles,
      rewrittenPaths: result.rewrittenPaths,
      verifiedEvidenceFiles: result.verifiedEvidenceFiles,
      warnings: result.warnings,
    });
    return result;
  }

  private async requireSession(id: string): Promise<LiveSession> {
    const session = await this.database.getSession(id);
    if (!session) throw new Error('直播场次不存在');
    return session;
  }

  private async checkPresence(): Promise<void> {
    const session = await this.database.getLatestSession();
    if (!session || session.state !== 'LIVE' || !session.lastPresenceAt) return;
    const config = await this.database.getStoreConfig();
    const intervalMs = config.presenceIntervalMinutes * 60_000;
    const elapsed = Date.now() - new Date(session.lastPresenceAt).getTime();
    const missed = Math.floor(elapsed / intervalMs);
    if (missed <= session.missedPresence) return;
    const timestamp = new Date().toISOString();
    const nextMissed = Math.min(missed, config.maxMissedPresence);
    if (nextMissed >= config.maxMissedPresence) {
      const paused: LiveSession = {
        ...session,
        state: 'PAUSED',
        missedPresence: nextMissed,
        stopReason: '连续两次未确认员工在场，AI播报已停止',
        updatedAt: timestamp,
      };
      await this.database.saveSessionIfCurrent(paused, session.state, session.updatedAt, 'PRESENCE_FAILSAFE_PAUSED');
      await this.database.appendEvent({
        id: crypto.randomUUID(),
        sessionId: session.id,
        type: 'RISK_ALERT',
        severity: 'CRITICAL',
        message: paused.stopReason ?? '员工失联',
        payload: { missedPresence: nextMissed },
        createdAt: timestamp,
      });
      return;
    }
    await this.database.saveSessionIfCurrent({ ...session, missedPresence: nextMissed, updatedAt: timestamp }, session.state, session.updatedAt, 'PRESENCE_MISSED');
  }

  private async runSafetyHeartbeat(): Promise<void> {
    const session = await this.database.getLatestSession();
    if (!session || session.state !== 'LIVE') return;
    const startedAt = session.startedAt ? new Date(session.startedAt).getTime() : Date.now();
    const mustEndAt = Math.min(startedAt + 7_200_000, new Date(session.scheduledEnd).getTime());
    if (Date.now() >= mustEndAt) {
      const timestamp = new Date().toISOString();
      const completed: LiveSession = {
        ...session, state: 'COMPLETED', endedAt: timestamp, stopReason: '单场两小时或预定结束时间已到，AI播报已停止', updatedAt: timestamp,
      };
      await this.database.saveSessionIfCurrent(completed, session.state, session.updatedAt, 'SESSION_DURATION_COMPLETED');
      await this.database.appendEvent({
        id: crypto.randomUUID(), sessionId: session.id, type: 'SESSION_TRANSITION', severity: 'INFO',
        message: completed.stopReason ?? '单场结束', payload: { from: 'LIVE', to: 'COMPLETED' }, createdAt: timestamp,
      });
      return;
    }
    if (!this.hardware.cameraReady || !this.hardware.voiceReady || !this.hardware.takeoverReady) {
      const timestamp = new Date().toISOString();
      const paused: LiveSession = {
        ...session,
        state: 'PAUSED',
        stopReason: '设备或人工接管门禁失效，AI播报已停止',
        updatedAt: timestamp,
      };
      await this.database.saveSessionIfCurrent(paused, session.state, session.updatedAt, 'HARDWARE_FAILSAFE_PAUSED');
      await this.database.appendEvent({
        id: crypto.randomUUID(), sessionId: session.id, type: 'RISK_ALERT', severity: 'CRITICAL',
        message: paused.stopReason ?? '硬件门禁失效', payload: { hardware: this.hardware }, createdAt: timestamp,
      });
      return;
    }
    const activeOffer = await this.database.getActiveOffer();
    if (!activeOffer || activeOffer.id !== session.offerSnapshotId) {
      const timestamp = new Date().toISOString();
      const paused: LiveSession = {
        ...session,
        state: 'PAUSED',
        stopReason: '商品快照或证据已经失效，AI播报和价格展示已停止',
        updatedAt: timestamp,
      };
      await this.database.saveSessionIfCurrent(paused, session.state, session.updatedAt, 'OFFER_EVIDENCE_FAILSAFE_PAUSED');
      await this.database.appendEvent({
        id: crypto.randomUUID(), sessionId: session.id, type: 'RISK_ALERT', severity: 'CRITICAL',
        message: paused.stopReason ?? '商品快照证据失效', payload: {}, createdAt: timestamp,
      });
      return;
    }
    await this.checkPresence();
  }

  private async triggerSafetyHeartbeat(): Promise<void> {
    if (this.heartbeatRunning) return;
    this.heartbeatRunning = true;
    try {
      await this.runSafetyHeartbeat();
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知安全心跳异常';
      this.runtimeUnsafeReason = `安全心跳异常，AI播报已停止，需要员工复核：${message}`;
      const session = await this.database.getLatestSession().catch(() => null);
      if (session?.state === 'LIVE') {
        const timestamp = new Date().toISOString();
        await this.database.saveSessionIfCurrent({
          ...session,
          state: 'PAUSED',
          stopReason: this.runtimeUnsafeReason,
          updatedAt: timestamp,
        }, session.state, session.updatedAt, 'SAFETY_HEARTBEAT_FAILED_PAUSED').catch(() => undefined);
        await this.database.appendEvent({
          id: crypto.randomUUID(), sessionId: session.id, type: 'RISK_ALERT', severity: 'CRITICAL',
          message: this.runtimeUnsafeReason, payload: {}, createdAt: timestamp,
        }).catch((auditError: unknown) => console.error('安全心跳审计失败', auditError));
      } else if (session) {
        await this.database.appendEvent({
          id: crypto.randomUUID(), sessionId: session.id, type: 'RISK_ALERT', severity: 'WARNING',
          message: `安全心跳本轮未执行：${message}`, payload: {}, createdAt: new Date().toISOString(),
        }).catch((auditError: unknown) => console.error('安全心跳审计失败', auditError));
      } else {
        console.error('安全心跳失败且没有可关联场次', error);
      }
    } finally {
      this.heartbeatRunning = false;
    }
  }

  private async seedKnowledge(): Promise<void> {
    const existing = await this.database.listKnowledge();
    const capturedAt = '2026-08-14T00:00:00.000Z';
    const validUntil = '2026-09-13T15:59:59.000Z';
    // 白名单知识证据路径：优先 LIVE_DOCS_DIR（打包模式由主进程注入），
    // 其次按打包布局 resources/docs，再按开发布局仓库根 docs，最后按独立运行目录逐级回退。
    const candidates = [
      process.env.LIVE_DOCS_DIR && resolve(process.env.LIVE_DOCS_DIR, 'APPROVED_LIVE_KNOWLEDGE.md'),
      resolve(import.meta.dirname, '..', '..', 'docs', 'APPROVED_LIVE_KNOWLEDGE.md'),
      resolve(import.meta.dirname, '..', '..', '..', 'docs', 'APPROVED_LIVE_KNOWLEDGE.md'),
    ].filter((p): p is string => Boolean(p));
    const sourceUri = candidates.find((p) => existsSync(p));
    if (!sourceUri) {
      throw new Error(`直播白名单知识证据不存在，请检查发布包或仓库 docs 目录（查找路径：${candidates.join('；')}）`);
    }
    const evidenceBytes = await readFile(sourceUri);
    const expectedSha256 = 'cf250e8d8711982901787b9db8375e0110456c8915f9df15b1669a5b98964593';
    const actualSha256 = createHash('sha256').update(evidenceBytes).digest('hex');
    if (actualSha256 !== expectedSha256) throw new Error('直播白名单知识证据已变化，必须重新人工复核后更新程序指纹');
    const evidenceDirectory = join(this.database.dataDir, 'evidence');
    const storedEvidencePath = join(evidenceDirectory, `${APPROVED_KNOWLEDGE_EVIDENCE_ID}.md`);
    await mkdir(evidenceDirectory, { recursive: true });
    try {
      await writeFile(storedEvidencePath, evidenceBytes, { flag: 'wx' });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
    const storedEvidenceBytes = await readFile(storedEvidencePath);
    if (createHash('sha256').update(storedEvidenceBytes).digest('hex') !== expectedSha256) {
      throw new Error('已保全直播白名单知识证据被改写，自动播报保持阻断');
    }
    await this.database.recordEvidenceFile(APPROVED_KNOWLEDGE_EVIDENCE_ID, {
      originalName: 'APPROVED_LIVE_KNOWLEDGE.md',
      mimeType: 'text/markdown',
      bytes: storedEvidenceBytes.byteLength,
      sha256: expectedSha256,
      sourceUri: resolve(storedEvidencePath),
      privacyConfirmed: true,
      systemPinned: true,
    });
    const evidence = {
      id: APPROVED_KNOWLEDGE_EVIDENCE_ID,
      title: '商家经营规则库（本地记录，正式开播前复核）',
      sourceType: 'MERCHANT_RECORD' as const,
      sourceUri: resolve(storedEvidencePath),
      capturedAt,
      validUntil,
      sha256: expectedSha256,
    };
    for (const item of existing.filter((existingItem) => !APPROVED_KNOWLEDGE_IDS.has(existingItem.id))) {
      await this.database.saveKnowledge({
        ...item,
        decision: 'OPERATOR_REQUIRED',
        risk: 'HIGH',
        status: item.status === 'RETIRED' ? 'RETIRED' : 'DRAFT',
      });
    }
    for (const item of APPROVED_KNOWLEDGE_DEFINITIONS) {
      await this.database.saveKnowledge({ ...item, evidenceRefs: [evidence], validUntil, status: 'ACTIVE' });
    }
  }

  private matchesApprovedDefinition(item: Awaited<ReturnType<LiveDatabase['listKnowledge']>>[number]): boolean {
    const approved = APPROVED_KNOWLEDGE_DEFINITIONS.find((definition) => definition.id === item.id);
    return Boolean(approved
      && item.intent === approved.intent
      && item.label === approved.label
      && item.answer === approved.answer
      && item.risk === approved.risk
      && item.decision === approved.decision
      && item.status === 'ACTIVE'
      && item.evidenceRefs.length === 1
      && item.evidenceRefs[0]?.id === APPROVED_KNOWLEDGE_EVIDENCE_ID);
  }

  private async verifiedApprovedKnowledge(items: Awaited<ReturnType<LiveDatabase['listKnowledge']>>) {
    const verified = await Promise.all(items.map(async (item) => (
      this.matchesApprovedDefinition(item)
      && redactPersonalData(item.answer) === item.answer
      && item.evidenceRefs.every((evidence) => evidenceMatchesStoredFile(evidence))
      && await this.database.allEvidenceIsRegistered(item.evidenceRefs)
        ? item : null
    )));
    return verified.filter((item): item is NonNullable<typeof item> => item !== null);
  }
}
