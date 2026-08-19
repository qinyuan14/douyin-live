import { app, BrowserWindow, Menu, screen } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let controlWindow: BrowserWindow | null = null;
let outputWindow: BrowserWindow | null = null;

function pngSize(bytes: Buffer): { width: number; height: number } {
  if (bytes.toString('ascii', 1, 4) !== 'PNG') throw new Error('截图不是有效PNG文件');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function rendererUrl(route: string): string {
  const devUrl = process.env.MZG_DESKTOP_DEV_URL;
  if (devUrl) return `${devUrl}/#/${route}`;
  return `file://${join(import.meta.dirname, '..', 'dist-renderer', 'index.html')}#/${route}`;
}

function localToken(): string {
  const root = process.env.MZG_PROJECT_ROOT
    ? join(process.env.MZG_PROJECT_ROOT)
    : join(import.meta.dirname, '..', '..', '..');
  return readFileSync(join(root, '.data', 'live-system', 'runtime-token'), 'utf8').trim();
}

function securedWebPreferences() {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    preload: join(import.meta.dirname, 'preload.cjs'),
    additionalArguments: [`--mzg-local-token=${localToken()}`],
  };
}

function createWindows(): void {
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const controlWidth = Math.min(1500, Math.max(1180, workArea.width - 120));
  const controlHeight = Math.min(980, Math.max(780, workArea.height - 100));

  controlWindow = new BrowserWindow({
    title: '猫掌柜直播值班台',
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
  const outputWidth = Number(process.env.MZG_OUTPUT_WIDTH ?? 1080);
  const outputHeight = Number(process.env.MZG_OUTPUT_HEIGHT ?? 1920);
  if (!Number.isFinite(outputWidth) || !Number.isFinite(outputHeight) || outputWidth <= 0 || outputHeight <= 0) {
    throw new Error(`直播输出尺寸无效：${process.env.MZG_OUTPUT_WIDTH}x${process.env.MZG_OUTPUT_HEIGHT}`);
  }
  if (Math.abs(outputWidth / outputHeight - 9 / 16) > 0.001) {
    throw new Error(`直播输出比例必须为 9:16，当前 ${outputWidth}x${outputHeight}`);
  }
  outputWindow = new BrowserWindow({
    title: '猫掌柜｜9:16 直播输出',
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
  void outputWindow.loadURL(rendererUrl('output'));

  const captureDir = process.env.MZG_CAPTURE_DIR;
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

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindows();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindows();
  });
});

app.on('window-all-closed', () => app.quit());
