import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ControlApp } from './screens/ControlApp.js';
import { OutputApp } from './screens/OutputApp.js';
import './styles.css';

const route = window.location.hash.replace('#/', '') || 'control';
const root = document.getElementById('root');
if (!root) throw new Error('界面根节点不存在');

createRoot(root).render(
  <StrictMode>
    {route === 'output' ? <OutputApp /> : <ControlApp />}
  </StrictMode>,
);

