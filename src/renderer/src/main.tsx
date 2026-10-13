import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {App} from './App';
import {startTrafficStore} from '@/store/traffic';

import '@/styles/tokens.css';
import '@/styles/global.css';

// 首帧之前就按平台加类名，titlebar 的左右留白才不会先错后对地跳一下
document.body.classList.add(`platform--${window.api.platform}`);

startTrafficStore();

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('index.html 缺少 #root 节点');

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);

requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    window.api.notifyReady();
  });
});
