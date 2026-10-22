<script setup lang="ts">
import { onMounted, ref } from 'vue';

interface ProviderView {
  id: string;
  vendor: string;
  baseUrl?: string;
  model?: string;
  enabled: boolean;
  default: boolean;
  keyMasked: string;
}

const providers = ref<ProviderView[]>([]);
const error = ref('');
const testing = ref('');
const testResult = ref<Record<string, string>>({});

// 表单状态
const form = ref({ id: '', apiKey: '', baseUrl: '', model: '', setDefault: false });
const editing = ref(false);

const PRESETS = ['anthropic', 'openai', 'deepseek', 'qwen'];

async function refresh() {
  const res = await fetch('/api/providers');
  providers.value = (await res.json()) as ProviderView[];
}
onMounted(refresh);

async function save() {
  error.value = '';
  try {
    const res = await fetch(`/api/providers/${form.value.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apiKey: form.value.apiKey,
        baseUrl: form.value.baseUrl || undefined,
        model: form.value.model || undefined,
        setDefault: form.value.setDefault,
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
    form.value = { id: '', apiKey: '', baseUrl: '', model: '', setDefault: false };
    editing.value = false;
    await refresh();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

function edit(p: ProviderView) {
  // Key 不回显：更新需重新输入
  editing.value = true;
  form.value = { id: p.id, apiKey: '', baseUrl: p.baseUrl ?? '', model: p.model ?? '', setDefault: p.default };
}

async function remove(id: string) {
  if (!confirm(`删除 Provider「${id}」？`)) return;
  await fetch(`/api/providers/${id}`, { method: 'DELETE' });
  await refresh();
}

async function action(id: string, act: 'default' | 'enable' | 'move', body?: object) {
  await fetch(`/api/providers/${id}/${act}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  await refresh();
}

async function test(id: string) {
  testing.value = id;
  testResult.value[id] = '… 测试中';
  try {
    const res = await fetch(`/api/providers/${id}/test`, { method: 'POST' });
    const r = (await res.json()) as { ok: boolean; latencyMs: number; detail: string };
    testResult.value[id] = `${r.ok ? '✔' : '✘'} ${r.detail}（${r.latencyMs}ms）`;
  } catch (e) {
    testResult.value[id] = `✘ ${(e as Error).message}`;
  } finally {
    testing.value = '';
  }
}
</script>

<template>
  <div class="settings">
    <section class="panel">
      <h2>模型 Provider（F-04a）</h2>
      <p class="hint">Key 经本地加密存储、界面不回显（更新需重新输入）；配置对新建对话即时生效。</p>

      <table>
        <thead>
          <tr><th>顺序</th><th>ID</th><th>类型</th><th>Key</th><th>默认模型</th><th>状态</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="(p, i) in providers" :key="p.id">
            <td>{{ i + 1 }}</td>
            <td><code>{{ p.id }}</code><span v-if="p.default" class="badge">默认</span></td>
            <td>{{ p.vendor }}</td>
            <td><code>{{ p.keyMasked }}</code></td>
            <td>{{ p.model ?? '—' }}</td>
            <td>{{ p.enabled ? '启用' : '停用' }}</td>
            <td class="ops">
              <button @click="test(p.id)">{{ testing === p.id ? '…' : '测试' }}</button>
              <button @click="edit(p)">编辑</button>
              <button @click="action(p.id, 'enable', { enabled: !p.enabled })">{{ p.enabled ? '停用' : '启用' }}</button>
              <button @click="action(p.id, 'default')">设默认</button>
              <button @click="action(p.id, 'move', { dir: 'up' })" :disabled="i === 0">↑</button>
              <button @click="action(p.id, 'move', { dir: 'down' })" :disabled="i === providers.length - 1">↓</button>
              <button class="danger" @click="remove(p.id)">删除</button>
              <span class="test-result">{{ testResult[p.id] ?? '' }}</span>
            </td>
          </tr>
          <tr v-if="providers.length === 0">
            <td colspan="7" class="muted">（空）在下方添加 Provider，或先用 CLI `yzero models add`</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="panel">
      <h2>{{ editing ? `编辑 ${form.id}` : '新增 Provider' }}</h2>
      <div class="form">
        <label>ID
          <select v-if="!editing" v-model="form.id">
            <option v-for="p in PRESETS" :key="p" :value="p">{{ p }}</option>
            <option value="">（openai 兼容网关自定义）</option>
          </select>
          <input v-else v-model="form.id" disabled />
        </label>
        <label>API Key *<input v-model="form.apiKey" type="password" placeholder="保存后加密存储，不回显" /></label>
        <label>Base URL（openai 兼容网关）<input v-model="form.baseUrl" placeholder="https://…" /></label>
        <label>默认模型<input v-model="form.model" placeholder="如 deepseek-chat" /></label>
        <label class="check"><input v-model="form.setDefault" type="checkbox" /> 设为默认</label>
        <p v-if="error" class="error">{{ error }}</p>
        <button class="primary" :disabled="!form.id || !form.apiKey" @click="save">保存</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.settings { display: grid; grid-template-columns: 1.6fr 1fr; gap: 16px; height: 100%; }
.panel { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 14px; overflow: auto; }
h2 { margin: 0 0 8px; font-size: 15px; }
.hint { font-size: 12px; color: #8b949e; margin: 0 0 10px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { border-bottom: 1px solid #d0d7de; padding: 7px 8px; text-align: left; vertical-align: top; }
th { color: #57606a; font-weight: 500; }
.badge { background: #1f883d; color: #fff; font-size: 11px; border-radius: 4px; padding: 1px 5px; margin-left: 6px; }
.ops { display: flex; flex-wrap: wrap; gap: 4px; }
.ops button { padding: 3px 8px; font-size: 12px; border: 1px solid #d0d7de; border-radius: 5px; background: #fff; cursor: pointer; }
.ops button:disabled { opacity: 0.4; cursor: default; }
.danger { color: #cf222e; }
.test-result { font-size: 12px; width: 100%; }
.form { display: flex; flex-direction: column; gap: 10px; font-size: 13px; }
.form label { display: flex; flex-direction: column; gap: 4px; color: #57606a; }
.form input, .form select { padding: 7px 9px; border: 1px solid #d0d7de; border-radius: 6px; font-size: 13px; }
.form .check { flex-direction: row; align-items: center; gap: 6px; }
button.primary { background: #1f883d; color: #fff; border: none; border-radius: 6px; padding: 8px 0; cursor: pointer; }
button.primary:disabled { opacity: 0.5; }
.error { color: #cf222e; }
.muted { color: #8b949e; }
</style>
