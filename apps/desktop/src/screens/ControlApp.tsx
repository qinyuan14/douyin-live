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
  Save,
  ShieldAlert,
  ShieldCheck,
  ShoppingBag,
  Square,
  UserCheck,
  Volume2,
  WalletCards,
  Wand2,
  FileAudio,
  MonitorPlay,
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
  StoreConfig,
  TtsConfig,
} from '@liveops/live-contracts';
import { api, type AuditEntry, type BootstrapData } from '../api.js';
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

/** 侧边栏主功能（小白常用）：一键开播 / 开播准备 / 直播流程 */
const NAV_MAIN: Array<{ id: Page; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'overview', label: '今日开播', icon: LayoutDashboard },
  { id: 'preflight', label: '开播准备', icon: ClipboardCheck },
  { id: 'director', label: '直播流程', icon: Radio },
];

/** 侧边栏「更多功能」（默认收起，小白看不到）：问答 / 订单 / 日志 / 备份 */
const NAV_MORE: Array<{ id: Page; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'qa', label: '顾客问答', icon: ShieldCheck },
  { id: 'orders', label: '经营记录', icon: ReceiptText },
  { id: 'audit', label: '操作日志', icon: History },
  { id: 'backups', label: '数据备份', icon: DatabaseBackup },
];

const ALL_NAV = [...NAV_MAIN, ...NAV_MORE];

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
  const [launchOpen, setLaunchOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // 首次进入值班台（完成初始化向导后）弹出新手引导；关掉后记住，可随时从任务清单重新打开
  useEffect(() => {
    if (data?.config.setupCompleted && !window.localStorage.getItem(GUIDE_SEEN_KEY)) {
      setShowGuide(true);
    }
  }, [data?.config.setupCompleted]);

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

  /** 一键开播：自动建场次（如有）→ 全部就绪进开播确认，否则弹引导补齐 */
  async function handleOneClickLive() {
    setWorking(true);
    try {
      let session = data?.session ?? null;
      if (!session || ['STOPPED', 'COMPLETED'].includes(session.state)) {
        await api.createSession();
        const result = await api.bootstrap();
        setData(result);
        session = result.session;
      }
      if (!session) return;
      // v2：manualRequired 仅指「当次开播授权」，一键开播点击后弹确认即可，不视为未就绪
      if (data?.preflight.blocked) {
        setLaunchOpen(true);
      } else {
        setConfirmOpen(true);
      }
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : '开播检查失败' });
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

  // 首次启动：未完成初始化向导前，先完成 4 步设置（小白商用 v2）
  if (!data.config.setupCompleted) {
    return <Onboarding existingOfferTitle={activeOffer?.title ?? null} onCompleted={() => void refresh()} />;
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
          {NAV_MAIN.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.id} className={page === item.id ? 'active' : ''} type="button" onClick={() => setPage(item.id)}>
                <Icon aria-hidden="true" />
                <span>{item.label}</span>
                {item.id === 'preflight' && data.preflight.blocked && <i className="nav-alert" />}
              </button>
            );
          })}
          <div className="nav-group-label">更多功能</div>
          {NAV_MORE.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.id} className={page === item.id ? 'active' : ''} type="button" onClick={() => setPage(item.id)}>
                <Icon aria-hidden="true" />
                <span>{item.label}</span>
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
            <h1>{ALL_NAV.find((item) => item.id === page)?.label}</h1>
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

        {launchOpen && (
          <LaunchGuideModal
            data={data}
            activeOffer={activeOffer}
            onClose={() => setLaunchOpen(false)}
            onNavigate={(next) => { setLaunchOpen(false); setPage(next); }}
          />
        )}

        {confirmOpen && (
          <LaunchConfirmModal
            working={working}
            onClose={() => setConfirmOpen(false)}
            onConfirm={() => void transition('LIVE', null, true).then(() => setConfirmOpen(false))}
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
              onOneClick={() => void handleOneClickLive()}
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
              onSaveTts={async (tts) => { await api.saveConfig({ tts }); await refresh(true); }}
              onSaveScripts={async (scripts) => { await api.saveConfig({ pregenScripts: scripts }); await refresh(true); }}
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

function Overview({ data, activeOffer, passedChecks, working, rehearsing, onCreate, onPresence, onRehearsal, onOneClick, onNavigate, onShowGuide }: {
  data: BootstrapData;
  activeOffer: OfferSnapshot | null;
  passedChecks: number;
  working: boolean;
  rehearsing: boolean;
  onCreate: () => void;
  onPresence: () => void;
  onRehearsal: () => void;
  onOneClick: () => void;
  onNavigate: (page: Page) => void;
  onShowGuide: () => void;
}) {
  const session = data.session;
  const tasks = buildTasks(data, activeOffer);
  const doneCount = tasks.filter((task) => task.status === 'done').length;
  const ready = !data.preflight.blocked;
  return (
    <div className="overview-grid">
      <section className="one-click-card">
        <div className="one-click-info">
          <span className="task-kicker">一键开播</span>
          <h2>{data.config.storeName || '你的店'} · 今晚直播</h2>
          <p>
            {ready
              ? '所有准备都完成了，点一下进入开播确认，最后一步在直播伴侣里人工开播。'
              : `还差 ${tasks.filter((task) => task.status !== 'done').length} 件事，点一下我带你一步步补齐，全程不用记步骤。`}
          </p>
        </div>
        <div className="one-click-side">
          <div className="readiness"><strong>{passedChecks}</strong><span>/ {data.preflight.checks.length} 项就绪</span></div>
          <button className="one-click-button" type="button" onClick={onOneClick} disabled={working}>
            {working ? <LoaderCircle className="spin" aria-hidden="true" /> : <Play aria-hidden="true" />}
            一键开播
          </button>
        </div>
      </section>

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
          {data.preflight.blocked && (
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
          <p>每15分钟确认一次，连续两次未确认会暂停AI。</p>
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

/** 首页「开播任务」清单：从 0 到开播的 5 件事，每件写明怎么做、做到哪、点哪进入 */
function buildTasks(data: BootstrapData, activeOffer: OfferSnapshot | null): TaskItem[] {
  const statusById = new Map(data.preflight.checks.map((check) => [check.id, check.status]));
  const setupDone = statusById.get('setup-complete') === 'PASS';
  const offerDone = statusById.get('offer-active') === 'PASS';
  const rehearsalReady = data.runSheet.some((segment) => segment.approved);

  return [
    {
      // 小白商用 v2：首次设置已由 4 步向导完成，日常不再重复
      id: 'setup',
      label: '完成首次设置',
      how: setupDone ? '店铺、商品、声音、监护已在首次向导中确认（重启不重复）' : '打开「开播准备」补全首次设置，或到「设置」重新配置',
      status: setupDone ? 'done' : 'todo',
      page: 'preflight',
    },
    {
      id: 'offer',
      label: '商品信息有效',
      how: offerDone && activeOffer
        ? `当前商品：${activeOffer.title}（¥${(activeOffer.priceCents / 100).toFixed(2)}）`
        : '在「开播准备」录入商品：填名称和价格，勾选三项确认（不用上传文件）',
      status: offerDone ? 'done' : 'todo',
      page: 'preflight',
    },
    {
      id: 'rehearsal',
      label: '本地演练一遍',
      how: rehearsalReady ? '在「直播流程」点「开始演练」，AI 按两小时流程播报，检查声音和字幕' : '首次设置完成后即可演练，检查声音和字幕效果',
      status: rehearsalReady ? 'ready' : 'blocked',
      page: 'director',
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
        <p>这套工具帮你把「真实工作台」直播出去：AI 主持播报、真人监护、问答有把关。从 0 到开播，跟着 5 步走：</p>
        <ol className="guide-steps">
          <li><b>完成首次设置</b><span>店铺、商品、声音、监护一次配好（你已完成）</span></li>
          <li><b>商品信息有效</b><span>在「开播准备」确认商品名称和价格（不用上传文件）</span></li>
          <li><b>本地演练一遍</b><span>在「直播流程」试听 AI 两小时播报，检查声音和字幕</span></li>
        </ol>
        <p className="guide-note">首页的「一键开播」会带你一步一步做完，看不懂随时点「重新看引导」。</p>
        <div className="guide-actions">
          <button className="primary-action" type="button" onClick={() => { onStart('preflight'); onClose(); }}>带我去看开播准备</button>
          <button className="secondary-action" type="button" onClick={onClose}>先逛逛</button>
        </div>
      </div>
    </div>
  );
}

/** 一键开播未就绪时：列出还差的事，点「去完成」直达对应页面 */
function LaunchGuideModal({ data, activeOffer, onClose, onNavigate }: {
  data: BootstrapData;
  activeOffer: OfferSnapshot | null;
  onClose: () => void;
  onNavigate: (page: Page) => void;
}) {
  const tasks = buildTasks(data, activeOffer);
  const pending = tasks.filter((task) => task.status !== 'done');
  return (
    <div className="guide-overlay" onClick={onClose}>
      <div className="guide-modal" onClick={(event) => event.stopPropagation()}>
        <h2>还差 {pending.length} 件事，做完就能开播</h2>
        <p>不用记步骤，点「去完成」我带你到对应页面，做完自动打勾：</p>
        <ol className="guide-steps launch-steps">
          {tasks.map((task) => (
            <li key={task.id} className={task.status === 'done' ? 'done' : 'pending'}>
              <b>{task.label}</b>
              <span>{task.status === 'done' ? '✓ 已完成' : task.how}</span>
              {task.status !== 'done' && (
                <button type="button" className="launch-go" onClick={() => onNavigate(task.page)}>去完成</button>
              )}
            </li>
          ))}
        </ol>
        <div className="guide-actions">
          <button className="secondary-action" type="button" onClick={onClose}>等一下再看</button>
        </div>
      </div>
    </div>
  );
}

/** 一键开播全部就绪：最后一步在直播伴侣人工开播 */
function LaunchConfirmModal({ working, onConfirm, onClose }: { working: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <div className="guide-overlay" onClick={onClose}>
      <div className="guide-modal" onClick={(event) => event.stopPropagation()}>
        <h2>准备就绪，最后一步由你完成</h2>
        <p className="launch-confirm-steps">
          1. 打开抖音直播伴侣，把画面源选为本机「直播输出窗口」并点「开始直播」<br />
          2. 回到这里，点下面的按钮确认——AI 才会开始播报。
        </p>
        <div className="guide-actions">
          <button className="primary-action" type="button" disabled={working} onClick={onConfirm}>
            {working ? <LoaderCircle className="spin" aria-hidden="true" /> : <Play aria-hidden="true" />}我已在直播伴侣人工开播
          </button>
          <button className="secondary-action" type="button" onClick={onClose}>稍后</button>
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
  const completedSessions = data.sessions.filter((session) => session.startedAt && session.endedAt && ['STOPPED', 'COMPLETED'].includes(session.state));
  const [form, setForm] = useState({
    liveSessionId: '', externalRef: '', customerRef: '', firstPaidAt: '', pickedUpAt: '', firstNet: '', repeatNet: '', repeatPrice: '', platformFee: '', pickup: '', production: '', material: '', liveLabor: '', rework: '', compensation: '', equipment: '', software: '', completed: false, refunded: false, repeat: false, completedAt: '', refundedAt: '', repeatPaidAt: '', sourceTitle: '', newCustomerConfirmed: false, recordConfirmed: false, costConfirmed: false,
  });

  async function submit() {
    if (!form.externalRef.trim() || !form.customerRef.trim() || !form.sourceTitle.trim()) return onError('请填写订单标识、稳定顾客标识和数据来源标题。');
    const linkedSession = completedSessions.find((session) => session.id === form.liveSessionId);
    if (!linkedSession) return onError('请选择一场已经结束且有真实起止时间的直播。');
    const linkedOffer = data.offers.find((offer) => offer.id === linkedSession.offerSnapshotId);
    if (!linkedOffer) return onError('所选直播场次缺少当时冻结的商品快照，不能记录经营结果。');
    if (!form.firstPaidAt) return onError('必须填写真实首单付款时间。');
    if (form.completed && !form.pickedUpAt) return onError('已完成订单必须填写真实履约时间。');
    if (!form.newCustomerConfirmed) return onError('必须人工核对平台历史订单，确认这是首次消费候选新客。');
    if (!form.recordConfirmed || !form.costConfirmed) return onError('请勾选两项自查确认：订单真实履约、成本按真实口径。');
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
        // v8.1 起不再上传证据文件：evidenceRefs 留空，改由 selfChecks 自查确认把关
        evidenceRefs: [],
        selfChecks: {
          recordConfirmed: form.recordConfirmed,
          costConfirmed: form.costConfirmed,
        },
        createdAt: timestamp, updatedAt: timestamp,
      };
      await api.saveOrder(order);
      setShowForm(false);
      setForm({ liveSessionId: '', externalRef: '', customerRef: '', firstPaidAt: '', pickedUpAt: '', firstNet: '', repeatNet: '', repeatPrice: '', platformFee: '', pickup: '', production: '', material: '', liveLabor: '', rework: '', compensation: '', equipment: '', software: '', completed: false, refunded: false, repeat: false, completedAt: '', refundedAt: '', repeatPaidAt: '', sourceTitle: '', newCustomerConfirmed: false, recordConfirmed: false, costConfirmed: false });
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
            <label className="check-field wide"><input type="checkbox" checked={form.newCustomerConfirmed} onChange={(e) => setForm({ ...form, newCustomerConfirmed: e.target.checked })} /><span>我已在平台历史订单中人工核对：这是首次消费候选新客</span></label>
            <label className="check-field wide"><input type="checkbox" checked={form.recordConfirmed} onChange={(e) => setForm({ ...form, recordConfirmed: e.target.checked })} /><span>我确认：这笔订单真实发生、服务已如实履约（不需要上传文件）</span></label>
            <label className="check-field wide"><input type="checkbox" checked={form.costConfirmed} onChange={(e) => setForm({ ...form, costConfirmed: e.target.checked })} /><span>我确认：成本字段按真实口径填写，未知不当作零</span></label>
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

/** 每项开播准备「怎么解决」的一句话说清（客户看得懂的步骤） */
const GATE_TIPS: Record<string, string> = {
  'self-offer': '在「导入商品快照」里填商品名和价格，勾选「商品真实存在、价格与店内一致」。',
  'service-area': '已在首次启动时确认；要修改需重新填写初始化信息。',
  'self-cost': '在「导入商品快照」里勾选「按真实成本经营，不构成超低价」。',
  hardware: '点「打开直播输出窗口」：①确认画面为数字人形象（无真人出镜）②试听中文语音 ③确认真人可接管。',
  'self-asset': '在「导入商品快照」里勾选「直播素材都是自有拍摄或已获授权」。',
  authorization: '在抖音直播伴侣人工开播后，点下方「我已在直播伴侣人工开播」。',
};

function Preflight({ data, activeOffer, onRefresh, onHardware, onVoiceTest, onVoiceConfirm, voiceTestPending, voiceTestGenerated, onOfferSaved, onSaveTts, onSaveScripts, onError, onTransition }: {
  data: BootstrapData;
  activeOffer: OfferSnapshot | null;
  onRefresh: () => void;
  onHardware: (input: Partial<BootstrapData['hardware']>) => Promise<void>;
  onVoiceTest: () => void;
  onVoiceConfirm: () => void;
  voiceTestPending: boolean;
  voiceTestGenerated: boolean;
  onOfferSaved: () => Promise<void>;
  onSaveTts: (tts: TtsConfig) => Promise<void>;
  onSaveScripts: (scripts: string[]) => Promise<void>;
  onError: (message: string) => void;
  onTransition: (state: LiveSession['state'], reason: string | null, confirmed?: boolean) => void;
}) {
  const [showOffer, setShowOffer] = useState(false);
  const [offer, setOffer] = useState({ productId: '', title: '新客常规服务｜1次', price: '9.90', regularPrice: '', offerConfirmed: false, costConfirmed: false, assetConfirmed: false });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function saveOffer() {
    // 商品ID 为选填；标题与价格必填；三项自查确认必勾
    if (!offer.title.trim() || !offer.price.trim()) {
      const message = '请填写商品标题和价格。';
      setFormError(message);
      onError(message);
      return;
    }
    if (!offer.offerConfirmed || !offer.costConfirmed || !offer.assetConfirmed) {
      const message = '请先勾选下方的三项自查确认，才能保存商品快照。';
      setFormError(message);
      onError(message);
      return;
    }
    setFormError(null);
    setSaving(true);
    try {
      const capturedAt = new Date().toISOString();
      const validUntil = new Date(Date.now() + 7 * 86_400_000).toISOString();
      // v8.1 起不再上传文件证据：evidenceRefs 留空，改由 selfChecks 自查确认把关
      await api.saveOffer({
        id: crypto.randomUUID(),
        productId: offer.productId.trim(),
        title: offer.title.trim(),
        priceCents: Math.round(Number(offer.price) * 100),
        regularPriceCents: offer.regularPrice.trim() ? Math.round(Number(offer.regularPrice) * 100) : null,
        shoeTypes: data.config.productCategories.length > 0 ? data.config.productCategories : ['常规品类'],
        serviceAreas: data.config.serviceAreas.length > 0 ? data.config.serviceAreas : [],
        evidenceRefs: [],
        selfChecks: {
          offerConfirmed: offer.offerConfirmed,
          costConfirmed: offer.costConfirmed,
          assetConfirmed: offer.assetConfirmed,
        },
        capturedAt,
        validUntil,
        status: 'ACTIVE',
      });
      setShowOffer(false);
      await onOfferSaved();
    } catch (error) {
      const message = error instanceof Error ? error.message : '商品快照保存失败';
      setFormError(message);
      onError(message);
    } finally {
      setSaving(false);
    }
  }

  const session = data.session;
  return (
    <div className="preflight-layout">
      <section className="gate-summary">
        <div className="gate-lock"><ShieldAlert aria-hidden="true" /><div><strong>正式开播保持锁定</strong><p>要真正开播，必须逐项完成下面的准备。当前只能进行本地演练和直播伴侣预览，不能声称已经获得真实开播许可。</p></div></div>
        <div className="gate-actions"><button className="secondary-action" type="button" onClick={onRefresh}><RefreshCw aria-hidden="true" />重新检查</button><button className="primary-action" type="button" onClick={() => { setFormError(null); setShowOffer((value) => !value); }}><ShoppingBag aria-hidden="true" />{showOffer ? '收起商品导入' : activeOffer ? '更新商品快照' : '导入商品快照'}</button></div>
      </section>

      {showOffer && (
        <section className="offer-form-section">
          <div className="panel-heading"><PackageCheck aria-hidden="true" /><div><h2>冻结开播商品</h2><p>只需填商品信息并勾选三项自查，不用上传任何文件、不用找客服。</p></div></div>
          <p className="evidence-intro">AI 播报时会照着这里的<b>商品名和价格</b>说，请填真实在售的商品。下面三项自查是合规底线，勾选即代表你确认无误——<b>不需要上传文件、不需要截图、不需要客服答复</b>。</p>
          <div className="offer-form">
            <label><span>商品ID（选填）</span><input value={offer.productId} onChange={(e) => setOffer({ ...offer, productId: e.target.value })} placeholder="在抖音后台商品页可找到" /></label>
            <label className="wide"><span>商品标题</span><input value={offer.title} onChange={(e) => setOffer({ ...offer, title: e.target.value })} /></label>
            <label><span>新客成交价（元）</span><input type="number" min="0.01" step="0.01" value={offer.price} onChange={(e) => setOffer({ ...offer, price: e.target.value })} /></label>
            <label><span>正常价（元，可空）</span><input type="number" min="0.01" step="0.01" value={offer.regularPrice} onChange={(e) => setOffer({ ...offer, regularPrice: e.target.value })} placeholder="从有效商品导入" /></label>
            <label className="check-field wide"><input type="checkbox" checked={offer.offerConfirmed} onChange={(e) => setOffer({ ...offer, offerConfirmed: e.target.checked })} /><span>我确认：这个商品真实存在、价格与店内一致（AI 会照着这个价格播报）</span></label>
            <label className="check-field wide"><input type="checkbox" checked={offer.costConfirmed} onChange={(e) => setOffer({ ...offer, costConfirmed: e.target.checked })} /><span>我确认：售价按真实成本经营，不构成超低价</span></label>
            <label className="check-field wide"><input type="checkbox" checked={offer.assetConfirmed} onChange={(e) => setOffer({ ...offer, assetConfirmed: e.target.checked })} /><span>我确认：直播画面用到的图片/视频/音乐/语音都是自有拍摄或已获授权</span></label>
            {formError && <p className="evidence-error wide" role="alert">✗ {formError}</p>}
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

      <VoiceSettings config={data.config} onSave={onSaveTts} onError={onError} />

      <PregenScripts scripts={data.config.pregenScripts ?? []} runSheet={data.runSheet} onSave={onSaveScripts} onError={onError} />

      <ScreenPlaySettings screenPlay={data.config.screenPlay} onRefresh={onRefresh} onError={onError} />

      <section className="hardware-confirm">
        <div className="panel-heading"><Mic2 aria-hidden="true" /><div><h2>直播监护确认（数字人模式）</h2><p>数字人直播不连接真实摄像头；只需确认画面合规、声音线路正确、真人可随时接管。这些确认只代表本机预览，不代表抖音开播授权。</p></div><button type="button" className="secondary-action" onClick={() => void window.liveDesktop?.focusOutputWindow()}><Camera aria-hidden="true" />打开直播输出窗口</button></div>
        <div className="hardware-buttons">
          <button className={data.hardware.cameraFramingConfirmed ? 'confirmed' : ''} type="button" onClick={() => void onHardware({ cameraFramingConfirmed: !data.hardware.cameraFramingConfirmed })}><ShieldCheck />画面形态{data.hardware.cameraFramingConfirmed ? '已确认' : '确认数字人形象·无真人出镜'}</button>
          <button className={data.hardware.voiceReady ? 'confirmed' : ''} type="button" disabled={voiceTestPending} onClick={voiceTestGenerated && !data.hardware.voiceReady ? onVoiceConfirm : onVoiceTest}><Volume2 />中文语音{voiceTestPending ? '试听中' : data.hardware.voiceReady ? '员工已确认' : voiceTestGenerated ? '确认听见且线路正确' : '开始试听'}</button>
          <button className={data.hardware.takeoverReady ? 'confirmed' : ''} type="button" onClick={() => void onHardware({ takeoverReady: !data.hardware.takeoverReady })}><Mic2 />真人声音接管{data.hardware.takeoverReady ? '已确认' : '待确认'}</button>
        </div>
      </section>

      {session && (
        <section className="session-controls">
          <div className="panel-heading"><Radio aria-hidden="true" /><div><h2>场次安全控制</h2><p>“进入直播中”仍要求员工在抖音直播伴侣中人工操作并当次确认。</p></div></div>
          <div className="session-control-row">
            <StateBadge state={session.state} />
            {(session.state === 'DRAFT' || session.state === 'PREFLIGHT_BLOCKED' || session.state === 'READY') && <button type="button" className="danger-action" onClick={() => onTransition('LIVE', null, true)}>我已在直播伴侣人工开播</button>}
            {session.state === 'LIVE' && <button type="button" className="danger-action" onClick={() => onTransition('PAUSED', '员工主动暂停AI播报')}>暂停AI</button>}
            {session.state === 'PAUSED' && <button type="button" onClick={() => onTransition('LIVE', null, true)}>确认人工状态后恢复</button>}
            {!['STOPPED', 'COMPLETED'].includes(session.state) && <button type="button" onClick={() => onTransition('STOPPED', '员工安全结束场次')}>安全结束</button>}
          </div>
        </section>
      )}
    </div>
  );
}

function emptyOfferForm() {
  return { productId: '', title: '', price: '', regularPrice: '', offerConfirmed: false, costConfirmed: false, assetConfirmed: false };
}

const DEFAULT_TTS: TtsConfig = {
  provider: 'volcengine',
  systemVoiceName: null,
  volcengine: { apiKey: '', appId: '', accessToken: '', cluster: 'volcano_tts', voiceType: 'zh_female_cancan_uranus_bigtts' },
};

/** v30：火山·豆包语音全量音色（moon_bigtts=1.0/seed-tts-1.0，uranus_bigtts=2.0/seed-tts-2.0，程序自动匹配；ICL_*_tob 为对话音色不走普通合成） */
const VOLC_BIG_VOICES: Array<{ group: string; value: string; label: string }> = [
  // 2.0 推荐（uranus_bigtts）——新版 API Key 支持，放最前
  { group: '豆包2.0·推荐', value: 'zh_female_cancan_uranus_bigtts', label: '知性灿灿 2.0（女声·灿灿同款）' },
  { group: '豆包2.0·推荐', value: 'zh_female_xiaohe_uranus_bigtts', label: '小何 2.0（女声·推荐）' },
  { group: '豆包2.0·推荐', value: 'zh_female_vv_uranus_bigtts', label: 'Vivi 2.0（女声·推荐）' },
  { group: '豆包2.0·推荐', value: 'zh_male_m191_uranus_bigtts', label: '云舟 2.0（男声·推荐）' },
  { group: '豆包2.0·推荐', value: 'zh_female_shuangkuaisisi_uranus_bigtts', label: '爽快思思 2.0（女声）' },
  // 2.0 通用（uranus_bigtts）（1.0 旧版 moon_bigtts 音色新版 Key 无法调用，已从列表移除）
  { group: '豆包2.0·通用', value: 'zh_male_liufei_uranus_bigtts', label: '刘飞 2.0（男声）' },
  { group: '豆包2.0·通用', value: 'zh_female_qingxinnvsheng_uranus_bigtts', label: '清新女声 2.0' },
  { group: '豆包2.0·通用', value: 'zh_female_tianmeixiaoyuan_uranus_bigtts', label: '甜美小源 2.0（女声）' },
  { group: '豆包2.0·通用', value: 'zh_female_tianmeitaozi_uranus_bigtts', label: '甜美桃子 2.0（女声）' },
  { group: '豆包2.0·通用', value: 'zh_male_taocheng_uranus_bigtts', label: '小天 2.0（男声）' },
  { group: '豆包2.0·通用', value: 'zh_female_sophie_uranus_bigtts', label: '魅力苏菲 2.0（女声）' },
  { group: '豆包2.0·通用', value: 'zh_female_linjianvhai_uranus_bigtts', label: '邻家女孩 2.0（女声）' },
  { group: '豆包2.0·通用', value: 'zh_male_shaonianzixin_uranus_bigtts', label: '少年梓辛 2.0（男声）' },
  { group: '豆包2.0·通用', value: 'zh_female_wenroumama_uranus_bigtts', label: '温柔妈妈 2.0（女声）' },
  { group: '豆包2.0·通用', value: 'zh_female_tvbnv_uranus_bigtts', label: 'TVB女声 2.0' },
  { group: '豆包2.0·通用', value: 'zh_male_yizhipiannan_uranus_bigtts', label: '译制片男 2.0' },
  { group: '豆包2.0·通用', value: 'zh_female_qiaopinv_uranus_bigtts', label: '俏皮女声 2.0' },
  { group: '豆包2.0·通用', value: 'zh_male_linjiananhai_uranus_bigtts', label: '邻家男孩 2.0（男声）' },
  { group: '豆包2.0·通用', value: 'zh_male_ruyaqingnian_uranus_bigtts', label: '儒雅青年 2.0（男声）' },
  { group: '豆包2.0·通用', value: 'zh_male_wennuanahu_uranus_bigtts', label: '温暖阿虎 2.0（男声）' },
  { group: '豆包2.0·通用', value: 'zh_male_naiqimengwa_uranus_bigtts', label: '奶气萌娃 2.0（男声）' },
  { group: '豆包2.0·通用', value: 'zh_female_popo_uranus_bigtts', label: '婆婆 2.0（女声）' },
  { group: '豆包2.0·通用', value: 'zh_female_gaolengyujie_uranus_bigtts', label: '高冷御姐 2.0（女声）' },
  { group: '豆包2.0·通用', value: 'zh_male_aojiaobazong_uranus_bigtts', label: '傲娇霸总 2.0（男声）' },
  { group: '豆包2.0·通用', value: 'zh_male_fanjuanqingnian_uranus_bigtts', label: '反卷青年 2.0（男声）' },
  { group: '豆包2.0·通用', value: 'zh_female_wenroushunv_uranus_bigtts', label: '温柔淑女 2.0（女声）' },
  { group: '豆包2.0·通用', value: 'zh_male_huolixiaoge_uranus_bigtts', label: '活力小哥 2.0（男声）' },
  { group: '豆包2.0·通用', value: 'zh_female_mengyatou_uranus_bigtts', label: '萌丫头 2.0（女声）' },
  { group: '豆包2.0·通用', value: 'zh_female_tiexinnvsheng_uranus_bigtts', label: '贴心女声 2.0' },
  { group: '豆包2.0·通用', value: 'zh_female_jitangmei_uranus_bigtts', label: '鸡汤妹妹 2.0（女声）' },
  { group: '豆包2.0·通用', value: 'zh_male_cixingjieshuonan_uranus_bigtts', label: '磁性解说男声 2.0' },
  { group: '豆包2.0·通用', value: 'zh_male_liangsangmengzai_uranus_bigtts', label: '亮嗓萌仔 2.0（男声）' },
  { group: '豆包2.0·通用', value: 'zh_female_kailangjiejie_uranus_bigtts', label: '开朗姐姐 2.0（女声）' },
  { group: '豆包2.0·通用', value: 'zh_male_gaolengchenwen_uranus_bigtts', label: '高冷沉稳 2.0（男声）' },
  { group: '豆包2.0·通用', value: 'zh_male_shenyeboke_uranus_bigtts', label: '深夜播客 2.0（男声）' },
  { group: '豆包2.0·通用', value: 'zh_male_kailangdidi_uranus_bigtts', label: '开朗弟弟 2.0（男声）' },
  { group: '豆包2.0·通用', value: 'zh_female_qinqienv_uranus_bigtts', label: '亲切女声 2.0' },
  { group: '豆包2.0·通用', value: 'zh_male_kuailexiaodong_uranus_bigtts', label: '快乐小东 2.0（男声）' },
  { group: '豆包2.0·通用', value: 'zh_male_kailangxuezhang_uranus_bigtts', label: '开朗学长 2.0（男声）' },
  { group: '豆包2.0·通用', value: 'zh_male_youyoujunzi_uranus_bigtts', label: '悠悠君子 2.0（男声）' },
  { group: '豆包2.0·通用', value: 'zh_female_wenjingmaomao_uranus_bigtts', label: '文静毛毛 2.0（女声）' },
  { group: '豆包2.0·通用', value: 'zh_female_zhixingnv_uranus_bigtts', label: '知性女声 2.0' },
  { group: '豆包2.0·通用', value: 'zh_male_qingshuangnanda_uranus_bigtts', label: '清爽男大 2.0（男声）' },
  { group: '豆包2.0·通用', value: 'zh_male_yuanboxiaoshu_uranus_bigtts', label: '渊博小叔 2.0（男声）' },
  { group: '豆包2.0·通用', value: 'zh_male_yangguangqingnian_uranus_bigtts', label: '阳光青年 2.0（男声）' },
  { group: '豆包2.0·通用', value: 'zh_female_qingchezizi_uranus_bigtts', label: '清澈梓梓 2.0（女声）' },
  { group: '豆包2.0·通用', value: 'zh_female_tianmeiyueyue_uranus_bigtts', label: '甜美悦悦 2.0（女声）' },
  { group: '豆包2.0·通用', value: 'zh_male_wenrouxiaoge_uranus_bigtts', label: '温柔小哥 2.0（男声）' },
  { group: '豆包2.0·通用', value: 'zh_female_roumeinvyou_uranus_bigtts', label: '柔美女友 2.0（女声）' },
  { group: '豆包2.0·通用', value: 'zh_male_dongfanghaoran_uranus_bigtts', label: '东方浩然 2.0（男声）' },
  { group: '豆包2.0·通用', value: 'zh_female_wenrouxiaoya_uranus_bigtts', label: '温柔小雅 2.0（女声）' },
  { group: '豆包2.0·通用', value: 'zh_male_tiancaitongsheng_uranus_bigtts', label: '天才童声 2.0（男声）' },
  { group: '豆包2.0·通用', value: 'zh_male_guanggaojieshuo_uranus_bigtts', label: '广告解说 2.0（男声）' },
  { group: '豆包2.0·通用', value: 'zh_female_kefunvsheng_uranus_bigtts', label: '暖阳女声 2.0（客服）' },
  // 2.0 角色/配音/有声（uranus_bigtts）
  { group: '豆包2.0·角色', value: 'zh_female_cancan_uranus_bigtts', label: '知性灿灿 2.0（女声）' },
  { group: '豆包2.0·角色', value: 'zh_female_sajiaoxuemei_uranus_bigtts', label: '撒娇学妹 2.0（女声）' },
  { group: '豆包2.0·角色', value: 'zh_female_zhishuaiyingzi_uranus_bigtts', label: '直率英子 2.0（女声）' },
  { group: '豆包2.0·角色', value: 'zh_male_silang_uranus_bigtts', label: '四郎 2.0（男声）' },
  { group: '豆包2.0·角色', value: 'zh_male_qingcang_uranus_bigtts', label: '擎苍 2.0（男声）' },
  { group: '豆包2.0·角色', value: 'zh_male_xionger_uranus_bigtts', label: '熊二 2.0（男声）' },
  { group: '豆包2.0·角色', value: 'zh_female_yingtaowanzi_uranus_bigtts', label: '樱桃丸子 2.0（女声）' },
  { group: '豆包2.0·角色', value: 'zh_female_gufengshaoyu_uranus_bigtts', label: '古风少御 2.0（女声）' },
  { group: '豆包2.0·角色', value: 'zh_male_lubanqihao_uranus_bigtts', label: '鲁班七号 2.0（男声）' },
  { group: '豆包2.0·角色', value: 'zh_female_linxiao_uranus_bigtts', label: '林潇 2.0（女声）' },
  { group: '豆包2.0·角色', value: 'zh_female_lingling_uranus_bigtts', label: '玲玲姐姐 2.0（女声）' },
  { group: '豆包2.0·角色', value: 'zh_male_tangseng_uranus_bigtts', label: '唐僧 2.0（男声）' },
  { group: '豆包2.0·角色', value: 'zh_male_zhuangzhou_uranus_bigtts', label: '庄周 2.0（男声）' },
  { group: '豆包2.0·角色', value: 'zh_male_zhubajie_uranus_bigtts', label: '猪八戒 2.0（男声）' },
  { group: '豆包2.0·角色', value: 'zh_female_ganmaodianyin_uranus_bigtts', label: '感冒电音姐姐 2.0' },
  { group: '豆包2.0·角色', value: 'zh_female_nvleishen_uranus_bigtts', label: '女雷神 2.0（女声）' },
  { group: '豆包2.0·角色', value: 'zh_female_wuzetian_uranus_bigtts', label: '武则天 2.0（女声）' },
  { group: '豆包2.0·角色', value: 'zh_female_gujie_uranus_bigtts', label: '顾姐 2.0（女声）' },
  { group: '豆包2.0·配音', value: 'zh_female_peiqi_uranus_bigtts', label: '佩奇猪 2.0' },
  { group: '豆包2.0·配音', value: 'zh_male_sunwukong_uranus_bigtts', label: '猴哥 2.0（男声）' },
  { group: '豆包2.0·配音', value: 'zh_female_mizai_uranus_bigtts', label: '黑猫侦探咪仔 2.0' },
  { group: '豆包2.0·配音', value: 'zh_female_liuchangnv_uranus_bigtts', label: '流畅女声 2.0' },
  { group: '豆包2.0·配音', value: 'zh_male_ruyayichen_uranus_bigtts', label: '儒雅逸辰 2.0（男声）' },
  { group: '豆包2.0·有声', value: 'zh_female_xiaoxue_uranus_bigtts', label: '儿童绘本 2.0（女声）' },
  { group: '豆包2.0·有声', value: 'zh_male_baqiqingshu_uranus_bigtts', label: '霸气青叔 2.0（男声）' },
  { group: '豆包2.0·有声', value: 'zh_male_xuanyijieshuo_uranus_bigtts', label: '悬疑解说 2.0（男声）' },
  { group: '豆包2.0·有声', value: 'zh_female_shaoergushi_uranus_bigtts', label: '少儿故事 2.0（女声）' },
  // 多语种（uranus_bigtts）
  { group: '多语种', value: 'en_male_tim_uranus_bigtts', label: 'Tim（英语·男声）' },
  { group: '多语种', value: 'en_female_dacey_uranus_bigtts', label: 'Dacey（英语·女声）' },
  { group: '多语种', value: 'en_female_stokie_uranus_bigtts', label: 'Stokie（英语·女声）' },
];

/** v13.1：播报音色设置——v30 起只保留火山·豆包语音（系统语音为无 Key 时兜底） */
function VoiceSettings({ config, onSave, onError }: {
  config: StoreConfig;
  onSave: (tts: TtsConfig) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [tts, setTts] = useState<TtsConfig>(() => ({
    ...DEFAULT_TTS,
    ...config.tts,
    volcengine: { ...DEFAULT_TTS.volcengine, ...config.tts?.volcengine },
  }));
  // 自定义音色代码输入（音色下拉选「自定义」时使用）
  const [customVoice, setCustomVoice] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  async function save() {
    setSaving(true);
    setNotice(null);
    try {
      // v30：固定使用火山·豆包语音；自定义音色代码回填到 voiceType
      const voiceType = tts.volcengine.voiceType === '__custom__'
        ? (customVoice.trim() || tts.volcengine.voiceType)
        : tts.volcengine.voiceType;
      await onSave({ ...tts, provider: 'volcengine', volcengine: { ...tts.volcengine, voiceType } });
      setNotice({ tone: 'success', text: '✓ 音色设置已保存，现在播报会使用所选音色。' });
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '音色设置保存失败' });
      onError(error instanceof Error ? error.message : '音色设置保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function testVoice() {
    setTesting(true);
    setNotice(null);
    try {
      setNotice({ tone: 'success', text: '正在合成试听…' });
      const voiceType = tts.volcengine.voiceType === '__custom__'
        ? (customVoice.trim() || undefined)
        : (tts.volcengine.voiceType || undefined);
      // 试听跟随界面当前选择（传 provider/apiKey 覆盖已保存配置，实现所见即所得）
      const { audioBase64, format } = await api.tts({
        text: '你好，这是直播播报音色试听，请确认声音自然好听。',
        voiceType,
        provider: 'volcengine',
        apiKey: tts.volcengine.apiKey,
      });
      // 用 blob URL 播放（兼容性最好，避免 data URL 播 OGG/大音频失败）
      const mime = format === 'ogg' ? 'audio/ogg' : format === 'wav' ? 'audio/wav' : 'audio/mpeg';
      const binary = atob(audioBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
      const audio = new Audio(url);
      audio.onended = () => {
        URL.revokeObjectURL(url);
        setNotice({ tone: 'success', text: '✓ 试听播放完毕；保存后直播播报即用此音色。' });
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        setNotice({ tone: 'error', text: `音频无法播放（格式 ${format ?? 'mp3'}，${bytes.length} 字节）。请把此提示原样发给技术处理。` });
      };
      await audio.play();
      setNotice({ tone: 'success', text: '正在播放试听，请留意声音…' });
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '音色试听失败' });
      onError(error instanceof Error ? error.message : '音色试听失败');
    } finally {
      setTesting(false);
    }
  }


  return (
    <section className="voice-settings">
      <div className="panel-heading"><Volume2 aria-hidden="true" /><div><h2>播报音色（火山·豆包语音）</h2><p>填一个 API Key + 选音色即可，火山全量音色可选；没填 Key 时播报自动用系统声音兜底。</p></div></div>
      <div className="voice-form">
        <label className="wide"><span>API Key（火山控制台「API 管理」复制，必填）</span><input value={tts.volcengine.apiKey} onChange={(e) => setTts({ ...tts, volcengine: { ...tts.volcengine, apiKey: e.target.value } })} placeholder="登录 console.volcengine.com/speech → 语音技术控制台「API 管理」→ 创建并复制（sk- 开头）；只保存在本机" /><small>豆包语音合成大模型鉴权（X-Api-Key）：填这一个 Key 就够了，不需要 AppID/Token/接入点。</small></label>
        <label className="wide"><span>音色（火山全量，按场景分组）</span><select value={tts.volcengine.voiceType} onChange={(e) => setTts({ ...tts, volcengine: { ...tts.volcengine, voiceType: e.target.value } })}>
          {Array.from(new Set(VOLC_BIG_VOICES.map((item) => item.group))).map((group) => (
            <optgroup key={group} label={group}>
              {VOLC_BIG_VOICES.filter((item) => item.group === group).map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </optgroup>
          ))}
          <option value="__custom__">… 自定义音色代码（下方输入）</option>
        </select>
        {tts.volcengine.voiceType === '__custom__' && <input className="wide" value={customVoice} onChange={(e) => setCustomVoice(e.target.value)} placeholder="填入官方音色代码，如 zh_female_vv_uranus_bigtts；选好点「试听音色」" />}
        <small>1.0 音色（灿灿/云扬等）与大模型 2.0 音色（Vivi/小何等）程序会自动匹配版本；想用列表外音色选「自定义」填入代码即可。</small></label>
        <button className="secondary-action wide" type="button" disabled={testing || (!tts.volcengine.apiKey && !tts.volcengine.accessToken)} onClick={() => void testVoice()}>{testing ? <LoaderCircle className="spin" /> : <Volume2 />}试听音色</button>
        {notice && <p className={`voice-test-result ${notice.tone}`}>{notice.text}</p>}
        <div className="form-actions wide"><button className="primary-action" type="button" disabled={saving} onClick={() => void save()}>{saving ? <LoaderCircle className="spin" /> : <Check />}保存音色设置</button></div>
      </div>
    </section>
  );
}

/** v31.1：话术稿与本地音频——自动同步直播流程稿，一键预生成音频存本地；直播时命中本地音频播放，不消耗 API */
function PregenScripts({ scripts, runSheet, onSave, onError }: {
  scripts: string[];
  runSheet: RunSheetSegment[];
  onSave: (scripts: string[]) => Promise<void>;
  onError: (message: string) => void;
}) {
  // 首次打开：已保存的话术稿优先；为空则自动从直播流程（run sheet）导入，不用老板手粘
  const [text, setText] = useState<string>(() => {
    const saved = scripts.join('\n').trim();
    if (saved) return saved;
    return Array.from(new Set(runSheet.map((s) => s.script.trim()).filter(Boolean))).join('\n');
  });
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [result, setResult] = useState<{ ok: number; cached: number; failed: number } | null>(null);

  /** 从直播流程重新导入（去重追加） */
  function importFromRunSheet() {
    const current = text.split('\n').map((s) => s.trim()).filter(Boolean);
    const merged = Array.from(new Set([...current, ...runSheet.map((s) => s.script.trim()).filter(Boolean)]));
    setText(merged.join('\n'));
    setNotice({ tone: 'success', text: `✓ 已从直播流程导入话术（共 ${merged.length} 条）。点「保存话术稿」后即可生成音频。` });
  }

  const lines = () => text.split('\n').map((s) => s.trim()).filter(Boolean);

  async function saveScripts() {
    setSaving(true);
    setNotice(null);
    try {
      await onSave(lines());
      setNotice({ tone: 'success', text: `✓ 话术稿已保存（${lines().length} 条）。` });
    } catch (error) {
      onError(error instanceof Error ? error.message : '话术稿保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function generateAll() {
    const list = lines();
    if (list.length === 0) {
      setNotice({ tone: 'error', text: '请先填写至少一条话术。' });
      return;
    }
    setGenerating(true);
    setNotice(null);
    setResult(null);
    try {
      await onSave(list);
      let ok = 0;
      let cached = 0;
      let failed = 0;
      for (const line of list) {
        try {
          const res = await api.ttsPregen({ text: line });
          if (res.cached) cached += 1; else ok += 1;
        } catch {
          failed += 1;
        }
      }
      setResult({ ok, cached, failed });
      setNotice({ tone: 'success', text: `✓ 生成完成：新生成 ${ok} 条，命中本地缓存 ${cached} 条${failed > 0 ? `，失败 ${failed} 条（可单独重试）` : ''}。` });
    } catch (error) {
      onError(error instanceof Error ? error.message : '话术音频生成失败');
    } finally {
      setGenerating(false);
    }
  }

  return (
    <section className="voice-settings">
      <div className="panel-heading"><FileAudio aria-hidden="true" /><div><h2>话术稿与本地音频（省钱模式）</h2><p>已自动同步<b>直播流程的稿子</b>（也可手动改）；一键生成音频存本机，直播播到相同内容<b>直接播本地音频，不再消耗 API 费用</b>。每行一条话术。</p></div></div>
      <div className="voice-form">
        <label className="wide"><span>直播话术稿（每行一条，会原样播报）</span><textarea className="script-editor" rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={'欢迎各位来到直播间，今天我们给大家带来了…\n这个商品日常价 99，今天直播间只要 69…\n喜欢的家人点点关注，有问题随时问…'} /></label>
        <div className="form-actions wide">
          <button className="secondary-action" type="button" onClick={importFromRunSheet}><RefreshCw aria-hidden="true" />重新导入直播流程话术</button>
          <button className="secondary-action" type="button" disabled={saving} onClick={() => void saveScripts()}>{saving ? <LoaderCircle className="spin" /> : <Save />}保存话术稿</button>
          <button className="primary-action" type="button" disabled={generating} onClick={() => void generateAll()}>{generating ? <LoaderCircle className="spin" /> : <Wand2 />}生成全部音频（本地）</button>
        </div>
        {result && <p className="voice-test-result success">生成结果：新生成 {result.ok} 条 · 已有缓存 {result.cached} 条 · 失败 {result.failed} 条</p>}
        {notice && <p className={`voice-test-result ${notice.tone}`}>{notice.text}</p>}
        <small>提示：直播中临时播报未在稿子里的内容仍会实时合成（自动缓存，下次同内容零费用）。</small>
      </div>
    </section>
  );
}

/** v32：直播画面形态（摄像头 / 录屏视频素材免摄像头） */
function ScreenPlaySettings({ screenPlay, onRefresh, onError }: {
  screenPlay: StoreConfig['screenPlay'];
  onRefresh: () => void;
  onError: (message: string) => void;
}) {
  const [provider, setProvider] = useState<'camera' | 'video'>(screenPlay?.provider ?? 'camera');
  const [videoFileName, setVideoFileName] = useState(screenPlay?.videoFileName ?? '');
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  async function pickVideo(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    setNotice(null);
    try {
      const res = await api.uploadVideo(file);
      setVideoFileName(res.fileName);
      setNotice({ tone: 'success', text: `✓ 视频已上传（${(res.size / 1024 / 1024).toFixed(1)} MB），点「保存画面设置」后直播输出窗口即循环播放。` });
    } catch (error) {
      onError(error instanceof Error ? error.message : '视频上传失败');
    } finally {
      setUploading(false);
    }
  }

  async function save() {
    setSaving(true);
    setNotice(null);
    try {
      await api.saveConfig({ screenPlay: { provider, videoFileName, videoPersona: '' } });
      await onRefresh();
      setNotice({ tone: 'success', text: provider === 'video'
        ? '✓ 已切换为录屏视频模式（不需要摄像头）。直播伴侣用「窗口捕获」选本系统的直播输出窗口即可播出画面。'
        : '✓ 已切换为摄像头模式。' });
    } catch (error) {
      onError(error instanceof Error ? error.message : '画面设置保存失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="voice-settings">
      <div className="panel-heading"><MonitorPlay aria-hidden="true" /><div><h2>直播画面</h2><p>摄像头模式：俯拍真实作业台；录屏视频模式：循环播放视频素材，<b>不需要摄像头、不需要摄像头授权</b>。</p></div></div>
      <div className="voice-form">
        <label className="wide"><span>画面来源</span><select value={provider} onChange={(e) => setProvider(e.target.value as 'camera' | 'video')}>
          <option value="video">录屏视频素材（免摄像头，推荐）</option>
          <option value="camera">摄像头（俯拍真实作业台）</option>
        </select></label>
        {provider === 'video' ? (
          <>
            <label className="wide"><span>录屏视频素材（mp4/webm/mov，≤300MB）</span>
              <input type="file" accept="video/mp4,video/webm,video/quicktime" onChange={(e) => void pickVideo(e.target.files?.[0])} />
              {videoFileName && <small>已选素材：{videoFileName}（保存后直播输出窗口自动循环播放；直播伴侣「添加素材→窗口」选本系统输出窗口即可播出）</small>}
            </label>
          </>
        ) : (
          <small>摄像头模式：直播输出窗口会要求选择俯拍摄像头；请确保画面只有作业台、无人脸。</small>
        )}
        <div className="form-actions wide"><button className="primary-action" type="button" disabled={saving || uploading} onClick={() => void save()}>{saving || uploading ? <LoaderCircle className="spin" /> : <Check />}保存画面设置</button></div>
        {notice && <p className={`voice-test-result ${notice.tone}`}>{notice.text}</p>}
      </div>
    </section>
  );
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
