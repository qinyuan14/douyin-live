import type { KnowledgeItem, OfferSnapshot, RunSheetSegment } from '@liveops/live-contracts';
import {
  EVIDENCE_REQUIRED_CLAIMS,
  evidenceMatchesStoredFile,
  findBlockedClaims,
  findSensitiveIntent,
  redactPersonalData,
} from '@liveops/live-core';

const OPENERS = [
  '刚进直播间的朋友，可以先看一下我们现在的真实作业过程。',
  '这里不是录播，镜头里是正在进行的真实服务操作。',
  '大家可以留意现场每一步是怎样分步骤处理的。',
  '今天我们只讲已经核对过的常规服务规则。',
  '如果你也有类似的服务需求，可以先看看这个处理细节。',
  '这会儿镜头给到真实工作台，工作人员不会露脸。',
] as const;

const CLOSERS = [
  '具体是否适合，仍要以员工收件后的实际检查为准。',
  '特殊情形不要直接下结论，我们会先让员工评估。',
  '价格和可购买状态，请以直播间当前有效商品为准。',
  '涉及个别订单或售后争议时，我们会请员工核实后答复。',
] as const;

const SCENES: RunSheetSegment['scene'][] = [
  'WORKBENCH',
  'PROCESS_CLOSEUP',
  'SERVICE_FACTS',
  'Q_AND_A',
  'OFFER',
];

const PHASES = ['开场观察', '接收准备', '主流程处理', '细节复核', '收尾确认'] as const;

type EvidenceAuthorizer = (refs: KnowledgeItem['evidenceRefs']) => boolean;

function evidenceIsCurrent(refs: KnowledgeItem['evidenceRefs'], now: Date, evidenceAuthorized: EvidenceAuthorizer): boolean {
  return refs.length > 0
    && evidenceAuthorized(refs)
    && refs.every((ref) => evidenceMatchesStoredFile(ref, now));
}

export function buildRunSheet(
  knowledge: KnowledgeItem[],
  offer: OfferSnapshot | null,
  now = new Date(),
  evidenceAuthorized: EvidenceAuthorizer = () => false,
  settings: { serviceAreas: string[] } | null = null,
): RunSheetSegment[] {
  const serviceAreaCloser = settings && settings.serviceAreas.length > 0
    ? `服务范围以已经确认的${settings.serviceAreas.join('、')}清单为准。`
    : null;
  const active = knowledge.filter((item) =>
    item.status === 'ACTIVE'
    && item.decision === 'AUTO_ALLOWED'
    && new Date(item.validUntil).getTime() > now.getTime()
    && evidenceIsCurrent(item.evidenceRefs, now, evidenceAuthorized)
    && findBlockedClaims(item.answer).length === 0
    && !EVIDENCE_REQUIRED_CLAIMS.some((claim) => item.answer.includes(claim))
    && findSensitiveIntent(item.answer).length === 0
    && redactPersonalData(item.answer) === item.answer,
  );
  const topics = active;
  const segments: RunSheetSegment[] = [];

  for (let index = 0; index < 60; index += 1) {
    const topic = topics[index % Math.max(1, topics.length)];
    const opener = OPENERS[index % OPENERS.length];
    const closer = serviceAreaCloser
      ?? CLOSERS[Math.floor(index / OPENERS.length) % CLOSERS.length];
    const offerLine = index % 5 === 4
      ? offer
        ? `当前冻结的新客商品价格是${(offer.priceCents / 100).toFixed(2)}元，适用范围请看直播间商品说明。`
        : '当前没有导入有效商品快照，所以演练不会播报具体价格。'
      : '';
    const topicAnswer = topic?.answer ?? '目前没有可自动播报的有效知识，正式直播前需要先完成知识审核。';
    const phase = PHASES[Math.floor(index / 10)] ?? PHASES[0];
    const phaseLine = `现在进入${phase}的第${index % 10 + 1}个现场观察点，请继续看镜头里的实际操作。`;
    const evidenceRefs = [
      ...(topic?.evidenceRefs ?? []),
      ...(offerLine && offer ? offer.evidenceRefs : []),
    ];
    const offerCurrent = Boolean(offer
      && offer.status === 'ACTIVE'
      && new Date(offer.validUntil).getTime() > now.getTime()
      && evidenceIsCurrent(offer.evidenceRefs, now, evidenceAuthorized));
    const script = [phaseLine, opener, topicAnswer, offerLine, closer].filter(Boolean).join(' ');
    const scriptPassesSafety = findBlockedClaims(script).length === 0
      && !EVIDENCE_REQUIRED_CLAIMS.some((claim) => script.includes(claim))
      && findSensitiveIntent(script).length === 0
      && redactPersonalData(script) === script;
    const approved = Boolean(topic && active.includes(topic) && (!offerLine || offerCurrent) && scriptPassesSafety);

    segments.push({
      id: crypto.randomUUID(),
      title: `${topic?.label ?? '待补知识'} · ${index + 1}`,
      durationSeconds: 120,
      script,
      scene: SCENES[index % SCENES.length] ?? 'WORKBENCH',
      approved,
      evidenceRefs,
    });
  }
  return segments;
}
