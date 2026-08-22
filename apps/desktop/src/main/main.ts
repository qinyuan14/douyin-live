import { app, BrowserWindow, Menu, screen, dialog, ipcMain } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

let controlWindow: BrowserWindow | null = null;
let outputWindow: BrowserWindow | null = null;
let apiProcess: ChildProcess | null = null;

// v13.2：允许无用户手势自动播放音频（火山引擎试听/播报的 mp3 播放依赖此开关，
// 否则 await 网络合成后 play() 可能被 Chromium 自动播放策略拦截导致"没声音"）
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

/**
 * 打包模式判定。
 * - 安装/便携包：app.isPackaged 为 true；
 * - 开发期可通过 LIVE_PACKAGED=1 强制走打包流程（用于本地验证启动链路，数据目录仍用 userData）。
 */
function isPackagedRun(): boolean {
  return app.isPackaged || process.env.LIVE_PACKAGED === '1';
}

/**
 * 打包版的数据根目录：%APPDATA%/实景直播经营系统/live-system-data/。
 * 首次调用时固定 userData 目录，避免应用名差异导致 Chromium 会话数据漂移。
 */
function packagedDataRoot(): string {
  const base = join(app.getPath('appData'), '实景直播经营系统');
  if (app.getPath('userData') !== base) app.setPath('userData', base);
  return join(base, 'live-system-data');
}

/** 主进程本地令牌读取：打包版从数据根目录读，开发版沿用仓库根。 */
function localToken(): string {
  const root = isPackagedRun()
    ? packagedDataRoot()
    : process.env.LIVE_PROJECT_ROOT
      ? join(process.env.LIVE_PROJECT_ROOT)
      : join(import.meta.dirname, '..', '..', '..');
  return readFileSync(join(root, '.data', 'live-system', 'runtime-token'), 'utf8').trim();
}

/**
 * 打包版：把随包携带的 docs/APPROVED_LIVE_KNOWLEDGE.md 播种到数据根目录的 docs/。
 * 该文件的白名单知识是 seedKnowledge 的校验证据（SHA256 钉死），必须存在且不可被覆盖改写。
 */
function seedDocsToDataRoot(): void {
  if (!isPackagedRun()) return;
  const source = join(process.resourcesPath, 'docs', 'APPROVED_LIVE_KNOWLEDGE.md');
  const targetDir = join(packagedDataRoot(), 'docs');
  const target = join(targetDir, 'APPROVED_LIVE_KNOWLEDGE.md');
  if (!existsSync(source)) throw new Error(`发布包缺少白名单知识文件：${source}`);
  mkdirSync(targetDir, { recursive: true });
  if (!existsSync(target)) copyFileSync(source, target);
}

/**
 * 打包版：拉起内置本地 API 服务。
 * 技巧：ELECTRON_RUN_AS_NODE=1 让 electron.exe 以纯 Node 模式运行 api-runtime/dist/main.js，
 * 无需在发布包中额外携带 node.exe。
 */
async function startBundledApi(): Promise<void> {
  if (!isPackagedRun()) return;
  const entry = join(process.resourcesPath, 'api-runtime', 'dist', 'main.js');
  if (!existsSync(entry)) throw new Error(`发布包缺少内置服务：${entry}`);
  const dataRoot = packagedDataRoot();
  mkdirSync(dataRoot, { recursive: true });
  apiProcess = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      LIVE_PROJECT_ROOT: dataRoot,
      LIVE_DOCS_DIR: join(dataRoot, 'docs'),
    },
    stdio: 'inherit',
    windowsHide: false,
  });
  apiProcess.on('exit', (code) => {
    console.error(`内置本地服务已退出（code=${code}）`);
    apiProcess = null;
  });
  await waitForApiHealth();
}

async function waitForApiHealth(): Promise<void> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (apiProcess?.exitCode !== null && apiProcess?.exitCode !== undefined) {
      throw new Error(`内置本地服务启动失败（退出码 ${apiProcess.exitCode}）`);
    }
    try {
      const response = await fetch('http://127.0.0.1:3188/api/health', { signal: AbortSignal.timeout(1_500) });
      if (response.ok) return;
    } catch {
      // 服务尚未就绪，继续轮询
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error('内置本地服务 25 秒内未就绪，请确认端口 3188 未被其他程序占用');
}

function stopBundledApi(): void {
  if (apiProcess) {
    apiProcess.kill();
    apiProcess = null;
  }
}

function pngSize(bytes: Buffer): { width: number; height: number } {
  if (bytes.toString('ascii', 1, 4) !== 'PNG') throw new Error('截图不是有效PNG文件');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function rendererUrl(route: string): string {
  const devUrl = process.env.LIVE_DESKTOP_DEV_URL;
  if (devUrl) return `${devUrl}/#/${route}`;
  return `file://${join(dirname(import.meta.dirname), 'dist-renderer', 'index.html')}#/${route}`;
}

function securedWebPreferences() {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    preload: join(import.meta.dirname, 'preload.cjs'),
    additionalArguments: [`--live-local-token=${localToken()}`],
  };
}

function createWindows(): void {
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const controlWidth = Math.min(1500, Math.max(1180, workArea.width - 120));
  const controlHeight = Math.min(980, Math.max(780, workArea.height - 100));

  controlWindow = new BrowserWindow({
    title: '实景直播值班台',
    width: controlWidth,
    height: controlHeight,
    minWidth: 1120,
    minHeight: 720,
    autoHideMenuBar: true,
    backgroundColor: '#eef1f4',
    webPreferences: securedWebPreferences(),
  });
  void controlWindow.loadURL(rendererUrl('control'));

  // 直播输出窗口必须为 1080×1920 真实像素，供抖音直播伴侣按 9:16 画布原生采集。
  // 窗口高度高于屏幕属正常（输出窗用于被采集，不要求完整可见）；可用环境变量覆盖以适配高分屏或临时验证。
  const outputWidth = Number(process.env.LIVE_OUTPUT_WIDTH ?? 1080);
  const outputHeight = Number(process.env.LIVE_OUTPUT_HEIGHT ?? 1920);
  if (!Number.isFinite(outputWidth) || !Number.isFinite(outputHeight) || outputWidth <= 0 || outputHeight <= 0) {
    throw new Error(`直播输出尺寸无效：${process.env.LIVE_OUTPUT_WIDTH}x${process.env.LIVE_OUTPUT_HEIGHT}`);
  }
  if (Math.abs(outputWidth / outputHeight - 9 / 16) > 0.001) {
    throw new Error(`直播输出比例必须为 9:16，当前 ${outputWidth}x${outputHeight}`);
  }
  outputWindow = new BrowserWindow({
    title: '实景直播｜9:16 直播输出',
    width: outputWidth,
    height: outputHeight,
    useContentSize: true,
    resizable: false,
    frame: false,
    x: Math.max(0, workArea.width - outputWidth),
    y: 0,
    autoHideMenuBar: true,
    backgroundColor: '#101922',
    webPreferences: securedWebPreferences(),
  });
  outputWindow.on('closed', () => {
    outputWindow = null;
  });
  void outputWindow.loadURL(rendererUrl('output'));

  const captureDir = process.env.LIVE_CAPTURE_DIR;
  if (captureDir) {
    mkdirSync(captureDir, { recursive: true });
    Promise.all([
      new Promise<void>((resolve) => controlWindow?.webContents.once('did-finish-load', () => resolve())),
      new Promise<void>((resolve) => outputWindow?.webContents.once('did-finish-load', () => resolve())),
    ]).then(() => new Promise((resolve) => setTimeout(resolve, 2_500))).then(async () => {
      const [controlImage, previewImage] = await Promise.all([
        controlWindow!.webContents.capturePage(),
        outputWindow!.webContents.capturePage(),
      ]);
      const previewSize = previewImage.getSize();
      if (Math.abs(previewSize.width / previewSize.height - 9 / 16) > 0.001) {
        throw new Error(`直播预览比例错误：${previewSize.width}x${previewSize.height}`);
      }
      const capturedSize = previewImage.getSize();
      const outputBytes = previewImage.resize({ width: outputWidth, height: outputHeight, quality: 'best' }).toPNG();
      const outputSize = pngSize(outputBytes);
      writeFileSync(join(captureDir, 'capture-diagnostic.json'), JSON.stringify({
        control: controlImage.getSize(), preview: previewSize, hiddenCapture: capturedSize, output: outputSize, displayScaleFactor: screen.getPrimaryDisplay().scaleFactor,
        renderStrategy: '输出窗口原生渲染为 9:16 目标尺寸（默认 1080×1920）；直播伴侣直接按该画布原生采集，不再拉伸冒充',
        target: { width: outputWidth, height: outputHeight, aspectRatio: 9 / 16 },
      }, null, 2));
      if (outputSize.width !== outputWidth || outputSize.height !== outputHeight) {
        throw new Error(`直播输出尺寸错误：${outputSize.width}x${outputSize.height}，目标 ${outputWidth}x${outputHeight}`);
      }
      writeFileSync(join(captureDir, 'control.png'), controlImage.toPNG());
      writeFileSync(join(captureDir, 'output-preview.png'), previewImage.toPNG());
      writeFileSync(join(captureDir, 'output.png'), outputBytes);
      await outputWindow!.loadURL(rendererUrl('output?qa=safe'));
      await new Promise((resolve) => setTimeout(resolve, 800));
      const safeImage = await outputWindow!.webContents.capturePage();
      writeFileSync(join(captureDir, 'output-safe-zone.png'), safeImage.resize({ width: outputWidth, height: outputHeight, quality: 'best' }).toPNG());
      writeFileSync(join(captureDir, 'capture-manifest.json'), JSON.stringify({
        capturedAt: new Date().toISOString(),
        preview: { width: previewSize.width, height: previewSize.height, aspectRatio: previewSize.width / previewSize.height },
        normalizedOutput: { width: outputSize.width, height: outputSize.height, aspectRatio: outputSize.width / outputSize.height },
        target: { width: outputWidth, height: outputHeight, aspectRatio: 9 / 16 },
        exactArtifactMatch: true,
        nativeWindowExactMatch: capturedSize.width === outputWidth && capturedSize.height === outputHeight,
        limitation: capturedSize.width === outputWidth && capturedSize.height === outputHeight
          ? null
          : `原生窗口为 ${capturedSize.width}x${capturedSize.height}，未达目标 ${outputWidth}x${outputHeight}；直播伴侣原生采集需在该目标尺寸下单独验证`,
      }, null, 2));
      app.quit();
    }).catch((error: unknown) => {
      console.error(error);
      app.exit(2);
    });
  }

  controlWindow.on('closed', () => {
    outputWindow?.close();
    controlWindow = null;
  });
  outputWindow.on('closed', () => {
    outputWindow = null;
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  if (isPackagedRun()) {
    try {
      seedDocsToDataRoot();
      await startBundledApi();
    } catch (error) {
      console.error(error);
      dialog.showErrorBox(
        '实景直播经营系统启动失败',
        error instanceof Error ? error.message : '内置本地服务启动失败',
      );
      app.exit(1);
      return;
    }
  }
  createWindows();
  // 流程精简（批次2）：值班台「设备状态卡片」一键跳转/唤起直播输出窗口
  ipcMain.handle('focus-output-window', () => {
    if (!outputWindow || outputWindow.isDestroyed()) {
      createWindows();
    }
    outputWindow?.show();
    outputWindow?.focus();
    return true;
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindows();
  });
});

app.on('will-quit', () => stopBundledApi());

app.on('window-all-closed', () => app.quit());
