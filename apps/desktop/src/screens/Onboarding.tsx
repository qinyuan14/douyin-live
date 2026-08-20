import { useState } from 'react';
import { Check, LoaderCircle, MapPin, PackageCheck, ShieldAlert, Store, Tag } from 'lucide-react';
import { api } from '../api.js';
import { CatMark } from '../components/Icons.js';

/**
 * 首次启动向导（任务E·阶段2）：引导商家填写自己的品牌名、副标语、
 * 真实可执行的服务范围与商品类目，并显式确认服务范围后落库。
 * 未完成向导前，主界面保持初始化状态（门禁 service-area 保持 BLOCKED）。
 */
export function Onboarding({ onCompleted }: { onCompleted: () => Promise<void> | void }) {
  const [storeName, setStoreName] = useState('');
  const [tagline, setTagline] = useState('');
  const [serviceAreasText, setServiceAreasText] = useState('');
  const [productCategoriesText, setProductCategoriesText] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function splitList(text: string): string[] {
    return text.split(/[,，、\n]/).map((item) => item.trim()).filter(Boolean);
  }

  async function submit() {
    const serviceAreas = splitList(serviceAreasText);
    const productCategories = splitList(productCategoriesText);
    if (!storeName.trim()) return setError('请填写你的品牌名或店名。');
    if (serviceAreas.length === 0) return setError('请至少填写一个真实可执行的服务范围。');
    if (productCategories.length === 0) return setError('请至少填写一个你经营的商品或服务类目。');
    if (!confirmed) return setError('请勾选确认：以上服务范围真实可执行，且服务范围外一律由员工人工确认。');
    setSaving(true);
    setError(null);
    try {
      await api.saveConfig({
        storeName: storeName.trim(),
        tagline: tagline.trim(),
        serviceAreas,
        serviceAreasConfirmed: true,
        productCategories,
        onboardingCompleted: true,
      });
      await onCompleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : '初始化保存失败');
      setSaving(false);
    }
  }

  return (
    <div className="app-shell onboarding-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <CatMark />
          <div><strong>实景直播</strong><span>经营系统</span></div>
        </div>
        <div className="sidebar-guard">
          <ShieldAlert aria-hidden="true" />
          <strong>本地初始化向导</strong>
          <span>只在本机保存你的经营配置，不登录任何外部平台</span>
        </div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <div>
            <h1>首次启动 · 初始化你的直播间经营信息</h1>
            <p>这些信息用于输出画面、商品快照与开播门禁校验，全部只保存在本机。</p>
          </div>
        </header>
        <section className="offer-form-section">
          <div className="panel-heading"><Store aria-hidden="true" /><div><h2>品牌与经营信息</h2><p>将显示在直播输出画面的品牌锁标与服务范围中。</p></div></div>
          <div className="offer-form">
            <label className="wide"><span>品牌名 / 店名</span><input value={storeName} onChange={(e) => setStoreName(e.target.value)} placeholder="例如：我的小店" /></label>
            <label className="wide"><span>副标语（可空）</span><input value={tagline} onChange={(e) => setTagline(e.target.value)} placeholder="例如：AI主持｜真实作业" /></label>
            <label className="wide"><span>真实可执行的服务范围（每行一个，或逗号分隔）</span><textarea rows={3} value={serviceAreasText} onChange={(e) => setServiceAreasText(e.target.value)} placeholder={`例如：\n主城区\n东城区`} /></label>
            <label className="wide"><span>经营的商品 / 服务类目（每行一个，或逗号分隔）</span><textarea rows={3} value={productCategoriesText} onChange={(e) => setProductCategoriesText(e.target.value)} placeholder={`例如：\n常规洗护服务\n箱包清洁`} /></label>
            <label className="check-field wide"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /><span>我确认以上服务范围真实可执行；服务范围外的需求一律由员工人工确认后承接。</span></label>
            {error && <div className="notice error" role="alert"><ShieldAlert aria-hidden="true" /><span>{error}</span></div>}
            <div className="form-actions wide">
              <button className="primary-action" type="button" onClick={() => void submit()} disabled={saving}>
                {saving ? <LoaderCircle className="spin" aria-hidden="true" /> : <Check aria-hidden="true" />}保存并进入系统
              </button>
            </div>
          </div>
        </section>
        <section className="offer-form-section">
          <div className="panel-heading"><MapPin aria-hidden="true" /><div><h2>说明</h2><p>服务范围确认后，门禁「服务范围已确认且可执行」才会通过；服务范围外不会由 AI 自动承诺。商品类目用于新建商品快照时的默认类目。</p></div></div>
        </section>
      </main>
    </div>
  );
}
