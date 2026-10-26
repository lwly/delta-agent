import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router';
import { initAuthToken } from './api/auth';
import './theme.css';

// 桌面宿主鉴权 token：须在任意 API 调用前读取并从地址栏清除
initAuthToken();

createApp(App).use(createPinia()).use(router).mount('#app');
