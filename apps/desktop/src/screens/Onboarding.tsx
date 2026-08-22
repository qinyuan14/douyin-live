import { useEffect, useRef, useState } from 'react';
import { Check, LoaderCircle, MapPin, Mic2, PackageCheck, ShieldAlert, ShoppingBag, Store, Volume2 } from 'lucide-react';
import { api } from '../api.js';
import { CatMark } from '../components/Icons.js';
import { createLiveChannel } from '../broadcast.js';

/**
 * 首次启动向导（小白商用 v2：4 步，一次性完成全部设置，之后打开即用）。
 * ① 店铺信息 → ② 商品信息（含三项确认） → ③ 声音与监护（试听+三项确认） → ④ 完成。
 * 完成后落盘 setupCompleted=true + hardwareConfirmed=true，日常不再重复配置。
 */
export function Onboarding({ existingOfferTitle, onCompleted }: { existingOfferTitle: string | null; onCompleted: () => Promise<void> | void }) {
  const [step, setStep] = useState(1);
  // ① 店铺信息
  const [storeName, setStoreName] = useState('');
  const [tagline, setTagline] = useState('');
  const [serviceAreasText, setServiceAreasText] = useState('');
  const [productCategoriesText, setProductCategoriesText] = useState('');
  const [areasConfirmed, setAreasConfirmed] = useState(false);
  // ② 商品信息
  const [offerTitle, setOfferTitle] = useState('新客常规服务｜1次');
  const [offerPrice, setOfferPrice] = useState('9.90');
  const [offerConfirmed, setOfferConfirmed] = useState(false);
  const [costConfirmed, setCostConfirmed] = useState(false);
  const [assetConfirmed, setAssetConfirmed] = useState(false);
  // ③ 声音与监护
  const [framingConfirmed, setFramingConfirmed] = useState(false);
  const [takeoverConfirmed, setTakeoverConfirmed] = useState(false);
  const [voiceTestPending, setVoiceTestPending] = useState(false);
  const [voiceTestGenerated, setVoiceTestGenerated] = useState(false);
  const [voiceHeard, setVoiceHeard] = useState(false);
  const channelRef = useRef<BroadcastChannel | null>(null);
  // 通用
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const channel = createLiveChannel();
    channelRef.current = channel;
    channel.onmessage = (event: MessageEvent<{ type: string; id: string; generated: boolean }>) => {
      const message = event.data;
      if (message.type === 'voice-test-result') {
        setVoiceTestPending(false);
        setVoiceTestGenerated(message.generated);
        if (message.generated) setVoiceHeard(true);
      }
    };
    return () => channel.close();
  }, []);

  function splitList(text: string): string[] {
    return text.split(/[,，、\n]/).map((item) => item.trim()).filter(Boolean);
  }

  function testVoice() {
    if (voiceTestPending) return;
    setVoiceTestPending(true);
    setVoiceTestGenerated(false);
    channelRef.current?.postMessage({ type: 'voice-test', id: crypto.randomUUID() });
  }

  function nextFromStep1() {
    const serviceAreas = splitList(serviceAreasText);
    if (!storeName.trim()) return setError('请填写你的品牌名或店名。');
    if (serviceAreas.length === 0) return setError('请至少填写一个真实可执行的服务范围。');
    if (splitList(productCategoriesText).length === 0) return setError('请至少填写一个你经营的商品或服务类目。');
    if (!areasConfirmed) return setError('请勾选确认服务范围真实可执行。');
    setError(null);
    setStep(2);
  }

  function nextFromStep2() {
    if (!offerTitle.trim() || !offerPrice.trim()) return setError('请填写商品名称和价格。');
    if (!offerConfirmed || !costConfirmed || !assetConfirmed) return setError('请勾选下方三项确认（都是商家应尽的合规底线）。');
    setError(null);
    setStep(3);
  }

  function nextFromStep3() {
    if (!framingConfirmed) return setError('请确认直播画面形态（数字人形象或俯拍，无真人出镜）。');
    if (!voiceHeard) return setError('请先试听声音，并确认能听见。');
    if (!takeoverConfirmed) return setError('请确认直播时有人值守、可随时接管。');
    setError(null);
    setStep(4);
  }

  async function finish() {
    setSaving(true);
    setError(null);
    try {
      const serviceAreas = splitList(serviceAreasText);
      const productCategories = splitList(productCategoriesText);
      await api.saveConfig({
        storeName: storeName.trim(),
        tagline: tagline.trim(),
        serviceAreas,
        serviceAreasConfirmed: true,
        productCategories,
        onboardingCompleted: true,
        hardwareConfirmed: true,
        setupCompleted: true,
      });
      // 商品信息（若当前没有有效商品则保存一条；已有则沿用）
      if (!existingOfferTitle) {
        const capturedAt = new Date().toISOString();
        await api.saveOffer({
          id: crypto.randomUUID(),
          productId: '',
          title: offerTitle.trim(),
          priceCents: Math.round(Number(offerPrice) * 100),
          regularPriceCents: null,
          shoeTypes: productCategories.length > 0 ? productCategories : ['常规品类'],
          serviceAreas,
          evidenceRefs: [],
          selfChecks: { offerConfirmed, costConfirmed, assetConfirmed },
          capturedAt,
          validUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(),
          status: 'ACTIVE',
        });
      }
      // 监护三项落盘（画面/语音/接管），与 updateHardware 内存态同步
      await api.updateHardware({ cameraFramingConfirmed: true, voiceReady: voiceHeard, takeoverReady: true });
      await onCompleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : '初始化保存失败');
      setSaving(false);
    }
  }

  const stepLabels = ['店铺信息', '商品信息', '声音与监护', '完成'];

  return (
    <div className="app-shell onboarding-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <CatMark />
          <div><strong>实景直播</strong><span>经营系统</span></div>
        </div>
        <div className="sidebar-guard">
          <ShieldAlert aria-hidden="true" />
          <strong>首次设置向导</strong>
          <span>一次性完成，约 5 分钟；之后打开即用，只在本机保存</span>
        </div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <div>
            <h1>欢迎使用 · 先完成 4 步初始化</h1>
            <p>做完这些设置，以后每天打开就能直接开播。</p>
          </div>
        </header>
        <div className="onboarding-steps" aria-label="初始化步骤">
          {stepLabels.map((label, index) => (
            <div key={label} className={`onboarding-step ${step === index + 1 ? 'active' : ''} ${step > index + 1 ? 'done' : ''}`}>
              <span>{step > index + 1 ? <Check /> : index + 1}</span>
              <strong>{label}</strong>
            </div>
          ))}
        </div>

        {step === 1 && (
          <section className="offer-form-section">
            <div className="panel-heading"><Store aria-hidden="true" /><div><h2>① 店铺信息</h2><p>将显示在直播画面的品牌标和服务范围中。</p></div></div>
            <div className="offer-form">
              <label className="wide"><span>品牌名 / 店名</span><input value={storeName} onChange={(e) => setStoreName(e.target.value)} placeholder="例如：我的小店" /></label>
              <label className="wide"><span>副标语（可空）</span><input value={tagline} onChange={(e) => setTagline(e.target.value)} placeholder="例如：AI主持｜真实作业" /></label>
              <label className="wide"><span>服务范围（每行一个，或逗号分隔）</span><textarea rows={3} value={serviceAreasText} onChange={(e) => setServiceAreasText(e.target.value)} placeholder={'例如：\n主城区\n东城区'} /></label>
              <label className="wide"><span>经营的商品 / 服务类目（每行一个，或逗号分隔）</span><textarea rows={3} value={productCategoriesText} onChange={(e) => setProductCategoriesText(e.target.value)} placeholder={'例如：\n常规洗护服务\n箱包清洁'} /></label>
              <label className="check-field wide"><input type="checkbox" checked={areasConfirmed} onChange={(e) => setAreasConfirmed(e.target.checked)} /><span>我确认以上服务范围真实可执行；服务范围外的需求一律由员工人工确认后承接。</span></label>
              {error && <div className="notice error" role="alert"><ShieldAlert aria-hidden="true" /><span>{error}</span></div>}
              <div className="form-actions wide"><button className="primary-action" type="button" onClick={nextFromStep1}><Check />下一步</button></div>
            </div>
          </section>
        )}

        {step === 2 && (
          <section className="offer-form-section">
            <div className="panel-heading"><ShoppingBag aria-hidden="true" /><div><h2>② 商品信息</h2><p>{existingOfferTitle ? `已有商品「${existingOfferTitle}」，可填写新商品或保持默认继续。` : '填一个你真正在卖的商品，AI 播报会照着这个名称和价格说。'}</p></div></div>
            <div className="offer-form">
              <label className="wide"><span>商品名称</span><input value={offerTitle} onChange={(e) => setOfferTitle(e.target.value)} /></label>
              <label><span>新客成交价（元）</span><input type="number" min="0.01" step="0.01" value={offerPrice} onChange={(e) => setOfferPrice(e.target.value)} /></label>
              <label className="check-field wide"><input type="checkbox" checked={offerConfirmed} onChange={(e) => setOfferConfirmed(e.target.checked)} /><span>我确认：这个商品真实存在、价格与店内一致</span></label>
              <label className="check-field wide"><input type="checkbox" checked={costConfirmed} onChange={(e) => setCostConfirmed(e.target.checked)} /><span>我确认：售价按真实成本经营，不构成超低价</span></label>
              <label className="check-field wide"><input type="checkbox" checked={assetConfirmed} onChange={(e) => setAssetConfirmed(e.target.checked)} /><span>我确认：直播画面用到的图片/视频/音乐/语音都是自有拍摄或已获授权</span></label>
              {error && <div className="notice error" role="alert"><ShieldAlert aria-hidden="true" /><span>{error}</span></div>}
              <div className="form-actions wide"><button className="secondary-action" type="button" onClick={() => setStep(1)}>上一步</button><button className="primary-action" type="button" onClick={nextFromStep2}><Check />下一步</button></div>
            </div>
          </section>
        )}

        {step === 3 && (
          <section className="offer-form-section">
            <div className="panel-heading"><Mic2 aria-hidden="true" /><div><h2>③ 声音与监护</h2><p>确认声音能听见、有人值守可接管。声音默认用电脑自带语音（免费），以后可在设置里换更自然的声音。</p></div></div>
            <div className="offer-form">
              <label className="check-field wide"><input type="checkbox" checked={framingConfirmed} onChange={(e) => setFramingConfirmed(e.target.checked)} /><span>我确认：直播画面使用数字人形象或俯拍画面，没有真人出镜</span></label>
              <div className="wide voice-form">
                <button className="secondary-action" type="button" disabled={voiceTestPending} onClick={testVoice}>{voiceTestPending ? <LoaderCircle className="spin" /> : <Volume2 />}试听声音{voiceTestGenerated ? '（已试听 ✓）' : ''}</button>
              </div>
              <label className="check-field wide"><input type="checkbox" checked={voiceHeard} onChange={(e) => setVoiceHeard(e.target.checked)} /><span>我确认：已经能听到 AI 播报的声音（试听后自动勾选）</span></label>
              <label className="check-field wide"><input type="checkbox" checked={takeoverConfirmed} onChange={(e) => setTakeoverConfirmed(e.target.checked)} /><span>我确认：直播时有人值守，真人声音随时可接管（平台对 AI 直播的要求）</span></label>
              {error && <div className="notice error" role="alert"><ShieldAlert aria-hidden="true" /><span>{error}</span></div>}
              <div className="form-actions wide"><button className="secondary-action" type="button" onClick={() => setStep(2)}>上一步</button><button className="primary-action" type="button" onClick={nextFromStep3}><Check />下一步</button></div>
            </div>
          </section>
        )}

        {step === 4 && (
          <section className="offer-form-section">
            <div className="panel-heading"><PackageCheck aria-hidden="true" /><div><h2>④ 完成</h2><p>设置已就绪！以后每天打开系统，点「一键开播」就能开始直播；真人只负责监管。</p></div></div>
            <div className="offer-form">
              <p className="wide onboarding-summary">✓ 店铺：{storeName.trim() || '未填'}　✓ 商品：{existingOfferTitle ?? offerTitle.trim()}（¥{offerPrice}）　✓ 声音与监护：已确认</p>
              {error && <div className="notice error" role="alert"><ShieldAlert aria-hidden="true" /><span>{error}</span></div>}
              <div className="form-actions wide">
                <button className="secondary-action" type="button" onClick={() => setStep(3)}>上一步</button>
                <button className="primary-action" type="button" onClick={() => void finish()} disabled={saving}>{saving ? <LoaderCircle className="spin" /> : <Check />}完成，进入系统</button>
              </div>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
