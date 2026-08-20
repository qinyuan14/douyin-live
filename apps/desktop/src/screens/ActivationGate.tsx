import { useState } from 'react';
import { Copy, KeyRound, LoaderCircle, ShieldCheck, ShieldX } from 'lucide-react';
import { api } from '../api.js';
import { CatMark } from '../components/Icons.js';

/**
 * 激活门禁（任务E·阶段3）：未激活时拦截主界面。
 * 买家把机器码发给卖家 → 卖家生成授权码 → 买家粘贴激活。
 * 授权码绑定机器码，激活文件拷贝到别的机器无效（防复制传播）。
 */
export function ActivationGate({ machineId, onActivated }: { machineId: string; onActivated: () => Promise<void> | void }) {
  const [code, setCode] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function copyMachineId() {
    try {
      await navigator.clipboard.writeText(machineId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setError('复制失败，请手动选择机器码复制。');
    }
  }

  async function submit() {
    if (!code.trim()) return setError('请粘贴卖家发给你的激活码。');
    setSaving(true);
    setError(null);
    try {
      const result = await api.activate(code.trim());
      if (!result.activated) {
        setError(result.reason ?? '激活失败');
        setSaving(false);
        return;
      }
      await onActivated();
    } catch (err) {
      setError(err instanceof Error ? err.message : '激活失败');
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
          <KeyRound aria-hidden="true" />
          <strong>离线授权激活</strong>
          <span>授权码绑定本机，拷贝到别的电脑无效</span>
        </div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <div>
            <h1>欢迎使用实景直播经营系统</h1>
            <p>本工具为付费软件，首次使用需要输入授权码激活。</p>
          </div>
        </header>
        <section className="offer-form-section">
          <div className="panel-heading"><KeyRound aria-hidden="true" /><div><h2>第 1 步 · 把本机机器码发给卖家</h2><p>授权码与这台电脑一一绑定，换电脑需要卖家重新生成。</p></div></div>
          <div className="offer-form">
            <label className="wide"><span>本机机器码</span><input readOnly value={machineId} onFocus={(e) => e.target.select()} /></label>
            <div className="form-actions wide">
              <button className="secondary-action" type="button" onClick={() => void copyMachineId()}><Copy aria-hidden="true" />{copied ? '已复制' : '复制机器码'}</button>
            </div>
          </div>
        </section>
        <section className="offer-form-section">
          <div className="panel-heading"><ShieldCheck aria-hidden="true" /><div><h2>第 2 步 · 粘贴授权码</h2><p>卖家根据你的机器码生成激活码后，粘贴到这里即可完成激活。</p></div></div>
          <div className="offer-form">
            <label className="wide"><span>激活码</span><input value={code} onChange={(e) => setCode(e.target.value)} placeholder="粘贴 v1.xxxx 开头的激活码" /></label>
            {error && <div className="notice error" role="alert"><ShieldX aria-hidden="true" /><span>{error}</span></div>}
            <div className="form-actions wide">
              <button className="primary-action" type="button" onClick={() => void submit()} disabled={saving}>
                {saving ? <LoaderCircle className="spin" aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}激活并进入系统
              </button>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
