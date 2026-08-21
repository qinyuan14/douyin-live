import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Archive,
  BookOpenCheck,
  Bot,
  Camera,
  Check,
  ChevronRight,
  CircleAlert,
  ClipboardCheck,
  Database,
  DatabaseBackup,
  FileClock,
  FileUp,
  Gauge,
  Hand,
  Headphones,
  History,
  LayoutDashboard,
  ListChecks,
  LoaderCircle,
  Mic2,
  PackageCheck,
  Pause,
  Play,
  Radio,
  ReceiptText,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  ShoppingBag,
  Square,
  UserCheck,
  Volume2,
  WalletCards,
} from 'lucide-react';
import type {
  BackupIntegrity,
  BackupSummary,
  KnowledgeItem,
  LiveSession,
  OfferSnapshot,
  OrderOutcome,
  ResponseEvaluationResult,
  RestoreResult,
  RunSheetSegment,
} from '@liveops/live-contracts';
import { api, type AuditEntry, type BootstrapData, type StoredEvidenceFile } from '../api.js';
import { createLiveChannel } from '../broadcast.js';
import { CatMark } from '../components/Icons.js';
import { CheckIcon, StateBadge } from '../components/Status.js';
import { selectCurrentOffer } from '../lib/offers.js';
import { ActivationGate } from './ActivationGate.js';
import { Onboarding } from './Onboarding.js';

type Page = 'overview' | 'director' | 'qa' | 'orders' | 'preflight' | 'audit' | 'backups';
type Notice = { tone: 'success' | 'error' | 'info'; message: string } | null;

/** 新手引导「已看过」的本地标记（每台电脑记一次，可手动重新打开） */
const GUIDE_SEEN_KEY = 'liveops-guide-seen-v1';

const NAV_ITEMS: Array<{ id: Page; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'overview', label: '今日开播', icon: LayoutDashboard },
  { id: 'director', label: '直播流程', icon: Radio },
  { id: 'qa', label: '顾客问答', icon: ShieldCheck },
  { id: 'orders', label: '经营记录', icon: ReceiptText },
  { id: 'preflight', label: '开播准备', icon: ClipboardCheck },
  { id: 'audit', label: '操作日志', icon: History },
  { id: 'backups', label: '数据备份', icon: DatabaseBackup },
];

function formatMoney(value: number | null): string {
  return value === null ? '数据未取得' : `¥${(value / 100).toFixed(2)}`;
}

function formatTime(value: string | null): string {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未记录';
}

function shortState(state: string): string {
  const labels: Record<string, string> = {
    DRAFT: '草稿', PREFLIGHT_BLOCKED: '开播准备中', READY: '本地就绪', LIVE: '直播中',
    PAUSED: 'AI已暂停', STOPPED: '已停止', COMPLETED: '已完成',
  };
  return labels[state] ?? state;
}

export function ControlApp() {
  const channelRef = useRef<BroadcastChannel | null>(null);
  const rehearsalRef = useRef<number | null>(null);
  const [page, setPage] = useState<Page>('overview');
  const [data, setData] = useState<BootstrapData | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [rehearsing, setRehearsing] = useState(false);
  const [activeSegment, setActiveSegment] = useState(0);
  const [question, setQuestion] = useState('');
  const [evaluation, setEvaluation] = useState<ResponseEvaluationResult | null>(null);
  const [voiceTestPending, setVoiceTestPending] = useState(false);
  const [voiceTestGenerated, setVoiceTestGenerated] = useState(false);
  const [showGuide, setShowGuide] = useState(false);

  // 首次进入值班台（完成初始化向导后）弹出新手引导；关掉后记住，可随时从任务清单重新打开
  useEffect(() => {
    if (data?.config.onboardingCompleted && !window.localStorage.getItem(GUIDE_SEEN_KEY)) {
      setShowGuide(true);
    }
  }, [data?.config.onboardingCompleted]);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const result = await api.bootstrap();
      setData(result);
      const activeOffer = selectCurrentOffer(result.offers);
      channelRef.current?.postMessage({
        type: 'state',
        state: result.session?.state ?? 'PREFLIGHT_BLOCKED',
        offerTitle: activeOffer?.title ?? null,
        priceCents: activeOffer?.priceCents ?? null,
      });
      const nextState = result.session?.state ?? 'PREFLIGHT_BLOCKED';
      if (['PAUSED', 'STOPPED', 'COMPLETED'].includes(nextState) && rehearsalRef.current) {
        stopRehearsal(result.session?.stopReason ?? '场次安全状态已停止AI播报');
      }
    } catch (error) {
      if (rehearsalRef.current) stopRehearsal('本地服务中断，演练已停止；恢复后需要员工重新启动');
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : '本地服务暂时不可用' });
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    channelRef.current = createLiveChannel();
    channelRef.current.onmessage = (event) => {
      const message = event.data as { type?: string; generated?: boolean; voiceName?: string | null };
      if (message.type !== 'voice-test-result') return;
      setVoiceTestPending(false);
      setVoiceTestGenerated(message.generated === true);
      if (!message.generated) void api.updateHardware({ voiceReady: false }).then(() => refresh(true));
      setNotice(message.generated
        ? { tone: 'info', message: `系统已播放中文试听：${message.voiceName ?? '系统中文语音'}。请由值班员工确认确实听见且输出线路正确。` }
        : { tone: 'error', message: '本机没有可用中文语音，AI 播报暂时无法使用。' });
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(true), 30_000);
    return () => {
      window.clearInterval(interval);
      channelRef.current?.close();
      if (rehearsalRef.current) window.clearInterval(rehearsalRef.current);
    };
  }, [refresh]);

  useEffect(() => {
    if (page === 'audit') void api.audit().then(setAudit).catch((error: unknown) => {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : '操作日志读取失败' });
    });
  }, [page]);

  const activeOffer = useMemo(
    () => selectCurrentOffer(data?.offers ?? []),
    [data?.offers],
  );

  async function announceSegment(index: number) {
    const segment = data?.runSheet[index];
    if (!segment || !segment.approved) {
      setNotice({ tone: 'error', message: '该段话术缺少有效证据，不能进入播报。' });
      return false;
    }
    try {
      const authorized = await api.authorizeRunSheet(segment.script);
      setActiveSegment(index);
      channelRef.current?.postMessage({ type: 'scene', scene: authorized.scene });
      channelRef.current?.postMessage({ type: 'speak', text: authorized.script, source: 'AUTO', mode: 'REHEARSAL', id: segment.id });
      return true;
    } catch (error) {
      stopRehearsal(error instanceof Error ? error.message : '话术重新校验失败，演练已停止');
      return false;
    }
  }

  function stopRehearsal(reason: string) {
    if (rehearsalRef.current) window.clearInterval(rehearsalRef.current);
    rehearsalRef.current = null;
    setRehearsing(false);
    channelRef.current?.postMessage({ type: 'stop-speech', reason });
  }

  function toggleRehearsal() {
    if (rehearsing) {
      stopRehearsal('本地演练已停止');
      return;
    }
    if (!data?.runSheet.some((segment) => segment.approved)) {
      setNotice({ tone: 'error', message: '没有可演练的已批准话术。' });
      return;
    }
    setRehearsing(true);
    void announceSegment(activeSegment);
    rehearsalRef.current = window.setInterval(() => {
      setActiveSegment((current) => {
        const last = (data?.runSheet.length ?? 1) - 1;
        if (current >= last) {
          window.setTimeout(() => stopRehearsal('两小时流程演练已完成，系统不会自动循环'), 0);
          return current;
        }
        const next = current + 1;
        window.setTimeout(() => void announceSegment(next), 0);
        return next;
      });
    }, 120_000);
  }

  async function createSession() {
    setWorking(true);
    try {
      await api.createSession();
      await refresh(true);
      setNotice({ tone: 'success', message: '今晚场次已建立；正式开播前仍需完成开播准备。' });
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : '建立场次失败' });
    } finally {
      setWorking(false);
    }
  }

  async function acknowledgePresence() {
    if (!data?.session) return;
    setWorking(true);
    try {
      const session = await api.acknowledgePresence(data.session.id);
      setData((current) => current ? { ...current, session } : current);
      channelRef.current?.postMessage({ type: 'presence', acknowledgedAt: session.lastPresenceAt });
      setNotice({ tone: 'success', message: '在场确认已记录。' });
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : '在场确认失败' });
    } finally {
      setWorking(false);
    }
  }

  async function transition(state: LiveSession['state'], reason: string | null, externalStartConfirmed = false) {
    if (!data?.session) return;
    setWorking(true);
    try {
      const session = await api.transition(data.session.id, state, reason, externalStartConfirmed);
      setData((current) => current ? { ...current, session } : current);
      channelRef.current?.postMessage({
        type: 'state', state: session.state, offerTitle: activeOffer?.title ?? null, priceCents: activeOffer?.priceCents ?? null,
      });
      if (['PAUSED', 'STOPPED', 'COMPLETED'].includes(state)) {
        channelRef.current?.postMessage({ type: 'stop-speech', reason: reason ?? `AI播报${shortState(state)}` });
      }
      setNotice({ tone: 'success', message: `场次状态已更新为“${shortState(state)}”。` });
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : '状态更新失败' });
    } finally {
      setWorking(false);
    }
  }

  async function useKnowledge(item: KnowledgeItem) {
    setWorking(true);
    try {
      const result = await api.evaluate({ knowledgeItemId: item.id, question: question.trim(), proposedAnswer: item.answer });
      setEvaluation(result);
      if (result.decision === 'AUTO_ALLOWED' && result.safeAnswer) {
        channelRef.current?.postMessage({ type: 'scene', scene: 'Q_AND_A' });
        channelRef.current?.postMessage({ type: 'speak', text: result.safeAnswer, source: 'AUTO', mode: data?.session?.state === 'LIVE' ? 'LIVE' : 'REHEARSAL', id: crypto.randomUUID() });
        setNotice({ tone: 'success', message: '白名单答案已送往直播输出窗口。' });
      }
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : '问答判断失败' });
    } finally {
      setWorking(false);
    }
  }

  function testVoice() {
    setVoiceTestGenerated(false);
    setVoiceTestPending(true);
    void api.updateHardware({ voiceReady: false }).then(() => refresh(true));
    channelRef.current?.postMessage({ type: 'voice-test', id: crypto.randomUUID() });
    window.setTimeout(() => {
      setVoiceTestPending((pending) => {
        if (pending) setNotice({ tone: 'error', message: '直播输出窗口没有返回语音试听结果，请重试或检查输出窗口是否打开。' });
        return false;
      });
    }, 8_000);
  }

  async function confirmVoiceHeard() {
    if (!voiceTestGenerated) return;
    await api.updateHardware({ voiceReady: true });
    setVoiceTestGenerated(false);
    await refresh(true);
    setNotice({ tone: 'success', message: '值班员工已确认听见中文试听且直播输出线路正确。' });
  }

  async function evaluateFreeQuestion() {
    setWorking(true);
    try {
      const result = await api.evaluate({ knowledgeItemId: null, question, proposedAnswer: '' });
      setEvaluation(result);
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : '问答判断失败' });
    } finally {
      setWorking(false);
    }
  }

  if (loading || !data) {
    return (
      <main className="loading-screen">
        <CatMark />
        <LoaderCircle className="spin" aria-hidden="true" />
        <strong>正在打开今晚值班台</strong>
        <span>只连接本机服务，不访问抖音账号</span>
      </main>
    );
  }

  // 未激活：先完成离线授权（授权码绑机器码，防复制传播）
  if (!data.activation.activated) {
    return <ActivationGate machineId={data.activation.machineId} onActivated={() => void refresh()} />;
  }

  // 首次启动：未完成初始化向导前，先填写品牌/服务范围/类目（门禁保持 BLOCKED）
  if (!data.config.onboardingCompleted) {
    return <Onboarding onCompleted={() => void refresh()} />;
  }

  const passedChecks = data.preflight.checks.filter((check) => check.status === 'PASS').length;
  const state = data.session?.state ?? 'PREFLIGHT_BLOCKED';

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <CatMark />
          <div><strong>实景直播</strong><span>经营系统</span></div>
        </div>
        <nav aria-label="主要功能">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.id} className={page === item.id ? 'active' : ''} type="button" onClick={() => setPage(item.id)}>
                <Icon aria-hidden="true" />
                <span>{item.label}</span>
                {item.id === 'preflight' && data.preflight.blocked && <i className="nav-alert" />}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-guard">
          <ShieldAlert aria-hidden="true" />
          <strong>人工平台适配器</strong>
          <span>不登录、不抓取、不模拟点击</span>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div>
            <h1>{NAV_ITEMS.find((item) => item.id === page)?.label}</h1>
            <p>{pageSubtitle(page)}</p>
          </div>
          <div className="topbar-actions">
            <StateBadge state={state} />
            <button className="icon-button" type="button" aria-label="刷新本地状态" onClick={() => void refresh()}>
              <RefreshCw aria-hidden="true" />
            </button>
          </div>
        </header>

        {notice && (
          <div className={`notice ${notice.tone}`} role="status">
            {notice.tone === 'success' ? <Check aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}
            <span>{notice.message}</span>
            <button type="button" onClick={() => setNotice(null)}>知道了</button>
          </div>
        )}

        {showGuide && (
          <GuideModal
            onClose={() => {
              window.localStorage.setItem(GUIDE_SEEN_KEY, '1');
              setShowGuide(false);
            }}
            onStart={setPage}
          />
        )}

        <section className="page-body">
          {page === 'overview' && (
            <Overview
              data={data}
              activeOffer={activeOffer}
              passedChecks={passedChecks}
              working={working}
              rehearsing={rehearsing}
              onCreate={() => void createSession()}
              onPresence={() => void acknowledgePresence()}
              onRehearsal={toggleRehearsal}
              onNavigate={setPage}
              onShowGuide={() => setShowGuide(true)}
            />
          )}
          {page === 'director' && (
            <Director
              segments={data.runSheet}
              activeIndex={activeSegment}
              rehearsing={rehearsing}
              onSelect={(index) => void announceSegment(index)}
              onToggle={toggleRehearsal}
            />
          )}
          {page === 'qa' && (
            <SafeQa
              knowledge={data.knowledge}
              question={question}
              evaluation={evaluation}
              working={working}
              onQuestion={setQuestion}
              onUse={(item) => void useKnowledge(item)}
              onEvaluate={() => void evaluateFreeQuestion()}
            />
          )}
          {page === 'orders' && (
            <Orders
              data={data}
              onSaved={async () => { await refresh(true); setNotice({ tone: 'success', message: '经营结果已保存为本地工作记录。' }); }}
              onError={(message) => setNotice({ tone: 'error', message })}
            />
          )}
          {page === 'preflight' && (
            <Preflight
              data={data}
              activeOffer={activeOffer}
              onRefresh={() => void refresh()}
              onHardware={async (input) => { await api.updateHardware(input); await refresh(true); }}
              onVoiceTest={testVoice}
              voiceTestPending={voiceTestPending}
              voiceTestGenerated={voiceTestGenerated}
              onVoiceConfirm={() => void confirmVoiceHeard()}
              onOfferSaved={async () => { await refresh(true); setNotice({ tone: 'success', message: '商品快照已保存；开播准备没完成前仍不能正式开播。' }); }}
              onError={(message) => setNotice({ tone: 'error', message })}
              onTransition={(next, reason, confirmed) => void transition(next, reason, confirmed)}
            />
          )}
          {page === 'audit' && <Audit entries={audit} />}
          {page === 'backups' && <Backups sessionState={state} onNotice={setNotice} />}
        </section>
      </div>
    </div>
  );
}

function pageSubtitle(page: Page): string {
  const subtitles: Record<Page, string> = {
    overview: '跟着「开播任务」一步一步来，做完一项打勾一项。',
    director: '两小时直播流程；只有准备妥当的段落才能播报。',
    qa: '顾客常见问题自动回答，拿不准的交给员工。',
    orders: '记录每一笔订单从付款到履约、成本和复购。',
    preflight: '正式开播前要完成的准备；缺一项就不能开播。',
    audit: '所有操作和经营记录都能查得到。',
    backups: '经营数据和证据的本地备份；恢复前先校验、自动留底。',
  };
  return subtitles[page];
}

function Overview({ data, activeOffer, passedChecks, working, rehearsing, onCreate, onPresence, onRehearsal, onNavigate, onShowGuide }: {
  data: BootstrapData;
  activeOffer: OfferSnapshot | null;
  passedChecks: number;
  working: boolean;
  rehearsing: boolean;
  onCreate: () => void;
  onPresence: () => void;
  onRehearsal: () => void;
  onNavigate: (page: Page) => void;
  onShowGuide: () => void;
}) {
  const session = data.session;
  const tasks = buildTasks(data, activeOffer);
  const doneCount = tasks.filter((task) => task.status === 'done').length;
  return (
    <div className="overview-grid">
      <section className="task-checklist">
        <div className="task-heading">
          <div>
            <span className="task-kicker">开播任务 · 跟着做就不会迷路</span>
            <h2>从 0 到开播，还有 {tasks.length - doneCount} 件事要做</h2>
          </div>
          <span className="task-count">{doneCount}/{tasks.length} 已完成</span>
          <button type="button" className="task-guide-link" onClick={onShowGuide}>重新看引导</button>
        </div>
        <div className="task-list">
          {tasks.map((task, index) => (
            <button
              type="button"
              key={task.id}
              className={`task-item ${task.status}`}
              onClick={() => onNavigate(task.page)}
            >
              <span className="task-num">{String(index + 1).padStart(2, '0')}</span>
              <span className="task-icon" aria-hidden="true">{task.status === 'done' ? <Check /> : task.status === 'blocked' ? <CircleAlert /> : <ChevronRight />}</span>
              <span className="task-main">
                <strong>{task.label}</strong>
                <small>{task.how}</small>
              </span>
              <span className="task-state">{taskStateLabel(task)}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="shift-board">
        <div className="shift-heading">
          <div>
            <span className="shift-date">{new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}</span>
            <h2>今晚 20:00–22:00</h2>
            <p>一人作业兼监护 · 真人不露脸 · 自然流量</p>
          </div>
          <StateBadge state={session?.state ?? 'PREFLIGHT_BLOCKED'} />
        </div>

        <div className="workbench-preview">
          <div className="preview-gridline" />
          <div className="preview-center">
            <Camera aria-hidden="true" />
            <strong>9:16 实景预览</strong>
            <span>请在右侧直播输出窗口选择俯拍摄像头</span>
          </div>
          <div className="preview-tags">
            <span><Bot aria-hidden="true" /> AI主持</span>
            <span><UserCheck aria-hidden="true" /> 真人监护</span>
            <span><ShieldCheck aria-hidden="true" /> 白名单问答</span>
          </div>
        </div>

        <div className="shift-actions">
          {(!session || ['STOPPED', 'COMPLETED'].includes(session.state)) && (
            <button className="secondary-action" type="button" onClick={onCreate} disabled={working}>
              <ClipboardCheck aria-hidden="true" />建立内部演练场次
            </button>
          )}
          {session?.state === 'LIVE' && (
            <button className="primary-action" type="button" onClick={onPresence} disabled={working}>
              <UserCheck aria-hidden="true" />我在现场
            </button>
          )}
          {(data.preflight.blocked || data.preflight.manualRequired) && (
            <button className="primary-action" type="button" onClick={() => onNavigate('preflight')}>
              <ShieldCheck aria-hidden="true" />继续完成开播准备 {passedChecks}/{data.preflight.checks.length}
            </button>
          )}
          <button className={rehearsing ? 'danger-action' : 'secondary-action'} type="button" onClick={onRehearsal}>
            {rehearsing ? <Square aria-hidden="true" /> : <Play aria-hidden="true" />}
            {rehearsing ? '停止本地演练' : '开始本地演练'}
          </button>
          <span className="action-note">演练不会登录或启动抖音直播</span>
        </div>
      </section>

      <aside className="right-rail">
        <section className="rail-section">
          <div className="rail-title"><ListChecks aria-hidden="true" /><strong>开播准备</strong><span>{passedChecks}/{data.preflight.checks.length}</span></div>
          <div className="compact-checks">
            {data.preflight.checks.slice(0, 5).map((check) => (
              <button type="button" key={check.id} onClick={() => onNavigate('preflight')}>
                <CheckIcon status={check.status} />
                <span><strong>{check.label}</strong><small>{check.detail}</small></span>
                <ChevronRight aria-hidden="true" />
              </button>
            ))}
          </div>
          <button className="text-link" type="button" onClick={() => onNavigate('preflight')}>查看全部开播准备</button>
        </section>

        <section className="rail-section offer-ticket">
          <div className="rail-title"><ShoppingBag aria-hidden="true" /><strong>今晚商品</strong></div>
          {activeOffer ? (
            <>
              <span className="ticket-label">已冻结快照</span>
              <h3>{activeOffer.title}</h3>
              <div className="ticket-price">¥{(activeOffer.priceCents / 100).toFixed(2)}</div>
              <p>{activeOffer.shoeTypes.join('、')}</p>
              <small>有效至 {formatTime(activeOffer.validUntil)}</small>
            </>
          ) : (
            <div className="empty-compact"><PackageCheck aria-hidden="true" /><strong>没有有效商品快照</strong><span>直播画面不会播报价格</span></div>
          )}
        </section>

        <section className="rail-section presence-ticket">
          <div className="rail-title"><Activity aria-hidden="true" /><strong>员工在场</strong></div>
          <div className="presence-time">{session?.lastPresenceAt ? new Date(session.lastPresenceAt).toLocaleTimeString('zh-CN', { hour12: false }) : '尚未确认'}</div>
          <p>每5分钟确认一次，连续两次未确认会暂停AI。</p>
        </section>
      </aside>

      <section className="business-strip">
        <Metric icon={ReceiptText} label="完成履约" value={`${data.report.completedOrders} / 30`} detail="已付款、已履约、已完成" />
        <Metric icon={RefreshCw} label="30天正常价复购" value={`${data.report.repeatOrders} / 3`} detail="从首次完成履约起计算" />
        <Metric icon={WalletCards} label="批次贡献" value={formatMoney(data.report.contributionCents)} detail={data.report.contributionCents === null ? '有收入或成本尚未取得' : '已计入完整成本字段'} />
        <Metric icon={ShieldAlert} label="获客亏损超限" value={`${data.report.acquisitionLossBreaches + data.report.dailyLossPoolBreaches + data.report.monthlyLossPoolBreaches} 项`} detail="单笔10元、每日200元、每月3000元" />
      </section>
    </div>
  );
}

type TaskStatus = 'done' | 'todo' | 'ready' | 'blocked';

interface TaskItem {
  id: string;
  label: string;
  how: string;
  status: TaskStatus;
  page: Page;
}

/** 首页「开播任务」清单：从 0 到开播的 6 件事，每件写明怎么做、做到哪、点哪进入 */
function buildTasks(data: BootstrapData, activeOffer: OfferSnapshot | null): TaskItem[] {
  const statusById = new Map(data.preflight.checks.map((check) => [check.id, check.status]));
  const evidenceDone = ['official-written', 'cost', 'asset'].every((id) => statusById.get(id) === 'PASS');
  const hardwareDone = data.hardware.cameraReady && data.hardware.voiceReady && data.hardware.takeoverReady;
  const rehearsalReady = data.runSheet.some((segment) => segment.approved);
  const canGoLive = !data.preflight.blocked && !data.preflight.manualRequired;

  return [
    {
      id: 'store-info',
      label: '填写店铺信息',
      how: data.config.onboardingCompleted ? '已填写：品牌名、服务范围、商品类目' : '填写品牌名、服务范围与商品类目，用于输出画面与商品快照',
      status: data.config.onboardingCompleted ? 'done' : 'todo',
      page: 'overview',
    },
    {
      id: 'offer',
      label: '录入你的商品',
      how: activeOffer ? `已冻结商品快照：${activeOffer.title}（¥${(activeOffer.priceCents / 100).toFixed(2)}）` : '到「开播准备」导入商品快照：填商品ID、价格，上传商户商品来源证据',
      status: activeOffer ? 'done' : 'todo',
      page: 'preflight',
    },
    {
      id: 'hardware',
      label: '确认本机设备',
      how: hardwareDone ? '摄像头（不露脸）、中文语音、真人接管都已确认' : '打开直播输出窗口：选俯拍摄像头不露脸、试听中文语音、确认真人声音可接管',
      status: hardwareDone ? 'done' : 'todo',
      page: 'preflight',
    },
    {
      id: 'evidence',
      label: '补齐开播证据',
      how: evidenceDone ? '平台书面答复、成本记录、素材授权三份证据已齐全' : '需要三份材料：平台规则书面答复、完整成本记录、素材授权，在「开播准备」导入商品快照时上传',
      status: evidenceDone ? 'done' : 'todo',
      page: 'preflight',
    },
    {
      id: 'rehearsal',
      label: '本地演练一遍',
      how: rehearsalReady ? '在「直播流程」点「开始演练」，AI 按两小时流程播报，检查声音和字幕' : '需要先完成商品与证据准备，流程话术就绪后即可演练',
      status: rehearsalReady ? 'ready' : 'blocked',
      page: 'director',
    },
    {
      id: 'go-live',
      label: '正式开播',
      how: canGoLive ? '所有准备完成！在抖音直播伴侣人工开播后，回「开播准备」点「我已在直播伴侣人工开播」' : '前面准备全部完成后，这里才会解锁',
      status: canGoLive ? 'ready' : 'blocked',
      page: 'preflight',
    },
  ];
}

function taskStateLabel(task: TaskItem): string {
  if (task.status === 'done') return '已完成';
  if (task.status === 'ready') return '可以开始';
  if (task.status === 'blocked') return '准备中';
  return '待完成';
}

function GuideModal({ onClose, onStart }: { onClose: () => void; onStart: (page: Page) => void }) {
  return (
    <div className="guide-overlay" onClick={onClose}>
      <div className="guide-modal" onClick={(event) => event.stopPropagation()}>
        <h2>欢迎使用实景直播经营系统</h2>
        <p>这套工具帮你把「真实工作台」直播出去：AI 主持播报、真人监护、问答有把关。从 0 到开播，跟着 6 步走：</p>
        <ol className="guide-steps">
          <li><b>填写店铺信息</b><span>品牌名、服务范围、商品类目（你已完成）</span></li>
          <li><b>录入你的商品</b><span>在「开播准备」导入商品快照，填价格并上传来源证据</span></li>
          <li><b>确认本机设备</b><span>摄像头画面不露脸、中文语音能听见、真人声音可接管</span></li>
          <li><b>补齐开播证据</b><span>平台规则书面答复、完整成本、素材授权三份材料</span></li>
          <li><b>本地演练一遍</b><span>在「直播流程」试听 AI 两小时播报，检查声音和字幕</span></li>
          <li><b>正式开播</b><span>全部准备完成后，再上抖音直播伴侣人工开播</span></li>
        </ol>
        <p className="guide-note">首页的「开播任务」清单会一直提醒你做到哪一步，做完自动打勾；看不懂随时点「重新看引导」。</p>
        <div className="guide-actions">
          <button className="primary-action" type="button" onClick={() => { onStart('preflight'); onClose(); }}>带我去看开播准备</button>
          <button className="secondary-action" type="button" onClick={onClose}>先逛逛</button>
        </div>
      </div>
    </div>
  );
}

function Metric({ icon: Icon, label, value, detail }: { icon: typeof ReceiptText; label: string; value: string; detail: string }) {
  return <div className="metric"><Icon aria-hidden="true" /><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

function Director({ segments, activeIndex, rehearsing, onSelect, onToggle }: {
  segments: RunSheetSegment[];
  activeIndex: number;
  rehearsing: boolean;
  onSelect: (index: number) => void;
  onToggle: () => void;
}) {
  const active = segments[activeIndex];
  const sceneLabels: Record<RunSheetSegment['scene'], string> = {
    WORKBENCH: '真实作业台', PROCESS_CLOSEUP: '工序特写', SERVICE_FACTS: '服务说明', Q_AND_A: '顾客问答', OFFER: '商品提示',
  };
  return (
    <div className="director-layout">
      <section className="director-current">
        <div className="director-toolbar">
          <div><span>当前段落 {activeIndex + 1} / {segments.length}</span><strong>{active?.title ?? '没有话术'}</strong></div>
          <button className={rehearsing ? 'danger-action' : 'primary-action'} type="button" onClick={onToggle}>
            {rehearsing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
            {rehearsing ? '暂停演练' : '从当前段演练'}
          </button>
        </div>
        <div className="script-paper">
          <div className="script-meta">
            <span>{active ? sceneLabels[active.scene] : '真实作业台'}</span>
            <span>约 {active?.durationSeconds ?? 0} 秒</span>
            <span className={active?.approved ? 'approved' : 'blocked'}>{active?.approved ? '证据有效' : '禁止播报'}</span>
          </div>
          <p>{active?.script ?? '尚未生成已批准的两小时流程表。'}</p>
          <div className="evidence-line"><BookOpenCheck aria-hidden="true" />引用 {active?.evidenceRefs.length ?? 0} 份证据</div>
        </div>
        <div className="director-controls">
          <button type="button" disabled={activeIndex === 0} onClick={() => onSelect(Math.max(0, activeIndex - 1))}>上一段</button>
          <button type="button" disabled={!active?.approved} onClick={() => onSelect(activeIndex)}><Volume2 aria-hidden="true" />只播这一段</button>
          <button type="button" disabled={activeIndex >= segments.length - 1} onClick={() => onSelect(Math.min(segments.length - 1, activeIndex + 1))}>下一段</button>
        </div>
      </section>
      <aside className="run-sheet-list">
        <div className="run-sheet-heading"><FileClock aria-hidden="true" /><div><strong>两小时流程表</strong><span>60段 × 2分钟，不使用单段循环</span></div></div>
        <div className="run-sheet-scroll">
          {segments.map((segment, index) => (
            <button key={segment.id} type="button" className={activeIndex === index ? 'active' : ''} onClick={() => setActiveOrBlocked(segment, index, onSelect)}>
              <span className="run-index">{String(index + 1).padStart(2, '0')}</span>
              <span><strong>{segment.title}</strong><small>{sceneLabels[segment.scene]}</small></span>
              {segment.approved ? <Check aria-hidden="true" /> : <ShieldAlert aria-hidden="true" />}
            </button>
          ))}
        </div>
      </aside>
    </div>
  );
}

function setActiveOrBlocked(segment: RunSheetSegment, index: number, onSelect: (index: number) => void) {
  if (segment.approved) onSelect(index);
}

function SafeQa({ knowledge, question, evaluation, working, onQuestion, onUse, onEvaluate }: {
  knowledge: KnowledgeItem[];
  question: string;
  evaluation: ResponseEvaluationResult | null;
  working: boolean;
  onQuestion: (value: string) => void;
  onUse: (item: KnowledgeItem) => void;
  onEvaluate: () => void;
}) {
  return (
    <div className="qa-layout">
      <section className="question-panel">
        <div className="panel-heading"><Headphones aria-hidden="true" /><div><h2>顾客刚刚问了什么？</h2><p>不要输入姓名、完整电话或订单号；系统仍会自动隐藏常见隐私。</p></div></div>
        <textarea value={question} onChange={(event) => onQuestion(event.target.value)} maxLength={300} placeholder="例如：这个服务多久能完成？" />
        <div className="question-actions"><span>{question.length}/300</span><button className="secondary-action" type="button" onClick={onEvaluate} disabled={working || !question.trim()}><ShieldCheck aria-hidden="true" />先判断风险</button></div>

        {evaluation && (
          <div className={`evaluation ${evaluation.decision.toLowerCase()}`}>
            {evaluation.decision === 'AUTO_ALLOWED' ? <ShieldCheck aria-hidden="true" /> : evaluation.decision === 'BLOCKED' ? <ShieldAlert aria-hidden="true" /> : <Hand aria-hidden="true" />}
            <div>
              <strong>{evaluation.decision === 'AUTO_ALLOWED' ? '允许自动播报' : evaluation.decision === 'BLOCKED' ? '禁止播报' : '需要员工确认'}</strong>
              <p>{evaluation.reasons.join('；')}</p>
              {evaluation.redactedQuestion && <small>已处理问题：{evaluation.redactedQuestion}</small>}
            </div>
          </div>
        )}
      </section>

      <section className="answer-board">
        <div className="panel-heading"><BookOpenCheck aria-hidden="true" /><div><h2>标准回答</h2><p>点击后系统仍会重新检查证据、有效期和禁止表达。</p></div></div>
        <div className="answer-list">
          {knowledge.map((item) => (
            <article key={item.id} className={`answer-row ${item.risk.toLowerCase()}`}>
              <div className="answer-main">
                <div className="answer-tags"><span>{item.label}</span><span>{item.risk === 'LOW' ? '低风险' : item.risk === 'MEDIUM' ? '需留意' : '高风险'}</span></div>
                <p>{item.answer}</p>
                <small>有效至 {formatTime(item.validUntil)} · {item.evidenceRefs.length}份证据</small>
              </div>
              <button type="button" className={item.decision === 'AUTO_ALLOWED' ? 'speak-button' : 'human-button'} onClick={() => onUse(item)} disabled={working}>
                {item.decision === 'AUTO_ALLOWED' ? <Volume2 aria-hidden="true" /> : <Hand aria-hidden="true" />}
                {item.decision === 'AUTO_ALLOWED' ? '安全播报' : '交给员工'}
              </button>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function Orders({ data, onSaved, onError }: {
  data: BootstrapData;
  onSaved: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [showForm, setShowForm] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [costEvidence, setCostEvidence] = useState<StoredEvidenceFile | null>(null);
  const [newCustomerEvidence, setNewCustomerEvidence] = useState<StoredEvidenceFile | null>(null);
  const completedSessions = data.sessions.filter((session) => session.startedAt && session.endedAt && ['STOPPED', 'COMPLETED'].includes(session.state));
  const [form, setForm] = useState({
    liveSessionId: '', externalRef: '', customerRef: '', firstPaidAt: '', pickedUpAt: '', firstNet: '', repeatNet: '', repeatPrice: '', platformFee: '', pickup: '', production: '', material: '', liveLabor: '', rework: '', compensation: '', equipment: '', software: '', completed: false, refunded: false, repeat: false, completedAt: '', refundedAt: '', repeatPaidAt: '', sourceTitle: '', newCustomerConfirmed: false, privacyConfirmed: false,
  });

  async function submit() {
    if (!form.externalRef.trim() || !form.customerRef.trim() || !form.sourceTitle.trim()) return onError('请填写订单标识、稳定顾客标识和数据来源标题。');
    const linkedSession = completedSessions.find((session) => session.id === form.liveSessionId);
    if (!linkedSession) return onError('请选择一场已经结束且有真实起止时间的直播。');
    const linkedOffer = data.offers.find((offer) => offer.id === linkedSession.offerSnapshotId);
    if (!linkedOffer) return onError('所选直播场次缺少当时冻结的商品快照，不能记录经营结果。');
    if (!form.firstPaidAt) return onError('必须填写真实首单付款时间。');
    if (form.completed && !form.pickedUpAt) return onError('已完成订单必须填写真实履约时间。');
    if (!costEvidence) return onError('请选择并保全本笔经营记录的结算或成本证据文件。');
    if (!form.newCustomerConfirmed || !newCustomerEvidence) return onError('必须人工核对平台历史订单，并保全已脱敏的新客核对证据。');
    if (!form.privacyConfirmed) return onError('请先确认两份证据文件均已移除姓名、电话、地址、头像、订单号和券码。');
    if (form.completed && !form.completedAt) return onError('已完成订单必须填写实际完成时间。');
    if (form.repeat && !form.repeatPaidAt) return onError('正常价复购必须填写实际复购付款时间。');
    if (form.repeat && !form.repeatPrice.trim()) return onError('正常价复购必须填写实际成交价。');
    if (form.refunded && !form.refundedAt) return onError('已退款订单必须填写实际退款时间。');
    setSaving(true);
    try {
      const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(form.externalRef.trim()));
      const externalRefHash = Array.from(new Uint8Array(hashBuffer)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
      const customerHashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(form.customerRef.trim()));
      const customerRefHash = Array.from(new Uint8Array(customerHashBuffer)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
      const cents = (value: string) => value.trim() === '' ? null : Math.round(Number(value) * 100);
      const timestamp = new Date().toISOString();
      const completedAt = form.completed ? new Date(form.completedAt).toISOString() : null;
      const firstPaidAt = new Date(form.firstPaidAt).toISOString();
      const pickedUpAt = form.pickedUpAt ? new Date(form.pickedUpAt).toISOString() : null;
      const repeatPaidAt = form.repeat ? new Date(form.repeatPaidAt).toISOString() : null;
      const order: OrderOutcome = {
        id: crypto.randomUUID(), externalRefHash, customerRefHash, newCustomerConfirmed: form.newCustomerConfirmed,
        offerSnapshotId: linkedOffer.id, liveSessionId: linkedSession.id, firstPaidAt,
        pickedUpAt, completedAt,
        refundedAt: form.refunded ? new Date(form.refundedAt).toISOString() : null, repeatPaidAt, repeatAtRegularPrice: form.repeat,
        repeatPriceCents: form.repeat ? cents(form.repeatPrice) : null,
        firstNetSettlementCents: cents(form.firstNet), repeatNetSettlementCents: form.repeat ? cents(form.repeatNet) : null,
        platformFeeCents: cents(form.platformFee), pickupDeliveryCostCents: cents(form.pickup), productionLaborCostCents: cents(form.production),
        materialCostCents: cents(form.material), liveLaborCostCents: cents(form.liveLabor), reworkCostCents: cents(form.rework),
        compensationCostCents: cents(form.compensation), equipmentCostCents: cents(form.equipment), softwareCostCents: cents(form.software),
        evidenceRefs: [
          { id: costEvidence.id, title: form.sourceTitle.trim(), sourceType: 'COST_RECORD', sourceUri: costEvidence.sourceUri, capturedAt: timestamp, validUntil: new Date(Date.now() + 365 * 86_400_000).toISOString(), sha256: costEvidence.sha256 },
          { id: newCustomerEvidence.id, title: '已脱敏的新客历史核对记录', sourceType: 'MERCHANT_RECORD', sourceUri: newCustomerEvidence.sourceUri, capturedAt: timestamp, validUntil: new Date(Date.now() + 365 * 86_400_000).toISOString(), sha256: newCustomerEvidence.sha256 },
        ],
        createdAt: timestamp, updatedAt: timestamp,
      };
      await api.saveOrder(order);
      setShowForm(false);
      setForm({ liveSessionId: '', externalRef: '', customerRef: '', firstPaidAt: '', pickedUpAt: '', firstNet: '', repeatNet: '', repeatPrice: '', platformFee: '', pickup: '', production: '', material: '', liveLabor: '', rework: '', compensation: '', equipment: '', software: '', completed: false, refunded: false, repeat: false, completedAt: '', refundedAt: '', repeatPaidAt: '', sourceTitle: '', newCustomerConfirmed: false, privacyConfirmed: false });
      setCostEvidence(null);
      setNewCustomerEvidence(null);
      await onSaved();
    } catch (error) {
      onError(error instanceof Error ? error.message : '经营结果保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function exportReviewBundle() {
    setExporting(true);
    try {
      const bundle = await api.exportCohort();
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `实景直播经营复核包-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      onError(error instanceof Error ? error.message : '复核包导出失败');
    } finally {
      setExporting(false);
    }
  }

  const fields = [
    ['firstNet', '首单平台净结算（已扣平台费）'], ['repeatNet', '正常价复购净结算（仅复购指标）'], ['repeatPrice', '正常价复购实际成交价'], ['platformFee', '平台扣费（只审计，不重复扣）'], ['pickup', '取送成本'], ['production', '生产人工'],
    ['material', '耗材成本'], ['liveLabor', '直播值守'], ['rework', '返工成本'], ['compensation', '赔偿成本'],
    ['equipment', '设备折旧'], ['software', '软件成本'],
  ] as const;

  return (
    <div className="orders-layout">
      <section className="cohort-summary">
        <div className="panel-heading"><Gauge aria-hidden="true" /><div><h2>首轮30笔经营验证</h2><p>数据不全时不计算利润，也不把未知当成零。</p></div></div>
        <div className="cohort-bars">
          <Progress label="自然流量试播晚数" value={data.report.liveNights} goal={30} />
          <Progress label="累计试播小时" value={Math.round(data.report.liveMinutes / 60)} goal={60} />
          <Progress label="完成履约" value={data.report.completedOrders} goal={30} />
          <Progress label="正常价复购" value={data.report.repeatOrders} goal={3} />
          <Progress label="完整成本记录" value={data.report.completeCostOrders} goal={Math.max(30, data.report.completedOrders)} />
        </div>
        <div className={`profit-verdict ${data.report.qualifies ? 'pass' : 'waiting'}`}>
          {data.report.qualifies ? <ShieldCheck aria-hidden="true" /> : <FileClock aria-hidden="true" />}
          <div><strong>{data.report.quantitativeThresholdsMet ? '量化门槛待独立复核' : '尚不能判定赚钱'}</strong><p>{data.report.reasons.length ? data.report.reasons.join('；') : '仍需独立核对证据内容与经营归因。'}</p></div>
          <span>{formatMoney(data.report.contributionCents)}</span>
        </div>
      </section>

      <section className="order-ledger">
        <div className="ledger-heading"><div><h2>经营结果记录</h2><p>只保存本机SHA-256摘要标识，不保存原始顾客标识；证据文件必须先人工脱敏。</p></div><div className="ledger-actions"><button className="secondary-action" type="button" onClick={() => void exportReviewBundle()} disabled={exporting}><FileClock aria-hidden="true" />导出复核包</button><button className="primary-action" type="button" onClick={() => setShowForm((value) => !value)}><ReceiptText aria-hidden="true" />{showForm ? '收起录入' : '录入一笔'}</button></div></div>
        {showForm && (
          <div className="order-form">
            <label className="wide"><span>关联真实直播场次</span><select value={form.liveSessionId} onChange={(e) => setForm({ ...form, liveSessionId: e.target.value })}><option value="">请选择已经结束的场次</option>{completedSessions.map((session) => <option key={session.id} value={session.id}>{formatTime(session.startedAt)} · {Math.round((new Date(session.endedAt!).getTime() - new Date(session.startedAt!).getTime()) / 60_000)}分钟</option>)}</select></label>
            <label className="wide"><span>平台订单标识</span><input value={form.externalRef} onChange={(e) => setForm({ ...form, externalRef: e.target.value })} placeholder="保存前会在本机转为SHA-256摘要，原标识不保存" /></label>
            <label className="wide"><span>平台稳定顾客标识</span><input value={form.customerRef} onChange={(e) => setForm({ ...form, customerRef: e.target.value })} placeholder="仅用于去重，保存前转为SHA-256摘要" /></label>
            <label className="wide"><span>数据来源标题</span><input value={form.sourceTitle} onChange={(e) => setForm({ ...form, sourceTitle: e.target.value })} placeholder="例如：2026-08-14 抖音结算明细" /></label>
            <label className="check-field wide"><input type="checkbox" checked={form.privacyConfirmed} onChange={(e) => setForm({ ...form, privacyConfirmed: e.target.checked })} /><span>我已确认待上传文件不含完整姓名、电话、地址、头像、订单号、券码或聊天账号</span></label>
            <label className="wide evidence-file"><span>结算或成本证据文件（先脱敏）</span><input type="file" disabled={!form.privacyConfirmed} accept=".png,.jpg,.jpeg,.pdf,.txt,.json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void api.uploadEvidence(file, true).then(setCostEvidence).catch((error: unknown) => onError(error instanceof Error ? error.message : '证据文件保全失败')); }} /><small>{costEvidence ? `已保全 ${costEvidence.originalName} · 校验尾号 ${costEvidence.sha256.slice(-8)}` : '未选择文件，不会保存本笔记录'}</small></label>
            <label className="check-field wide"><input type="checkbox" checked={form.newCustomerConfirmed} onChange={(e) => setForm({ ...form, newCustomerConfirmed: e.target.checked })} /><span>我已在平台历史订单中人工核对：这是首次消费候选新客</span></label>
            <label className="wide evidence-file"><span>新客历史核对证据（必须脱敏）</span><input type="file" disabled={!form.privacyConfirmed || !form.newCustomerConfirmed} accept=".png,.jpg,.jpeg,.pdf,.txt,.json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void api.uploadEvidence(file, true).then(setNewCustomerEvidence).catch((error: unknown) => onError(error instanceof Error ? error.message : '新客证据保全失败')); }} /><small>{newCustomerEvidence ? `已保全 ${newCustomerEvidence.originalName} · 校验尾号 ${newCustomerEvidence.sha256.slice(-8)}` : '未选择新客核对证据，不计入候选新客'}</small></label>
            {fields.map(([key, label]) => <label key={key}><span>{label}（元）</span><input type="number" min="0" step="0.01" value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} placeholder="数据未取得" /></label>)}
            <label><span>真实首单付款时间</span><input type="datetime-local" value={form.firstPaidAt} onChange={(e) => setForm({ ...form, firstPaidAt: e.target.value })} /></label>
            <label><span>真实履约时间</span><input type="datetime-local" value={form.pickedUpAt} onChange={(e) => setForm({ ...form, pickedUpAt: e.target.value })} /></label>
            <label className="check-field"><input type="checkbox" checked={form.completed} onChange={(e) => setForm({ ...form, completed: e.target.checked })} /><span>已履约并完成服务</span></label>
            <label><span>实际完成时间</span><input type="datetime-local" value={form.completedAt} onChange={(e) => setForm({ ...form, completedAt: e.target.value })} disabled={!form.completed} /></label>
            <label className="check-field"><input type="checkbox" checked={form.refunded} onChange={(e) => setForm({ ...form, refunded: e.target.checked })} /><span>已经发生退款</span></label>
            <label><span>实际退款时间</span><input type="datetime-local" value={form.refundedAt} onChange={(e) => setForm({ ...form, refundedAt: e.target.value })} disabled={!form.refunded} /></label>
            <label className="check-field"><input type="checkbox" checked={form.repeat} onChange={(e) => setForm({ ...form, repeat: e.target.checked })} /><span>30天内正常价复购</span></label>
            <label><span>实际复购付款时间</span><input type="datetime-local" value={form.repeatPaidAt} onChange={(e) => setForm({ ...form, repeatPaidAt: e.target.value })} disabled={!form.repeat} /></label>
            <div className="form-actions wide"><button className="secondary-action" type="button" onClick={() => setShowForm(false)}>取消</button><button className="primary-action" type="button" onClick={() => void submit()} disabled={saving}>{saving ? <LoaderCircle className="spin" /> : <Check />}保存本地记录</button></div>
          </div>
        )}
        <div className="ledger-table" role="table" aria-label="经营结果列表">
          <div className="ledger-row ledger-header" role="row"><span>脱敏订单</span><span>付款</span><span>履约/完成</span><span>复购</span><span>数据口径</span></div>
          {data.orders.length === 0 ? <div className="empty-row"><ReceiptText aria-hidden="true" />还没有经营结果记录</div> : data.orders.map((order) => (
            <div className="ledger-row" role="row" key={order.id}><span>{order.externalRefHash.slice(0, 10)}…</span><span>{formatTime(order.firstPaidAt)}</span><span>{order.completedAt ? '已完成' : '未完成'}</span><span>{order.repeatPaidAt ? '已复购' : '未取得'}</span><span>{order.firstNetSettlementCents === null ? '成本未齐' : '有结算记录'}</span></div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Progress({ label, value, goal }: { label: string; value: number; goal: number }) {
  const ratio = Math.min(100, Math.round(value / Math.max(1, goal) * 100));
  return <div className="progress-row"><div><strong>{label}</strong><span>{value} / {goal}</span></div><div className="progress-track"><i style={{ width: `${ratio}%` }} /></div></div>;
}

/** 每项开播准备「怎么解决」的大白话指引（客户看得懂的步骤） */
const GATE_TIPS: Record<string, string> = {
  'official-written': '向抖音官方客服要一份书面答复（确认你的到店/上门取送口径、商品命名等），把答复截图保存 → 点上面「导入商品快照」，在「平台规则书面答复」里上传。',
  'service-area': '已在首次启动时填写并确认了服务范围；如要修改，重新填写初始化信息即可。',
  cost: '整理平台结算明细和完整成本（人工、耗材、值守、返工、售后等），先脱敏 → 点上面「导入商品快照」，在「完整成本记录」里上传。',
  hardware: '打开直播输出窗口：① 选择俯拍摄像头，确认画面不露脸；② 点下方「中文语音·开始试听」，确认输出能听见；③ 确认真人声音可以随时接管。',
  asset: '准备素材授权证明（图片/视频/音乐/语音的使用权）和 AI 标识说明 → 点上面「导入商品快照」，在「素材权利证明」里上传。',
  authorization: '真正开播时：先在抖音直播伴侣里人工开始直播，再回到本页下方「场次安全控制」，点「我已在直播伴侣人工开播」。',
};

function Preflight({ data, activeOffer, onRefresh, onHardware, onVoiceTest, onVoiceConfirm, voiceTestPending, voiceTestGenerated, onOfferSaved, onError, onTransition }: {
  data: BootstrapData;
  activeOffer: OfferSnapshot | null;
  onRefresh: () => void;
  onHardware: (input: Partial<BootstrapData['hardware']>) => Promise<void>;
  onVoiceTest: () => void;
  onVoiceConfirm: () => void;
  voiceTestPending: boolean;
  voiceTestGenerated: boolean;
  onOfferSaved: () => Promise<void>;
  onError: (message: string) => void;
  onTransition: (state: LiveSession['state'], reason: string | null, confirmed?: boolean) => void;
}) {
  const [showOffer, setShowOffer] = useState(false);
  const [offer, setOffer] = useState({ productId: '', title: '新客常规服务｜1次', price: '9.90', regularPrice: '', merchantSource: '', merchantUri: '', merchantSha: '', officialTitle: '', officialUri: '', officialSha: '', costTitle: '', costUri: '', costSha: '', assetTitle: '', assetUri: '', assetSha: '' });
  const [saving, setSaving] = useState(false);

  async function saveOffer() {
    if (!offer.productId.trim() || !offer.title.trim() || !offer.merchantSource.trim() || !offer.merchantUri.trim() || !offer.merchantSha.trim()) return onError('商品ID、标题和已保全的商户商品来源文件必须完整。');
    setSaving(true);
    try {
      const capturedAt = new Date().toISOString();
      const validUntil = new Date(Date.now() + 7 * 86_400_000).toISOString();
      const refs: OfferSnapshot['evidenceRefs'] = [{ id: crypto.randomUUID(), title: offer.merchantSource.trim(), sourceType: 'MERCHANT_RECORD', sourceUri: offer.merchantUri.trim(), capturedAt, validUntil, sha256: offer.merchantSha.trim() }];
      if (offer.officialTitle.trim()) refs.push({ id: crypto.randomUUID(), title: offer.officialTitle.trim(), sourceType: 'OFFICIAL_WRITTEN', sourceUri: offer.officialUri.trim() || null, capturedAt, validUntil, sha256: offer.officialSha.trim() || null });
      if (offer.costTitle.trim()) refs.push({ id: crypto.randomUUID(), title: offer.costTitle.trim(), sourceType: 'COST_RECORD', sourceUri: offer.costUri.trim() || null, capturedAt, validUntil, sha256: offer.costSha.trim() || null });
      if (offer.assetTitle.trim()) refs.push({ id: crypto.randomUUID(), title: offer.assetTitle.trim(), sourceType: 'AUTHORIZED_ASSET', sourceUri: offer.assetUri.trim() || null, capturedAt, validUntil, sha256: offer.assetSha.trim() || null });
      await api.saveOffer({
        id: crypto.randomUUID(),
        productId: offer.productId.trim(),
        title: offer.title.trim(),
        priceCents: Math.round(Number(offer.price) * 100),
        regularPriceCents: offer.regularPrice.trim() ? Math.round(Number(offer.regularPrice) * 100) : null,
        shoeTypes: data.config.productCategories.length > 0 ? data.config.productCategories : ['常规品类'],
        serviceAreas: data.config.serviceAreas.length > 0 ? data.config.serviceAreas : [],
        evidenceRefs: refs,
        capturedAt,
        validUntil,
        status: 'ACTIVE',
      });
      setShowOffer(false);
      await onOfferSaved();
    } catch (error) {
      onError(error instanceof Error ? error.message : '商品快照保存失败');
    } finally {
      setSaving(false);
    }
  }

  const session = data.session;
  return (
    <div className="preflight-layout">
      <section className="gate-summary">
        <div className="gate-lock"><ShieldAlert aria-hidden="true" /><div><strong>正式开播保持锁定</strong><p>要真正开播，必须逐项完成下面的准备。当前只能进行本地演练和直播伴侣预览，不能声称已经获得真实开播许可。</p></div></div>
        <div className="gate-actions"><button className="secondary-action" type="button" onClick={onRefresh}><RefreshCw aria-hidden="true" />重新检查</button><button className="primary-action" type="button" onClick={() => setShowOffer((value) => !value)}><ShoppingBag aria-hidden="true" />{showOffer ? '收起商品导入' : activeOffer ? '更新商品快照' : '导入商品快照'}</button></div>
      </section>

      {showOffer && (
        <section className="offer-form-section">
          <div className="panel-heading"><PackageCheck aria-hidden="true" /><div><h2>冻结开播商品</h2><p>本工具只保存快照，不会向抖音修改商品。官方、成本和素材证据为空时会继续阻断。</p></div></div>
          <p className="evidence-intro">下面的每一份材料都只需两步：<b>填一个标题</b> + <b>选一个文件</b>。文件由程序自动复制到本机证据库并计算校验值，之后随时能核对来源。<b>支持格式：PNG / JPG / PDF / TXT / JSON</b>。上传前请确认文件里不含姓名、电话、地址、头像、订单号、券码或聊天账号（勾选脱敏确认后才能选文件）。</p>
          <div className="offer-form">
            <label><span>商品ID</span><input value={offer.productId} onChange={(e) => setOffer({ ...offer, productId: e.target.value })} /></label>
            <label className="wide"><span>商品标题</span><input value={offer.title} onChange={(e) => setOffer({ ...offer, title: e.target.value })} /></label>
            <label><span>新客成交价（元）</span><input type="number" min="0.01" step="0.01" value={offer.price} onChange={(e) => setOffer({ ...offer, price: e.target.value })} /></label>
            <label><span>正常价（元，可空）</span><input type="number" min="0.01" step="0.01" value={offer.regularPrice} onChange={(e) => setOffer({ ...offer, regularPrice: e.target.value })} placeholder="从有效商品导入" /></label>
            <EvidenceInputs title="商户商品来源（必填并上传文件）" help="是什么：证明「这个商品确实存在、是你店铺里在卖的」。去哪拿：抖音后台 → 小店/商品管理 → 找到这个商品页，截图时带上商品ID和店铺名。上传格式：截图 PNG/JPG，或导出的 txt/json。" name="merchantSource" uriName="merchantUri" shaName="merchantSha" value={offer} onChange={setOffer} onError={onError} />
            <EvidenceInputs title="平台规则书面答复" help="是什么：抖音官方客服对你开播口径的书面答复（比如到店/上门取送怎么描述、商品怎么命名）。去哪拿：在抖音商家客服/在线客服里提问，把客服答复页面截图保存。上传格式：截图 PNG/JPG 或 PDF。" name="officialTitle" uriName="officialUri" shaName="officialSha" value={offer} onChange={setOffer} onError={onError} />
            <EvidenceInputs title="完整成本记录" help="是什么：这份商品从接单到履约的全部成本清单（材料、人工、耗材、值守、返工、售后）。去哪拿：按你实际经营自己整理成一张表。上传格式：表格截图 PNG/JPG，或 PDF/txt，务必先脱敏。" name="costTitle" uriName="costUri" shaName="costSha" value={offer} onChange={setOffer} onError={onError} />
            <EvidenceInputs title="素材权利证明" help="是什么：直播画面用到的图片/视频/音乐/语音素材的使用授权（购买记录、授权书，或自己原创的说明）。去哪拿：素材购买凭证或授权文件。上传格式：截图 PNG/JPG 或 PDF。" name="assetTitle" uriName="assetUri" shaName="assetSha" value={offer} onChange={setOffer} onError={onError} />
            <div className="form-actions wide"><button className="secondary-action" type="button" onClick={() => setShowOffer(false)}>取消</button><button className="primary-action" type="button" disabled={saving} onClick={() => void saveOffer()}>{saving ? <LoaderCircle className="spin" /> : <Check />}保存7天有效快照</button></div>
          </div>
        </section>
      )}

      <section className="gate-list">
        {data.preflight.checks.map((check) => (
          <article key={check.id} className={`gate-row ${check.status.toLowerCase()}`}>
            <CheckIcon status={check.status} />
            <div>
              <strong>{check.label}</strong>
              <p>{check.detail}</p>
              {check.status !== 'PASS' && GATE_TIPS[check.id] && (
                <p className="gate-tip"><span>怎么解决：</span>{GATE_TIPS[check.id]}</p>
              )}
            </div>
            <span>{check.status === 'PASS' ? '已完成' : check.status === 'BLOCKED' ? '未完成' : '需人工确认'}</span>
          </article>
        ))}
      </section>

      <section className="hardware-confirm">
        <div className="panel-heading"><Mic2 aria-hidden="true" /><div><h2>本机预览确认</h2><p>这些确认只代表本机预览，不代表抖音开播授权。</p></div></div>
        <div className="hardware-buttons">
          <button className={data.hardware.cameraReady ? 'confirmed' : ''} type="button" disabled><Camera />{data.hardware.cameraReady ? `俯拍已确认：${data.hardware.cameraLabel ?? '专用设备'}` : '请在直播输出窗口选择设备并确认无人脸'}</button>
          <button className={data.hardware.voiceReady ? 'confirmed' : ''} type="button" disabled={voiceTestPending} onClick={voiceTestGenerated && !data.hardware.voiceReady ? onVoiceConfirm : onVoiceTest}><Volume2 />中文语音{voiceTestPending ? '试听中' : data.hardware.voiceReady ? '员工已确认' : voiceTestGenerated ? '确认听见且线路正确' : '开始试听'}</button>
          <button className={data.hardware.takeoverReady ? 'confirmed' : ''} type="button" onClick={() => void onHardware({ takeoverReady: !data.hardware.takeoverReady })}><Mic2 />真人声音接管{data.hardware.takeoverReady ? '已确认' : '待确认'}</button>
        </div>
      </section>

      {session && (
        <section className="session-controls">
          <div className="panel-heading"><Radio aria-hidden="true" /><div><h2>场次安全控制</h2><p>“进入直播中”仍要求员工在抖音直播伴侣中人工操作并当次确认。</p></div></div>
          <div className="session-control-row">
            <StateBadge state={session.state} />
            {session.state === 'DRAFT' && <button type="button" onClick={() => onTransition('READY', null)}>完成本地检查</button>}
            {session.state === 'READY' && <button type="button" className="danger-action" onClick={() => onTransition('LIVE', null, true)}>我已在直播伴侣人工开播</button>}
            {session.state === 'LIVE' && <button type="button" className="danger-action" onClick={() => onTransition('PAUSED', '员工主动暂停AI播报')}>暂停AI</button>}
            {session.state === 'PAUSED' && <button type="button" onClick={() => onTransition('LIVE', null, true)}>确认人工状态后恢复</button>}
            {!['STOPPED', 'COMPLETED'].includes(session.state) && <button type="button" onClick={() => onTransition('STOPPED', '员工安全结束场次')}>安全结束</button>}
          </div>
        </section>
      )}
    </div>
  );
}

function EvidenceInputs({ title, help, name, uriName, shaName, value, onChange, onError }: { title: string; help?: string; name: keyof ReturnType<typeof emptyOfferForm>; uriName: keyof ReturnType<typeof emptyOfferForm> | null; shaName: keyof ReturnType<typeof emptyOfferForm> | null; value: ReturnType<typeof emptyOfferForm>; onChange: (value: ReturnType<typeof emptyOfferForm>) => void; onError: (message: string) => void }) {
  const [privacyConfirmed, setPrivacyConfirmed] = useState(false);
  const [askFirst, setAskFirst] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const stored = uriName && shaName && Boolean(value[uriName] && value[shaName]);

  function handlePickFile() {
    if (uploading) return;
    if (!privacyConfirmed) {
      setAskFirst(true);
      return;
    }
    setAskFirst(false);
    fileRef.current?.click();
  }

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    setAskFirst(false);
    try {
      const saved = await api.uploadEvidence(file, true);
      onChange({ ...value, [uriName!]: saved.sourceUri, [shaName!]: saved.sha256, [name]: value[name] || saved.originalName });
    } catch (error) {
      const message = error instanceof Error ? error.message : '证据文件保全失败';
      setUploadError(message);
      onError(message);
    } finally {
      setUploading(false);
    }
  }

  return <div className="evidence-input wide">
    <label><span>{title}</span><input value={String(value[name])} onChange={(e) => onChange({ ...value, [name]: e.target.value })} placeholder="证据标题；没有就保持空白" /></label>
    {help && <p className="evidence-help">{help}</p>}
    {uriName && shaName && <>
      <label className="check-field"><input type="checkbox" checked={privacyConfirmed} onChange={(event) => { setPrivacyConfirmed(event.target.checked); if (event.target.checked) setAskFirst(false); }} /><span>已确认文件不含姓名、电话、地址、头像、订单号、券码或聊天账号</span></label>
      {askFirst && <p className="evidence-ask" role="alert">⚠ 请先勾选上面的「脱敏确认」，然后点这里就能选择文件了。</p>}
      {uploadError && <p className="evidence-error" role="alert">✗ 保全失败：{uploadError}</p>}
      <div className="evidence-file">
        <button type="button" className={uploading ? 'uploading' : stored ? 'confirmed' : privacyConfirmed ? '' : 'locked'} onClick={handlePickFile} disabled={uploading}>
          {uploading ? <LoaderCircle className="spin" aria-hidden="true" /> : stored ? <Check aria-hidden="true" /> : <FileUp aria-hidden="true" />}
          {uploading ? '正在保全文件…' : stored ? '文件已保全' : privacyConfirmed ? '选择已脱敏的本机证据文件' : '选择文件（需先勾选脱敏确认）'}
        </button>
        <input ref={fileRef} type="file" style={{ display: 'none' }} accept=".png,.jpg,.jpeg,.pdf,.txt,.json" onChange={(event) => void handleFileChange(event)} />
        <small className={stored ? 'ok' : ''}>{stored ? `✓ 已保全到本机证据库 · 校验尾号 ${String(value[shaName]).slice(-8)}` : uploading ? '正在复制文件并计算校验值，请稍候…' : '选择文件后，程序会自动复制到本机证据库并计算校验值；图片和PDF仍需人工确认脱敏'}</small>
      </div>
    </>}
  </div>;
}

function emptyOfferForm() {
  return { productId: '', title: '', price: '', regularPrice: '', merchantSource: '', merchantUri: '', merchantSha: '', officialTitle: '', officialUri: '', officialSha: '', costTitle: '', costUri: '', costSha: '', assetTitle: '', assetUri: '', assetSha: '' };
}

function Audit({ entries }: { entries: AuditEntry[] }) {
  return (
    <section className="audit-panel">
      <div className="panel-heading"><History aria-hidden="true" /><div><h2>本地操作日志</h2><p>记录配置、商品、回答、场次、在场确认和经营结果；不包含密码、Cookie或完整顾客隐私。</p></div></div>
      <div className="audit-list">
        {entries.length === 0 ? <div className="empty-row"><History />暂无操作日志</div> : entries.map((entry) => (
          <article key={entry.id}><span className="audit-time">{formatTime(entry.createdAt)}</span><span className="audit-action">{entry.action}</span><strong>{entry.entityType}</strong><p>{auditSummary(entry)}</p></article>
        ))}
      </div>
    </section>
  );
}

function Backups({ sessionState, onNotice }: {
  sessionState: string;
  onNotice: (notice: Notice) => void;
}) {
  const [backups, setBackups] = useState<BackupSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [verification, setVerification] = useState<BackupIntegrity | null>(null);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoaded(false);
    try {
      setBackups(await api.listBackups());
    } catch (error) {
      onNotice({ tone: 'error', message: error instanceof Error ? error.message : '备份列表读取失败' });
    } finally {
      if (!quiet) setLoaded(true);
    }
  }, [onNotice]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function createNow() {
    setCreating(true);
    try {
      const created = await api.createBackup();
      await refresh(true);
      onNotice({ tone: 'success', message: `备份已生成：${created.name}（${created.fileCount} 个文件）。请将 ${created.dir} 复制到另一块磁盘保存。` });
    } catch (error) {
      onNotice({ tone: 'error', message: error instanceof Error ? error.message : '备份失败' });
    } finally {
      setCreating(false);
    }
  }

  async function verify(name: string) {
    setBusy(name);
    setVerification(null);
    try {
      const result = await api.verifyBackup(name);
      setVerification(result);
      onNotice(result.ok
        ? { tone: 'success', message: `备份 ${name} 完整性校验通过：清单、文件与摘要一致。` }
        : { tone: 'error', message: `备份 ${name} 校验未通过：${result.problems.join('；')}` });
    } catch (error) {
      onNotice({ tone: 'error', message: error instanceof Error ? error.message : '校验失败' });
    } finally {
      setBusy(null);
    }
  }

  async function restore(name: string) {
    const confirmed = window.confirm(
      `⚠️ 恢复操作会覆盖当前全部经营数据与证据，且不可撤销（系统会在恢复前自动生成一份安全备份用于回退）。\n\n确认从「${name}」恢复吗？`,
    );
    if (!confirmed) return;
    setBusy(name);
    try {
      const result = await api.restoreBackup(name);
      await refresh(true);
      onNotice({
        tone: 'success',
        message: `已从 ${result.restoredFrom} 恢复 ${result.restoredFiles} 个文件，证据校验 ${result.verifiedEvidenceFiles} 份通过；恢复前安全备份：${result.safetyBackupDir}。${result.warnings.join('；')}`,
      });
    } catch (error) {
      onNotice({ tone: 'error', message: error instanceof Error ? error.message : '恢复失败' });
    } finally {
      setBusy(null);
    }
  }

  const streaming = sessionState === 'LIVE' || sessionState === 'PAUSED';

  return (
    <section className="backup-panel">
      <div className="panel-heading">
        <DatabaseBackup aria-hidden="true" />
        <div>
          <h2>本地数据备份与恢复</h2>
          <p>备份 8 个经营 JSON 与 evidence/ 证据目录，带 SHA256 清单；恢复前自动校验、失败整体拒绝、恢复前自动留底。恢复只接管业务数据，不碰本机身份令牌。</p>
        </div>
      </div>

      <div className="backup-actions">
        <button className="primary-action" type="button" onClick={() => void createNow()} disabled={creating}>
          {creating ? <LoaderCircle className="spin" aria-hidden="true" /> : <Database aria-hidden="true" />}
          {creating ? '正在生成备份…' : '立即生成备份'}
        </button>
        <button className="secondary-action" type="button" onClick={() => void refresh()} disabled={busy !== null}>
          <RefreshCw aria-hidden="true" />刷新列表
        </button>
        <span className="action-note">备份建议每次结束后复制到另一块磁盘或压缩归档，避免单盘故障同归于尽。</span>
      </div>

      {streaming && (
        <div className="backup-live-warning">
          <ShieldAlert aria-hidden="true" />
          <span>当前场次为 {shortState(sessionState)}，直播进行或中途暂停时禁止恢复数据；生成备份不受影响。</span>
        </div>
      )}

      <div className="backup-list">
        {!loaded ? (
          <div className="empty-row"><LoaderCircle className="spin" aria-hidden="true" />正在读取备份列表…</div>
        ) : backups.length === 0 ? (
          <div className="empty-row"><Archive aria-hidden="true" />还没有任何备份。建议在首次建立场次前先生成一份。</div>
        ) : backups.map((item) => (
          <article className="backup-row" key={item.name}>
            <div className="backup-meta">
              <DatabaseBackup aria-hidden="true" />
              <div>
                <strong>{item.name}</strong>
                <span>{formatTime(item.createdAt)} · {item.label} · {formatBytes(item.bytes)} · {item.fileCount} 个文件</span>
                <span className="backup-counts">商品 {item.counts.offers ?? 0} · 场次 {item.counts.sessions ?? 0} · 订单 {item.counts.orders ?? 0} · 知识 {item.counts.knowledge ?? 0} · 证据文件 {item.counts.evidenceFiles ?? 0}</span>
                {item.externalEvidenceIds.length > 0 && (
                  <span className="backup-external">⚠ {item.externalEvidenceIds.length} 条证据指向数据目录之外，不在本备份内</span>
                )}
              </div>
            </div>
            <div className="backup-row-actions">
              <button className="secondary-action" type="button" disabled={busy !== null} onClick={() => void verify(item.name)}>
                {busy === item.name ? <LoaderCircle className="spin" aria-hidden="true" /> : <FileClock aria-hidden="true" />}校验
              </button>
              <button className="danger-action" type="button" disabled={busy !== null || streaming} title={streaming ? '直播进行或暂停时禁止恢复' : '恢复将覆盖当前数据'} onClick={() => void restore(item.name)}>
                <RotateCcw aria-hidden="true" />恢复
              </button>
            </div>
          </article>
        ))}
      </div>

      {verification && !verification.ok && verification.problems.length > 0 && (
        <div className="backup-verify-detail">
          <CircleAlert aria-hidden="true" />
          <div>
            <strong>校验未通过，该备份不会被恢复</strong>
            <ul>{verification.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
          </div>
        </div>
      )}
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function auditSummary(entry: AuditEntry): string {
  if (entry.action === 'RUNTIME_EVENT') return String(entry.detail.message ?? '运行事件');
  if (entry.action === 'SESSION_TRANSITION') return `场次状态：${String(entry.detail.state ?? '未知')}`;
  if (entry.action === 'OFFER_SNAPSHOT_SAVED') return `商品 ${String(entry.detail.productId ?? '')}，价格 ${formatMoney(Number(entry.detail.priceCents ?? 0))}`;
  if (entry.action === 'KNOWLEDGE_SAVED') return `知识意图：${String(entry.detail.intent ?? '')}`;
  if (entry.action === 'ORDER_OUTCOME_SAVED') return `完成：${entry.detail.completed ? '是' : '否'}；复购：${entry.detail.repeated ? '是' : '否'}`;
  return entry.entityId ? `对象：${entry.entityId}` : '系统记录';
}
