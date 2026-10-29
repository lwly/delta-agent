<script setup lang="ts">
// 设置页·模型路由面板（F-42）：辅助任务（distill/classify/summarize/subagent/自定义 kind）
// → 目标模型规则。读写 /api/models/routing，保存走 setRouting 既有校验。
// 规则 provider 留空 = 跟随会话主 Provider；总开关关闭时规则保留但不生效。
import { onMounted, ref } from 'vue';
import { apiFetch, api, type ProviderView } from '../../api/client';

type Rule = { provider?: string; model: string };

const knownKinds = ref<string[]>([]);
const enabled = ref(false);
const rules = ref<Record<string, Rule>>({});
const providers = ref<ProviderView[]>([]);

const loading = ref(false);
const saving = ref(false);
const error = ref('');
const notice = ref('');

// 新增规则表单
const newKind = ref('');
const newModel = ref('');
const newProvider = ref('');

// 任务类型下拉菜单（自定义实现：datalist 无法自定义选项显示文本）
const kindMenuOpen = ref(false);

function pickKind(k: string) {
  newKind.value = k;
  kindMenuOpen.value = false;
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [r, provRes] = await Promise.all([
      api.routingGet(),
      apiFetch('/api/providers').then((res) => res.json().catch(() => [])),
    ]);
    knownKinds.value = r.knownKinds;
    enabled.value = r.routing.enabled;
    rules.value = { ...r.routing.rules };
    providers.value = Array.isArray(provRes) ? (provRes as ProviderView[]) : [];
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const ruleEntries = () => Object.entries(rules.value);

function addRule() {
  const kind = newKind.value.trim();
  const model = newModel.value.trim();
  if (!kind || !model) {
    error.value = '任务类型与目标模型均不能为空';
    return;
  }
  if (rules.value[kind]) {
    error.value = `任务类型 ${kind} 已有规则，请直接修改`;
    return;
  }
  error.value = '';
  rules.value[kind] = {
    model,
    provider: newProvider.value.trim() || undefined,
  };
  newKind.value = '';
  newModel.value = '';
  newProvider.value = '';
}

function removeRule(kind: string) {
  const next = { ...rules.value };
  delete next[kind];
  rules.value = next;
}

async function save() {
  saving.value = true;
  error.value = '';
  notice.value = '';
  try {
    const r = await api.routingSet({ enabled: enabled.value, rules: rules.value });
    enabled.value = r.routing.enabled;
    rules.value = { ...r.routing.rules };
    notice.value = '已保存';
    setTimeout(() => (notice.value = ''), 2000);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}

/** kind 显示名（已知 kind 给中文说明，自定义 kind 原样） */
const KIND_LABELS: Record<string, string> = {
  distill: '记忆提炼（任务结束自动提炼）',
  classify: '任务分类（预留位）',
  summarize: '压缩摘要（长会话自动压缩）',
  subagent: '子代理（task 工具探索任务）',
};
</script>

<template>
  <section class="block">
    <h4>模型路由</h4>
    <p class="meta">
      辅助调用可指定小模型以省成本提速；规则 Provider 留空 = 跟随会话主 Provider。
      目标不可用时自动回退主模型。规则存于 <code>~/.delta/models.json</code>，与 CLI
      <code>models routing*</code> 命令共用同一配置。
    </p>

    <div class="head-row">
      <label class="switch">
        <input v-model="enabled" type="checkbox" />
        <span>启用路由{{ enabled ? '（已开启）' : '（已关闭）' }}</span>
      </label>
      <span class="spacer" />
      <button class="btn" :disabled="loading" @click="load">{{ loading ? '加载中…' : '刷新' }}</button>
      <button class="btn primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
    </div>

    <p v-if="error" class="error">✘ {{ error }}</p>
    <p v-if="notice" class="notice">✔ {{ notice }}</p>

    <div v-for="[kind, rule] in ruleEntries()" :key="kind" class="row">
      <div class="kind-col">
        <div class="kind">{{ kind }}</div>
        <div class="kind-desc">{{ KIND_LABELS[kind] ?? '自定义任务类型' }}</div>
      </div>
      <input v-model="rule.model" class="model-input" placeholder="目标模型 id" />
      <select v-model="rule.provider" class="provider-select">
        <option value="">（跟随主 Provider）</option>
        <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.id }}{{ p.default ? '（默认）' : '' }}</option>
      </select>
      <button class="btn danger" @click="removeRule(kind)">删除</button>
    </div>
    <div v-if="ruleEntries().length === 0" class="empty">（暂无规则——所有辅助调用跟随会话主模型）</div>

    <div class="add-row">
      <div class="add-kind-wrap">
        <input
          v-model="newKind"
          class="add-kind"
          placeholder="任务类型（如 summarize）"
          @focus="kindMenuOpen = true"
          @blur="kindMenuOpen = false"
        />
        <ul v-if="kindMenuOpen && knownKinds.length" class="kind-menu">
          <li v-for="k in knownKinds" :key="k" @mousedown.prevent="pickKind(k)">
            <span class="kind-menu-label">{{ KIND_LABELS[k] ?? '自定义任务类型' }}</span>
            <span class="kind-menu-id">{{ k }}</span>
          </li>
        </ul>
      </div>
      <input v-model="newModel" class="add-model" placeholder="目标模型 id" />
      <select v-model="newProvider" class="add-provider">
        <option value="">（跟随主 Provider）</option>
        <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.id }}</option>
      </select>
      <button class="btn" @click="addRule">添加规则</button>
    </div>
  </section>
</template>

<style scoped>
.block {
  background: var(--bg-panel); border: 1px solid var(--border);
  border-radius: 10px; padding: 12px 14px; margin-bottom: 14px;
}
h4 { font-size: 13.5px; margin-bottom: 6px; }
.meta { font-size: 11.5px; color: var(--text-faint); margin-bottom: 10px; line-height: 1.6; }
.meta code { font-family: var(--mono); font-size: 11px; }
.head-row { display: flex; align-items: center; gap: 8px; margin: 8px 0 12px; }
.switch { display: flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; }
.spacer { flex: 1; }
.btn {
  padding: 5px 14px; border-radius: 7px; border: 1px solid var(--border);
  background: transparent; color: var(--text-dim); font-size: 12.5px; cursor: pointer;
}
.btn:hover { background: var(--bg-hover); color: var(--text); }
.btn.primary { background: var(--accent-soft); border-color: rgba(88, 166, 255, 0.35); color: var(--accent); }
.btn.danger { color: var(--red); border-color: rgba(248, 81, 73, 0.4); }
.error { color: var(--red); font-size: 12.5px; margin-bottom: 8px; }
.notice { color: var(--green); font-size: 12.5px; margin-bottom: 8px; }
.row {
  display: flex; align-items: center; gap: 10px;
  background: var(--bg-elevated); border: 1px solid var(--border);
  border-radius: 10px; padding: 9px 12px; margin-bottom: 8px;
}
.kind-col { flex: none; width: 190px; min-width: 0; }
.kind { font-family: var(--mono); font-size: 12.5px; color: var(--accent); }
.kind-desc { font-size: 10.5px; color: var(--text-faint); margin-top: 2px; }
.model-input, .provider-select {
  padding: 6px 9px; border-radius: 7px; border: 1px solid var(--border);
  background: var(--bg); color: var(--text); font-size: 12.5px; min-width: 0;
}
.model-input { flex: 1; }
.provider-select { flex: none; width: 190px; }
.empty { color: var(--text-faint); text-align: center; padding: 14px; font-size: 12.5px; }
.add-row { display: flex; gap: 8px; margin-top: 10px; }
.add-row input, .add-row select {
  padding: 6px 9px; border-radius: 7px; border: 1px solid var(--border);
  background: var(--bg); color: var(--text); font-size: 12.5px; min-width: 0;
}
.add-kind-wrap { position: relative; flex: none; width: 200px; }
.add-kind { width: 100%; }
.kind-menu {
  position: absolute; top: calc(100% + 4px); left: 0; z-index: 10;
  min-width: 100%; width: max-content; max-width: 320px;
  margin: 0; padding: 4px; list-style: none;
  background: var(--bg-elevated); border: 1px solid var(--border);
  border-radius: 8px; box-shadow: 0 6px 16px rgba(0, 0, 0, 0.35);
}
.kind-menu li {
  display: flex; align-items: center; justify-content: space-between;
  gap: 10px; padding: 6px 8px; border-radius: 6px; cursor: pointer;
}
.kind-menu li:hover { background: var(--bg-hover); }
.kind-menu-label { font-size: 12px; color: var(--text); white-space: nowrap; }
.kind-menu-id { font-family: var(--mono); font-size: 11px; color: var(--text-faint); }
.add-model { flex: 1; }
.add-provider { flex: none; width: 180px; }
</style>
