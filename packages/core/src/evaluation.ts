import type {
  KnowledgeItem,
  ResponseEvaluationResult,
} from '@mzg/live-contracts';

/**
 * 永久禁止表达（PRODUCT_SPEC §4）。出现即不得自动播报，且命中即视为需要证据。
 */
export const BLOCKED_CLAIMS = [
  '保证洗净',
  '恢复如新',
  '全城免费',
  '随叫随到',
  '当天送回',
  '杀菌',
  '消毒',
  '除螨',
  '全网最低',
  '洗坏包赔',
] as const;

/**
 * 需要证据支撑的声明（缺少可校验证据时不得进入自动播报）。
 * 这里与永久禁止表达保持一致：凡涉及效果/承诺/价格的强声明都必须有证据。
 */
export const EVIDENCE_REQUIRED_CLAIMS = BLOCKED_CLAIMS;

/**
 * 必须人工确认（PRODUCT_SPEC §4）。命中即不自动播报具体承诺。
 * 注意：清单刻意不包含「价格 / 员工 / 特殊材质 / 钟山 / 水城 / 服务范围」等
 * 会出现在合法话术中的词，以免误伤正常流程表；同时不含「售后 / 争议 / 订单」，
 * 因为标准流程表 CLOSER（"涉及个别订单或售后争议时…"）本就含这些词，
 * 命中会误伤 48 段标准话术的自动通过。
 */
export const SENSITIVE_INTENTS = [
  '退款',
  '赔偿',
  '投诉',
  '损坏',
  '丢失',
  '返工',
  '皮革',
  '翻毛',
  '老化',
  '开胶',
  '染色',
  '隐私',
  '到达',
  '超时',
] as const;

export function findBlockedClaims(text: string): string[] {
  return BLOCKED_CLAIMS.filter((claim) => text.includes(claim));
}

export function findSensitiveIntent(text: string): string[] {
  return SENSITIVE_INTENTS.filter((intent) => text.includes(intent));
}

/**
 * 脱敏：返回去掉个人信息的文本。若文本中包含个人数据，返回值与原文本不同，
 * 调用方据此判断「是否包含完整隐私」。
 */
export function redactPersonalData(text: string): string {
  let result = text;
  result = result.replace(/1[3-9]\d{9}/g, '***');
  result = result.replace(/姓名[:：][^\s,，。]+/g, '姓名：***');
  result = result.replace(/电话[:：][^\s,，。]+/g, '电话：***');
  result = result.replace(/身份证[:：][^\s,，。]+/g, '身份证：***');
  result = result.replace(/订单号[:：][^\s,，。]+/g, '订单号：***');
  result = result.replace(/地址[:：][^\s,，。]+/g, '地址：***');
  if (/微信|QQ|支付宝|邮箱|[\w.+-]+@[\w-]+\.[\w.-]+/.test(result)) {
    return '***';
  }
  return result;
}

export interface EvaluateResponseInput {
  knowledgeItemId: string | null;
  question: string;
  proposedAnswer: string;
  knowledgeItem: KnowledgeItem | null;
  evidenceVerified: boolean;
}

export function evaluateResponse(input: EvaluateResponseInput): ResponseEvaluationResult {
  const redactedQuestion = redactPersonalData(input.question);
  const reasons: string[] = [];

  if (findSensitiveIntent(redactedQuestion).length > 0 || findBlockedClaims(redactedQuestion).length > 0) {
    return { decision: 'OPERATOR_REQUIRED', reasons: ['问题包含敏感或禁止内容，需员工确认'], redactedQuestion };
  }

  if (input.knowledgeItem && input.evidenceVerified) {
    const item = input.knowledgeItem;
    if (item.decision === 'AUTO_ALLOWED') {
      return { decision: 'AUTO_ALLOWED', safeAnswer: item.answer, reasons, redactedQuestion };
    }
    if (item.decision === 'OPERATOR_REQUIRED') {
      return { decision: 'OPERATOR_REQUIRED', reasons: ['该知识需员工确认后答复'], redactedQuestion };
    }
    return { decision: 'BLOCKED', reasons: ['该知识被禁止自动播报'], redactedQuestion };
  }

  return { decision: 'OPERATOR_REQUIRED', reasons: ['未匹配到已批准知识，转人工处理'], redactedQuestion };
}
