import {createRoot} from 'react-dom/client';
import {Settings} from './settings';
import '@/lib/i18n';

// 与 home 同一套 token / 基础样式：设置窗口也要跟着主题走，不能只有颜色像
import '@/styles/tokens.css';
import '@/styles/global.css';

// settings.html 的窗口入口。只允许 settings.html 引用本文件：这里的 createRoot 是副作用，
// 被别的页面 import 会在那个窗口里多挂一棵 React 树
void window.api.notifyReady();

const container = document.getElementById('root');
if (!container) throw new Error('settings.html 缺少 #root 节点');

createRoot(container).render(<Settings />);
