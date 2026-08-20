/// <reference types="vite/client" />

interface Window {
  liveDesktop?: {
    getLocalToken: () => string;
  };
}
