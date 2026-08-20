import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, CircleAlert, MapPin, RefreshCw, ShieldCheck, Sparkles, Volume2 } from 'lucide-react';
import { api } from '../api.js';
import { createLiveChannel, type LiveMessage } from '../broadcast.js';
import { splitCaption } from '../lib/captions.js';
import { selectCurrentOffer } from '../lib/offers.js';

function chooseChineseVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  return voices.find((voice) => voice.lang.toLowerCase().startsWith('zh-cn'))
    ?? voices.find((voice) => voice.lang.toLowerCase().startsWith('zh'))
    ?? null;
}

function isSpeechBlocked(state: string): boolean {
  return ['PAUSED', 'STOPPED', 'COMPLETED'].includes(state);
}

export function OutputApp() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const stateRef = useRef('PREFLIGHT_BLOCKED');
  const connectedRef = useRef(false);
  const speechSequenceRef = useRef(0);
  const [caption, setCaption] = useState('真实洗护现场准备中');
  const [scene, setScene] = useState('WORKBENCH');
  const [state, setState] = useState('PREFLIGHT_BLOCKED');
  const [offerTitle, setOfferTitle] = useState<string | null>(null);
  const [priceCents, setPriceCents] = useState<number | null>(null);
  const [cameraStatus, setCameraStatus] = useState<'idle' | 'scanning' | 'preview' | 'ready' | 'error'>('idle');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const [cameraMessage, setCameraMessage] = useState('先扫描设备，再明确选择专用俯拍摄像头');
  const [serviceConnected, setServiceConnected] = useState(false);
  const [clock, setClock] = useState(new Date());
  const [speaking, setSpeaking] = useState(false);
  const qaSafe = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('qa') === 'safe';

  const stopSpeech = useCallback((reason: string) => {
    speechSequenceRef.current += 1;
    window.speechSynthesis.cancel();
    setSpeaking(false);
    setCaption(reason);
  }, []);

  const applyState = useCallback((nextState: string) => {
    stateRef.current = nextState;
    setState(nextState);
    if (isSpeechBlocked(nextState)) stopSpeech(nextState === 'PAUSED' ? 'AI播报已暂停，请员工接管' : '本场AI播报已停止');
  }, [stopSpeech]);

  const refreshStatus = useCallback(async () => {
    try {
      const data = await api.bootstrap();
      const activeOffer = selectCurrentOffer(data.offers);
      connectedRef.current = true;
      setServiceConnected(true);
      applyState(data.session?.state ?? 'PREFLIGHT_BLOCKED');
      setOfferTitle(activeOffer?.title ?? null);
      setPriceCents(activeOffer?.priceCents ?? null);
    } catch {
      connectedRef.current = false;
      setServiceConnected(false);
      setOfferTitle(null);
      setPriceCents(null);
      stopSpeech('本地服务未连接，AI播报已停止');
    }
  }, [applyState, stopSpeech]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), 1_000);
    return () => window.clearInterval(timer);
  }, [refreshStatus]);

  const speak = useCallback((message: Extract<LiveMessage, { type: 'speak' }>) => {
    if (!connectedRef.current) {
      stopSpeech('本地服务未连接，AI播报已停止');
      return;
    }
    if (isSpeechBlocked(stateRef.current) || (message.mode === 'LIVE' && stateRef.current !== 'LIVE')) {
      stopSpeech('当前场次状态不允许AI播报');
      return;
    }
    const chunks = splitCaption(message.text);
    if (chunks.length === 0) return;
    const sequence = speechSequenceRef.current + 1;
    speechSequenceRef.current = sequence;
    window.speechSynthesis.cancel();
    const speakNext = (index: number) => {
      if (sequence !== speechSequenceRef.current || !connectedRef.current || isSpeechBlocked(stateRef.current)) return;
      const chunk = chunks[index];
      if (!chunk) {
        setSpeaking(false);
        return;
      }
      const utterance = new SpeechSynthesisUtterance(chunk);
      utterance.lang = 'zh-CN';
      utterance.rate = 0.96;
      utterance.pitch = 1.04;
      utterance.volume = 1;
      const voice = chooseChineseVoice();
      if (voice) utterance.voice = voice;
      utterance.onstart = () => { setSpeaking(true); setCaption(chunk); };
      utterance.onend = () => speakNext(index + 1);
      utterance.onerror = () => {
        stopSpeech('本地语音异常，请员工使用真人声音接管');
        void api.updateHardware({ voiceReady: false }).catch(() => {
          connectedRef.current = false;
          setServiceConnected(false);
        });
      };
      window.speechSynthesis.speak(utterance);
    };
    speakNext(0);
  }, [stopSpeech]);

  useEffect(() => {
    const channel = createLiveChannel();
    channel.onmessage = (event: MessageEvent<LiveMessage>) => {
      const message = event.data;
      if (message.type === 'caption') setCaption(splitCaption(message.text)[0] ?? '');
      if (message.type === 'scene') setScene(message.scene);
      if (message.type === 'state') {
        applyState(message.state);
        setOfferTitle(message.offerTitle);
        setPriceCents(message.priceCents);
      }
      if (message.type === 'stop-speech') stopSpeech(message.reason);
      if (message.type === 'speak') speak(message);
      if (message.type === 'voice-test') {
        const voice = chooseChineseVoice();
        if (!voice) {
          channel.postMessage({ type: 'voice-test-result', id: message.id, generated: false, voiceName: null });
          void api.updateHardware({ voiceReady: false });
          return;
        }
        const utterance = new SpeechSynthesisUtterance('实景直播中文语音试听。请员工确认已经听见，而且声音进入了正确的直播输出线路。');
        utterance.voice = voice;
        utterance.lang = 'zh-CN';
        utterance.onend = () => {
          channel.postMessage({ type: 'voice-test-result', id: message.id, generated: true, voiceName: voice.name });
        };
        utterance.onerror = () => {
          channel.postMessage({ type: 'voice-test-result', id: message.id, generated: false, voiceName: voice.name });
          void api.updateHardware({ voiceReady: false });
        };
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(utterance);
      }
    };
    return () => channel.close();
  }, [applyState, speak, stopSpeech]);

  const revokeCamera = useCallback(async (reason: string) => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setCameraStatus('error');
    setCameraMessage(reason);
    stopSpeech(`${reason}，AI播报已停止`);
    try {
      await api.updateHardware({ cameraStreamActive: false, cameraFramingConfirmed: false });
    } catch {
      connectedRef.current = false;
      setServiceConnected(false);
    }
  }, [stopSpeech]);

  async function scanCameras() {
    setCameraStatus('scanning');
    try {
      const permissionProbe = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      permissionProbe.getTracks().forEach((track) => track.stop());
      const found = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'videoinput');
      setDevices(found);
      setSelectedDeviceId('');
      setCameraStatus(found.length > 0 ? 'idle' : 'error');
      setCameraMessage(found.length > 0 ? '请选择专用俯拍摄像头，系统不会自动选默认设备' : '没有检测到摄像头');
    } catch {
      setCameraStatus('error');
      setCameraMessage('无法读取摄像头，请检查设备和系统权限');
    }
  }

  async function previewSelectedCamera() {
    if (!selectedDeviceId) return;
    try {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: selectedDeviceId }, width: { ideal: 1080 }, height: { ideal: 1920 } },
        audio: false,
      });
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error('所选摄像头没有视频轨道');
      const fail = () => void revokeCamera('俯拍摄像头已中断');
      track.addEventListener('ended', fail, { once: true });
      track.addEventListener('mute', fail, { once: true });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraStatus('preview');
      setCameraMessage('请检查整个画面，只能包含洗护台和鞋子，不能出现员工人脸');
      const selected = devices.find((device) => device.deviceId === selectedDeviceId);
      await api.updateHardware({
        cameraDeviceId: selectedDeviceId,
        cameraLabel: selected?.label || '已选择的摄像头',
        cameraStreamActive: true,
        cameraFramingConfirmed: false,
      });
    } catch {
      await revokeCamera('所选俯拍摄像头无法打开');
    }
  }

  async function confirmFraming() {
    if (!streamRef.current?.active || !selectedDeviceId) return;
    const selected = devices.find((device) => device.deviceId === selectedDeviceId);
    await api.updateHardware({
      cameraDeviceId: selectedDeviceId,
      cameraLabel: selected?.label || '已选择的摄像头',
      cameraStreamActive: true,
      cameraFramingConfirmed: true,
    });
    setCameraStatus('ready');
    setCameraMessage('专用俯拍摄像头和无人脸取景已确认');
  }

  useEffect(() => {
    const handleDeviceChange = async () => {
      if (!selectedDeviceId) return;
      const available = await navigator.mediaDevices.enumerateDevices();
      if (!available.some((device) => device.kind === 'videoinput' && device.deviceId === selectedDeviceId)) {
        await revokeCamera('已选择的俯拍摄像头被移除');
      }
    };
    navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange);
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      void api.updateHardware({ cameraStreamActive: false, cameraFramingConfirmed: false }).catch(() => undefined);
    };
  }, [revokeCamera, selectedDeviceId]);

  const live = state === 'LIVE';
  const paused = state === 'PAUSED';
  const sceneLabels: Record<string, string> = {
    WORKBENCH: '真实洗护台', PROCESS_CLOSEUP: '工序细节', SERVICE_FACTS: '服务说明', Q_AND_A: '安全问答', OFFER: '当前商品',
  };

  return (
    <main className={`broadcast-canvas ${qaSafe ? 'show-safe-zone' : ''}`}>
      <video ref={videoRef} className="broadcast-video" muted playsInline />
      {cameraStatus !== 'ready' && (
        <section className="camera-start" aria-label="摄像头设置">
          <Camera aria-hidden="true" />
          <strong>{cameraStatus === 'scanning' ? '正在读取摄像头' : cameraStatus === 'preview' ? '检查无人脸取景' : '选择俯拍摄像头'}</strong>
          <span>{cameraMessage}</span>
          {devices.length > 0 && cameraStatus !== 'preview' && (
            <select aria-label="选择专用俯拍摄像头" value={selectedDeviceId} onChange={(event) => setSelectedDeviceId(event.target.value)}>
              <option value="">请选择，不使用系统默认设备</option>
              {devices.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `摄像头 ${index + 1}`}</option>)}
            </select>
          )}
          {cameraStatus === 'preview'
            ? <button type="button" onClick={() => void confirmFraming()}><ShieldCheck />确认只有洗护台且无人脸</button>
            : devices.length > 0
              ? <button type="button" disabled={!selectedDeviceId} onClick={() => void previewSelectedCamera()}><Camera />打开所选设备预览</button>
              : <button type="button" onClick={() => void scanCameras()}><RefreshCw />扫描本机摄像头</button>}
        </section>
      )}

      {!serviceConnected && (
        <div className="service-blocker" role="alert">
          <CircleAlert />
          <strong>本地服务未连接</strong>
          <span>AI播报已停止，请员工使用真人声音接管或结束直播。</span>
          <button type="button" onClick={() => void refreshStatus()}><RefreshCw />重新连接</button>
        </div>
      )}

      <div className="broadcast-topbar">
        <div className="brand-lockup"><span className="cat-mark" aria-hidden="true"><i /><b /></span><div><strong>实景直播</strong><span>AI主持｜真实作业</span></div></div>
        <div className={`on-air ${live ? 'is-live' : paused ? 'is-paused' : ''}`}><span />{live ? '真实直播中' : paused ? 'AI播报已暂停' : '本地演练画面'}</div>
      </div>
      <div className="broadcast-stage-label"><Sparkles aria-hidden="true" /><span>{sceneLabels[scene] ?? '真实洗护台'}</span></div>

      <div className="broadcast-bottom">
        <div className="caption-box" aria-live="polite">
          <div className="caption-speaker"><span className="mini-cat" aria-hidden="true" />{speaking ? <Volume2 aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}小助手</div>
          <p>{caption}</p>
        </div>
        <div className="offer-strip">
          <div className="offer-copy"><span>{offerTitle ?? '未导入有效商品｜不播报价格'}</span><strong>{priceCents === null ? '价格待核验' : `¥${(priceCents / 100).toFixed(2)}`}</strong></div>
          <div className="location-copy"><MapPin aria-hidden="true" />钟山 · 水城主城区</div>
        </div>
        <div className="broadcast-footnote"><span>{clock.toLocaleTimeString('zh-CN', { hour12: false })}</span><span><CircleAlert aria-hidden="true" />特殊材质、退款与赔偿由员工核实</span></div>
      </div>
      <div className="platform-safe-overlay" aria-hidden="true"><span>平台操作安全区</span></div>
    </main>
  );
}
