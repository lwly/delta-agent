import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import './builtin-views/register';
import { createAppRouter } from './router';
import { bootstrapPluginViews } from './plugin-views/bootstrap';
import { initAuthToken } from './api/auth';
import './theme.css';

async function main(): Promise<void> {
  initAuthToken();
  await bootstrapPluginViews();
  const router = createAppRouter();
  createApp(App).use(createPinia()).use(router).mount('#app');
}

void main();
