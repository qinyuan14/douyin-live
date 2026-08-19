import { contextBridge } from 'electron';

const prefix = '--mzg-local-token=';
const token = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? '';

contextBridge.exposeInMainWorld('mzgDesktop', {
  getLocalToken: () => token,
});
