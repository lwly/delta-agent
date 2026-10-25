<script setup lang="ts">
// 设置页·模型配置面板（F-04a 内容区）：Provider 列表（测试/启停/排序/删除）+ 新增/编辑表单
// 从 ProvidersModal 抽取主体内容，弹窗壳保留在 ProvidersModal.vue 中复用
import { onMounted, ref } from 'vue';
import { api, type ProviderView } from '../../api/client';

const providers = ref<ProviderView[]>([]);
const error = ref('');
const testing = ref('');
const testResult = ref<Record<string, string>>({});

const form = ref({ id: '', apiKey: '', baseUrl: '', model: '', setDefault: false });
const editing = ref(false);

const PRESETS = ['anthropic', 'openai', 'deepseek', 'qwen'];

async function refresh() {
  const res = await fetch('/api/providers');
  const json = await res.json();
  // serve 未挂 ProviderManager 时该端点 404/返回错误对象，容错为空列表
  providers.value = Array.isArray(json) ? (json as ProviderView[]) : [];
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
  <div class="list">
    <div v-for="(p, i) in providers" :key="p.id" class="row" :class="{ current: p.default }">
      <span class="logo" :data-vendor="p.vendor">{{ p.id.slice(0, 2) }}</span>
      <span class="info">
        <span class="name">
          {{ p.id }}
          <span v-if="p.default" class="tag">默认</span>
          <span class="tag">{{ p.enabled ? '启用' : '停用' }}</span>
        </span>
        <span class="meta">{{ p.vendor }}{{ p.model ? ` · ${p.model}` : '' }}{{ p.baseUrl ? ` · ${p.baseUrl}` : '' }} · Key {{ p.keyMasked }}</span>
        <span v-if="testResult[p.id]" class="test" :class="{ ok: testResult[p.id]!.startsWith('✔'), fail: testResult[p.id]!.startsWith('✘') }">{{ testResult[p.id] }}</span>
      </span>
      <span class="ops">
        <button class="op" @click="test(p.id)">{{ testing === p.id ? '…' : '测试' }}</button>
        <button class="op" @click="edit(p)">编辑</button>
        <button class="op" @click="action(p.id, 'enable', { enabled: !p.enabled })">{{ p.enabled ? '停用' : '启用' }}</button>
        <button class="op" :disabled="p.default" @click="action(p.id, 'default')">设默认</button>
        <button class="op" :disabled="i === 0" @click="action(p.id, 'move', { dir: 'up' })">↑</button>
        <button class="op" :disabled="i === providers.length - 1" @click="action(p.id, 'move', { dir: 'down' })">↓</button>
        <button class="op del" @click="remove(p.id)">删除</button>
      </span>
    </div>
    <p v-if="providers.length === 0" class="empty">（空）在下方添加 Provider，或先用 CLI <code>delta models add</code></p>
  </div>

  <div class="form">
    <div class="form-title">{{ editing ? `编辑 ${form.id}` : '新增 Provider' }}</div>
    <div class="grid">
      <label>ID
        <select v-if="!editing" v-model="form.id">
          <option v-for="p in PRESETS" :key="p" :value="p">{{ p }}</option>
          <option value="">（openai 兼容网关自定义）</option>
        </select>
        <input v-else v-model="form.id" disabled />
      </label>
      <label>API Key{{ editing ? '（留空保留原 Key）' : ' *' }}<input v-model="form.apiKey" type="password" :placeholder="editing ? '留空则保留已存储的 Key' : '保存后加密存储，不回显'" /></label>
      <label>Base URL（openai 兼容网关）<input v-model="form.baseUrl" placeholder="https://…" /></label>
      <label>默认模型<input v-model="form.model" placeholder="如 deepseek-chat" /></label>
    </div>
    <label class="check"><input v-model="form.setDefault" type="checkbox" /> 设为默认</label>
    <p v-if="error" class="error">✘ {{ error }}</p>
    <!-- 编辑模式 Key 可留空（保留原 Key），新增模式必填 -->
    <button class="btn primary save" :disabled="!form.id || (!editing && !form.apiKey)" @click="save">保存</button>
  </div>
  <p class="note">Key 经本地加密存储、界面不回显（更新需重新输入）；配置对<b>新建对话</b>即时生效。</p>
</template>

<style scoped>
.list { margin: 8px 0 14px; }
.row {
  display: flex; align-items: center; gap: 12px;
  background: var(--bg-panel); border: 1px solid var(--border);
  border-radius: 10px; padding: 10px 14px; margin-bottom: 8px;
}
.row.current { border-color: rgba(88, 166, 255, 0.45); background: var(--accent-soft); }
.logo {
  width: 32px; height: 32px; border-radius: 8px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  font-weight: 700; font-size: 12px; color: #fff;
  background: linear-gradient(135deg, #4c8dff, #2e6fe0); font-family: var(--mono);
}
.info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.name { font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 7px; }
.tag { font-size: 9.5px; font-family: var(--mono); padding: 1px 6px; border-radius: 4px; background: var(--bg-elevated); color: var(--text-dim); font-weight: 400; }
.meta { font-size: 11px; color: var(--text-faint); font-family: var(--mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.test { font-size: 11px; font-family: var(--mono); }
.test.ok { color: var(--green); }
.test.fail { color: var(--red); }
.ops { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; max-width: 250px; }
.op {
  padding: 4px 10px; border-radius: 6px; border: 1px solid var(--border);
  background: transparent; color: var(--text-dim); font-size: 11.5px; cursor: pointer;
  transition: all 0.12s;
}
.op:hover { background: var(--bg-hover); color: var(--text); }
.op:disabled { opacity: 0.35; cursor: not-allowed; }
.op.del { color: var(--red); }
.op.del:hover { background: var(--red-soft); }
.empty { color: var(--text-faint); text-align: center; padding: 14px; font-size: 12.5px; }
.empty code { font-family: var(--mono); color: var(--accent); }
.form { border-top: 1px solid var(--border); padding-top: 12px; }
.form-title { font-size: 13px; font-weight: 600; color: var(--text-dim); margin-bottom: 10px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.form label { display: flex; flex-direction: column; gap: 4px; color: var(--text-dim); font-size: 12px; }
.check { flex-direction: row !important; align-items: center; gap: 6px; margin-top: 8px; }
.error { color: var(--red); font-size: 12.5px; margin-top: 8px; }
.save { margin-top: 10px; width: 100%; }
.note { font-size: 11px; color: var(--text-faint); line-height: 1.6; margin-top: 10px; }
.note b { color: var(--text-dim); }
</style>
