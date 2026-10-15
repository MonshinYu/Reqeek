import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {Home} from './home';
import {startTrafficStore} from '@/store/traffic';

// home.html 的窗口入口。只允许 home.html 引用本文件：这里的 createRoot 是副作用，
// 被别的页面 import 会在那个窗口里多挂一棵 React 树。要用 Home 组件请 import '@/views/Home/home'

import '@/styles/tokens.css';
import '@/styles/global.css';

// 首帧之前就按平台加类名，titlebar 的左右留白才不会先错后对地跳一下
document.body.classList.add(`platform--${window.api.platform}`);

startTrafficStore();

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('home.html 缺少 #root 节点');

createRoot(rootElement).render(
  <StrictMode>
    <Home />
  </StrictMode>
);

requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    window.api.notifyReady();
  });
});
