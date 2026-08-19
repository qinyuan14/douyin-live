/// <reference types="vite/client" />

interface Window {
  mzgDesktop?: {
    getLocalToken: () => string;
  };
}
