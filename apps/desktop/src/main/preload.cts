import { contextBridge, ipcRenderer } from 'electron';

const prefix = '--live-local-token=';
const token = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? '';

contextBridge.exposeInMainWorld('liveDesktop', {
  getLocalToken: () => token,
  // 流程精简（批次2）：唤起/聚焦直播输出窗口
  focusOutputWindow: () => ipcRenderer.invoke('focus-output-window') as Promise<boolean>,
});
