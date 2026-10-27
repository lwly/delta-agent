<script setup lang="ts">
// 设置页·模型配置面板（F-04a 内容区）：Provider 列表（测试/启停/排序/删除）+ 新增/编辑表单
// 从 ProvidersModal 抽取主体内容，弹窗壳保留在 ProvidersModal.vue 中复用
import { computed, onMounted, ref } from 'vue';
import { apiFetch, type ProviderView } from '../../api/client';

const providers = ref<ProviderView[]>([]);
const error = ref('');
const testing = ref('');
const testResult = ref<Record<string, string>>({});

const form = ref({ id: '', apiKey: '', baseUrl: '', model: '', setDefault: false });
const editing = ref(false);

// 表单态探测（不落盘）：测试连接 / 获取模型
const formTesting = ref(false);
const formTest = ref('');
const fetchingModels = ref(false);
const modelOptions = ref<string[]>([]);

const PRESETS = ['anthropic', 'openai', 'deepseek', 'qwen'];

// 预设 provider 有服务端默认 Base URL，仅自定义网关（id 为空）时必须填 Base URL
const canProbe = computed(() => Boolean(form.value.id || form.value.baseUrl.trim()));
// 新增模式必须已有 Key；编辑模式可留空走存储 Key
const needsKey = computed(() => !editing.value && !form.value.apiKey);

/** 非数组响应（含错误对象）容错为空列表；serve 未挂 ProviderManager 时为 404 */
function asList(json: unknown): ProviderView[] {
  return Array.isArray(json) ? (json as ProviderView[]) : [];
}

/** 非 2xx 时提取服务端错误信息（读取失败退化 HTTP 状态码） */
async function readError(res: Response): Promise<string> {
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  return json.error ?? `HTTP ${res.status}`;
}

async function refresh() {
  const res = await apiFetch('/api/providers');
  const json = await res.json().catch(() => ({}));
  // 404 = CLI serve 未挂 ProviderManager，按既有约定静默退化为空列表；
  // 其余非 2xx（如桌面端 401）显式报错，避免故障被吞成「空数据」
  if (!res.ok && res.status !== 404) {
    error.value = `加载列表失败：${(json as { error?: string }).error ?? `HTTP ${res.status}`}`;
    providers.value = [];
    return;
  }
  error.value = '';
  providers.value = asList(json);
}
onMounted(refresh);

async function save() {
  error.value = '';
  try {
    const res = await apiFetch(`/api/providers/${form.value.id}`, {
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
    resetForm();
    await refresh();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

function resetForm() {
  form.value = { id: '', apiKey: '', baseUrl: '', model: '', setDefault: false };
  editing.value = false;
  formTest.value = '';
  modelOptions.value = [];
}

function probeBody() {
  return {
    id: form.value.id,
    apiKey: form.value.apiKey || undefined,
    baseUrl: form.value.baseUrl || undefined,
    model: form.value.model || undefined,
  };
}

async function testForm() {
  formTesting.value = true;
  formTest.value = '… 测试中';
  try {
    const res = await apiFetch('/api/providers/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(probeBody()),
    });
    if (!res.ok) {
      formTest.value = `✘ ${await readError(res)}`;
      return;
    }
    const r = (await res.json()) as { ok: boolean; latencyMs: number; detail: string };
    formTest.value = `${r.ok ? '✔' : '✘'} ${r.detail}（${r.latencyMs}ms）`;
  } catch (e) {
    formTest.value = `✘ ${(e as Error).message}`;
  } finally {
    formTesting.value = false;
  }
}

async function fetchModels() {
  fetchingModels.value = true;
  formTest.value = '';
  try {
    const res = await apiFetch('/api/providers/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(probeBody()),
    });
    if (!res.ok) {
      formTest.value = `✘ ${await readError(res)}`;
      return;
    }
    const r = (await res.json()) as { ok: boolean; models: string[]; detail: string };
    if (!r.ok) {
      formTest.value = `✘ ${r.detail}`;
      return;
    }
    modelOptions.value = r.models;
  } catch (e) {
    formTest.value = `✘ ${(e as Error).message}`;
  } finally {
    fetchingModels.value = false;
  }
}

function edit(p: ProviderView) {
  // Key 不回显：更新需重新输入
  editing.value = true;
  form.value = { id: p.id, apiKey: '', baseUrl: p.baseUrl ?? '', model: p.model ?? '', setDefault: p.default };
  formTest.value = '';
  modelOptions.value = [];
}

async function remove(id: string) {
  if (!confirm(`删除 Provider「${id}」？`)) return;
  error.value = '';
  try {
    const res = await apiFetch(`/api/providers/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(await readError(res));
    await refresh();
  } catch (e) {
    error.value = `删除失败：${(e as Error).message}`;
  }
}

async function action(id: string, act: 'default' | 'enable' | 'move', body?: object) {
  error.value = '';
  try {
    const res = await apiFetch(`/api/providers/${id}/${act}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(await readError(res));
    await refresh();
  } catch (e) {
    error.value = `操作失败：${(e as Error).message}`;
  }
}

async function test(id: string) {
  testing.value = id;
  testResult.value[id] = '… 测试中';
  try {
    const res = await apiFetch(`/api/providers/${id}/test`, { method: 'POST' });
    const r = (await res.json().catch(() => ({}))) as Partial<{ ok: boolean; latencyMs: number; detail: string; error: string }>;
    if (!res.ok) throw new Error(r.error ?? `HTTP ${res.status}`);
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
      <label>默认模型
        <select v-if="modelOptions.length" v-model="form.model">
          <option value="">（不设置）</option>
          <option v-if="form.model && !modelOptions.includes(form.model)" :value="form.model">{{ form.model }}</option>
          <option v-for="m in modelOptions" :key="m" :value="m">{{ m }}</option>
        </select>
        <input v-else v-model="form.model" placeholder="如 deepseek-chat，可先「获取模型」" />
      </label>
    </div>
    <div class="form-ops">
      <button class="op" :disabled="!canProbe || needsKey || formTesting" @click="testForm">{{ formTesting ? '… 测试中' : '测试连接' }}</button>
      <button class="op" :disabled="!canProbe || needsKey || fetchingModels" @click="fetchModels">{{ fetchingModels ? '… 获取中' : '获取模型' }}</button>
      <span v-if="formTest" class="form-test" :class="{ ok: formTest.startsWith('✔'), fail: formTest.startsWith('✘') }">{{ formTest }}</span>
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
.form-ops { display: flex; align-items: center; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.form-ops .op { padding: 5px 14px; font-size: 12px; }
.form-test { font-size: 11.5px; font-family: var(--mono); }
.form-test.ok { color: var(--green); }
.form-test.fail { color: var(--red); }
.error { color: var(--red); font-size: 12.5px; margin-top: 8px; }
.save { margin-top: 10px; width: 100%; }
.note { font-size: 11px; color: var(--text-faint); line-height: 1.6; margin-top: 10px; }
.note b { color: var(--text-dim); }
</style>
