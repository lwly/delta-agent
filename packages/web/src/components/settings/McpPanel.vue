<script setup lang="ts">
// 设置页·MCP 配置面板：全局（~/.delta/mcp.json）与项目级（<root>/.delta/mcp.json）
// 两作用域的 mcpServers 增删改（整体保存覆盖对应文件）。项目级同名覆盖全局。
// 如实标注：当前仅支持 stdio 传输；MCP 配置在 CLI 会话生效，Web 控制台会话尚未接入 MCP 桥。
import { computed, onMounted, ref, watch } from 'vue';
import { api, type McpConfigResponse } from '../../api/client';
import { useWorkspaceStore } from '../../stores/workspace';

const ws = useWorkspaceStore();

const loading = ref(false);
const error = ref('');
const notice = ref('');
const data = ref<McpConfigResponse | null>(null);

const scope = ref<'global' | 'project'>('global');

/** 单行编辑模型（args/env 以文本承载，保存时解析） */
interface ServerRow {
  name: string;
  command: string;
  argsText: string;
  envText: string;
  timeoutMs: string;
}
const rows = ref<ServerRow[]>([]);
const dirty = ref(false);
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;

const projectEnabled = computed(() => data.value?.projectEnabled ?? false);
const activeProjectName = computed(
  () => ws.projects.find((p) => p.id === ws.activeProjectId)?.name ?? '',
);
const scopePath = computed(() => {
  if (!data.value) return '';
  return scope.value === 'global' ? data.value.global.path : data.value.project?.path ?? '';
});
const scopeParseError = computed(() => {
  if (!data.value) return '';
  return scope.value === 'global' ? data.value.global.parseError ?? '' : data.value.project?.parseError ?? '';
});

function rowsFromFile(): ServerRow[] {
  if (!data.value) return [];
  const state = scope.value === 'global' ? data.value.global : data.value.project;
  if (!state) return [];
  return Object.entries(state.servers).map(([name, cfg]) => ({
    name,
    command: cfg.command,
    argsText: (cfg.args ?? []).join('\n'),
    envText: Object.entries(cfg.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'),
    timeoutMs: cfg.timeoutMs != null ? String(cfg.timeoutMs) : '',
  }));
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    data.value = await api.mcpConfigs(ws.activeProjectId ?? undefined);
    rows.value = rowsFromFile();
    dirty.value = false;
    if (scope.value === 'project' && !projectEnabled.value) scope.value = 'global';
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);
// 切换活跃项目 → 项目级配置文件路径变化，重新拉取
watch(() => ws.activeProjectId, () => void load());
// 切换作用域 → 从已加载数据重建编辑行
watch(scope, () => {
  rows.value = rowsFromFile();
  dirty.value = false;
});

function switchScope(next: 'global' | 'project') {
  if (next === 'project' && !projectEnabled.value) return;
  if (dirty.value && !window.confirm('当前作用域有未保存修改，切换将丢失，确定？')) return;
  scope.value = next;
}

function addRow() {
  rows.value.push({ name: '', command: '', argsText: '', envText: '', timeoutMs: '' });
  dirty.value = true;
}

function removeRow(i: number) {
  if (!window.confirm(`移除服务器「${rows.value[i]?.name || '未命名'}」？（保存后落盘）`)) return;
  rows.value.splice(i, 1);
  dirty.value = true;
}

/** 被另一作用域覆盖提示：编辑全局时该服务器在合并视图中的胜者是项目层 */
function shadowedBy(name: string): boolean {
  if (!data.value || scope.value !== 'global') return false;
  return data.value.merged[name]?.__source === 'project';
}

async function save() {
  if (!dirty.value || loading.value) return;
  error.value = '';
  const record: Record<string, { command: string; args?: string[]; env?: Record<string, string>; timeoutMs?: number }> = {};
  const seen = new Set<string>();
  for (const r of rows.value) {
    const name = r.name.trim();
    if (!NAME_RE.test(name)) {
      error.value = `服务器名称「${name || '（空）'}」不合法：字母数字与 - _，字母数字开头，长度 2–64`;
      return;
    }
    if (seen.has(name)) {
      error.value = `服务器名称「${name}」重复`;
      return;
    }
    seen.add(name);
    if (!r.command.trim()) {
      error.value = `服务器「${name}」缺少 command（stdio 启动命令）`;
      return;
    }
    const entry: (typeof record)[string] = { command: r.command.trim() };
    const args = r.argsText.split('\n').map((s) => s.trim()).filter(Boolean);
    if (args.length) entry.args = args;
    const envLines = r.envText.split('\n').map((s) => s.trim()).filter(Boolean);
    const env: Record<string, string> = {};
    for (const line of envLines) {
      const eq = line.indexOf('=');
      if (eq <= 0) {
        error.value = `服务器「${name}」env 行格式错误：「${line}」（应为 KEY=VALUE）`;
        return;
      }
      env[line.slice(0, eq).trim()] = line.slice(eq + 1);
    }
    if (Object.keys(env).length) entry.env = env;
    if (r.timeoutMs.trim()) {
      const n = Number(r.timeoutMs);
      if (!Number.isFinite(n) || n <= 0) {
        error.value = `服务器「${name}」timeoutMs 必须是正数（毫秒）`;
        return;
      }
      entry.timeoutMs = Math.round(n);
    }
    record[name] = entry;
  }
  loading.value = true;
  try {
    await api.saveMcpServers(scope.value, record, scope.value === 'project' ? ws.activeProjectId ?? undefined : undefined);
    notice.value = `已保存到 ${scopePath.value}`;
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <section class="panel">
    <header class="panel-head">
      <div>
        <h2 class="panel-title">MCP 服务器</h2>
        <p class="panel-sub">
          配置 MCP 扩展工具（stdio 传输，<code>url</code> 字段保留）。
          项目级同名覆盖全局；修改在<b>新会话</b>生效。
        </p>
      </div>
      <div class="head-ops">
        <button class="btn" :disabled="loading" @click="load">↻ 刷新</button>
      </div>
    </header>

    <!-- 作用域切换 -->
    <div class="scope-bar">
      <button class="scope-pill" :class="{ on: scope === 'global' }" @click="switchScope('global')">
        全局 <code>~/.delta/mcp.json</code>
      </button>
      <button
        class="scope-pill"
        :class="{ on: scope === 'project', off: !projectEnabled }"
        :title="projectEnabled ? `项目级：${activeProjectName}` : '回到工作台选中项目后启用'"
        @click="switchScope('project')"
      >
        项目级 <code>.delta/mcp.json</code>
      </button>
      <span class="scope-path" :title="scopePath">{{ scopePath }}</span>
    </div>

    <p v-if="error" class="error">✘ {{ error }}</p>
    <p v-else-if="notice" class="notice">✔ {{ notice }}</p>
    <p v-if="scopeParseError" class="warn">⚠ 配置文件解析失败（{{ scopePath }}）：{{ scopeParseError }}。保存将覆盖该文件。</p>

    <!-- 服务器编辑行 -->
    <div class="rows">
      <div v-for="(r, i) in rows" :key="i" class="row" :class="{ shadowed: shadowedBy(r.name) }">
        <div class="row-grid">
          <label class="field">
            <span class="fl">名称</span>
            <input v-model="r.name" placeholder="filesystem" @input="dirty = true" />
          </label>
          <label class="field grow">
            <span class="fl">command（stdio 启动命令）</span>
            <input v-model="r.command" class="mono" placeholder="npx -y @modelcontextprotocol/server-filesystem /path" @input="dirty = true" />
          </label>
          <label class="field w80">
            <span class="fl">timeoutMs</span>
            <input v-model="r.timeoutMs" class="mono" placeholder="60000" @input="dirty = true" />
          </label>
        </div>
        <div class="row-grid">
          <label class="field grow">
            <span class="fl">args（每行一个参数）</span>
            <textarea v-model="r.argsText" class="mono mini" rows="2" placeholder="-y&#10;@modelcontextprotocol/server-filesystem" @input="dirty = true" />
          </label>
          <label class="field grow">
            <span class="fl">env（每行 KEY=VALUE）</span>
            <textarea v-model="r.envText" class="mono mini" rows="2" placeholder="API_KEY=xxx" @input="dirty = true" />
          </label>
        </div>
        <div class="row-foot">
          <span v-if="shadowedBy(r.name)" class="tag shadow" title="项目级存在同名服务器，运行时以项目级配置为准">被项目级覆盖</span>
          <button class="btn sm danger" @click="removeRow(i)">移除</button>
        </div>
      </div>
      <p v-if="rows.length === 0" class="empty">该作用域暂无 MCP 服务器配置。</p>
    </div>

    <div class="ops">
      <button class="btn" @click="addRow">＋ 添加服务器</button>
      <button class="btn primary" :disabled="!dirty || loading" @click="save">{{ loading ? '保存中…' : '保存（覆盖该作用域文件）' }}</button>
      <span v-if="!dirty" class="hint">无未保存修改</span>
    </div>

    <p class="foot-note">
      ⚠ 生效范围：MCP 配置当前由 CLI 运行（<code>delta</code> 命令行会话）加载；Web 控制台会话尚未接入 MCP
      工具桥，此处修改对 Web 会话不生效。工具将以 <code>mcp__&lt;服务器&gt;__&lt;工具&gt;</code> 形式注册并默认逐次确认。
    </p>
  </section>
</template>

<style scoped>
.panel { display: flex; flex-direction: column; gap: 12px; }
.panel-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.panel-title { font-size: 15px; font-weight: 600; }
.panel-sub { font-size: 12px; color: var(--text-dim); margin-top: 4px; line-height: 1.6; }
.panel-sub code { font-family: var(--mono); color: var(--accent); }
.head-ops { display: flex; gap: 8px; flex-shrink: 0; }

.scope-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.scope-pill {
  display: inline-flex; align-items: center; gap: 7px;
  padding: 6px 12px; border-radius: 8px; font-size: 12px;
  border: 1px solid var(--border); background: var(--bg-elevated); color: var(--text-dim);
  cursor: pointer; transition: all 0.12s;
}
.scope-pill code { font-family: var(--mono); font-size: 10.5px; color: var(--text-faint); }
.scope-pill:hover:not(.off) { border-color: var(--border-strong); color: var(--text); }
.scope-pill.on { border-color: var(--accent-border); background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.scope-pill.on code { color: var(--accent); }
.scope-pill.off { opacity: 0.45; cursor: not-allowed; }
.scope-path { font-size: 10.5px; font-family: var(--mono); color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.error { color: var(--red); font-size: 12.5px; }
.notice { color: var(--green); font-size: 12.5px; }
.warn { color: var(--orange); font-size: 12px; line-height: 1.6; }
.empty { color: var(--text-faint); font-size: 12.5px; padding: 12px 0; text-align: center; }
.hint { font-size: 11px; color: var(--text-faint); }
.tag { font-size: 9.5px; font-family: var(--mono); padding: 1px 6px; border-radius: 4px; }
.tag.shadow { background: var(--orange-soft); color: var(--orange); }

.rows { display: flex; flex-direction: column; gap: 10px; }
.row {
  border: 1px solid var(--border); border-radius: 10px;
  background: var(--bg-elevated); padding: 12px 14px;
  display: flex; flex-direction: column; gap: 8px;
}
.row:hover { border-color: var(--border-strong); }
.row.shadowed { border-color: rgba(210, 153, 34, 0.35); }
.row-grid { display: flex; gap: 10px; flex-wrap: wrap; }
.field { display: flex; flex-direction: column; gap: 4px; min-width: 160px; }
.field.grow { flex: 1; }
.field.w80 { width: 110px; min-width: 110px; }
.fl { font-size: 11px; color: var(--text-dim); }
.field input { height: 30px; padding: 0 9px; font-size: 12.5px; }
.mono { font-family: var(--mono); }
textarea.mini {
  font-size: 12px; line-height: 1.6; resize: vertical;
  width: 100%; background: var(--bg); color: var(--text);
}
.row-foot { display: flex; align-items: center; gap: 8px; justify-content: flex-end; }

.ops { display: flex; align-items: center; gap: 8px; }
.btn.sm { padding: 4px 10px; font-size: 11.5px; }
.btn.danger { color: var(--red); }
.btn.danger:hover:not(:disabled) { border-color: rgba(248, 81, 73, 0.5); background: var(--red-soft); }
.foot-note { font-size: 11.5px; color: var(--text-dim); line-height: 1.7; border-top: 1px dashed var(--border); padding-top: 10px; }
.foot-note code { font-family: var(--mono); color: var(--text-dim); }
</style>
