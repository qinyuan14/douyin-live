import { contextBridge } from 'electron';

const prefix = '--live-local-token=';
const token = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? '';

contextBridge.exposeInMainWorld('liveDesktop', {
  getLocalToken: () => token,
});
