<script setup lang="ts">
// 设置页·Skill Hub 技能市场面板：内置目录 + 远程 registry 浏览、预览、一键安装。
// 数据源：GET /api/skill-hub（合并目录 + installedIn）；安装：POST /api/skill-hub/install；
// 卸载复用既有 DELETE /api/skills/:name（口径与 Skills 面板一致）；
// 远程源配置：GET/PUT /api/skill-hub/sources（<configHome>/.y-zero/skill-hub.json）。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  api,
  type HubEntryView,
  type HubListResponse,
  type HubSourceConfig,
} from '../../api/client';
import { useWorkspaceStore } from '../../stores/workspace';
import { renderMarkdown } from '../../render';

const ws = useWorkspaceStore();

const loading = ref(false);
const error = ref('');
const notice = ref('');
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
const data = ref<HubListResponse | null>(null);

// ── 过滤状态 ────────────────────────────────────────────────
const query = ref('');
const activeCategory = ref('全部');

const categories = computed<string[]>(() => {
  const set = new Set<string>();
  for (const item of data.value?.items ?? []) if (item.category) set.add(item.category);
  return ['全部', ...[...set].sort()];
});

const filteredItems = computed<HubEntryView[]>(() => {
  const needle = query.value.trim().toLowerCase();
  return (data.value?.items ?? []).filter((item) => {
    if (activeCategory.value !== '全部' && item.category !== activeCategory.value) return false;
    if (!needle) return true;
    return (
      item.name.toLowerCase().includes(needle) ||
      item.description.toLowerCase().includes(needle) ||
      item.triggers.some((t) => t.toLowerCase().includes(needle))
    );
  });
});

// ── 项目联动 ────────────────────────────────────────────────
const projectEnabled = computed(() => Boolean(ws.activeProjectId));

function showNotice(text: string) {
  notice.value = text;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.value = ''), 2500);
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    data.value = await api.hubList(ws.activeProjectId ?? undefined);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);
// 切换活跃项目 → 项目层安装状态随之变化，重新拉取
watch(() => ws.activeProjectId, () => void load());
onBeforeUnmount(() => {
  if (noticeTimer) clearTimeout(noticeTimer);
});

// ── 安装 / 覆盖重装 / 卸载 ──────────────────────────────────
const busy = ref('');
const scopeLabel = { user: '用户级', project: '项目级' } as const;

async function install(item: HubEntryView, scope: 'user' | 'project') {
  if (busy.value) return;
  busy.value = `${item.name}:${scope}`;
  error.value = '';
  try {
    await api.hubInstall({
      source: item.source,
      name: item.name,
      scope,
      projectId: scope === 'project' ? ws.activeProjectId ?? undefined : undefined,
    });
    showNotice(`✓ 已${item.installedIn[scope] ? '覆盖重装' : '安装'}「${item.name}」到${scopeLabel[scope]}`);
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = '';
  }
}

/** 卸载指定层（内置层不可卸载，按钮层面已拦截） */
async function uninstall(item: HubEntryView, scope: 'user' | 'project') {
  if (busy.value) return;
  if (!window.confirm(`卸载${scopeLabel[scope]} Skill「${item.name}」？该目录将被移除。`)) return;
  busy.value = `${item.name}:${scope}:rm`;
  error.value = '';
  try {
    await api.deleteSkill(item.name, scope, scope === 'project' ? ws.activeProjectId ?? undefined : undefined);
    showNotice(`✓ 已卸载${scopeLabel[scope]} Skill「${item.name}」`);
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = '';
  }
}

// ── 预览（详情区：markdown 渲染 + 原始 SKILL.md 折叠）────────
const previewKey = ref('');
const previewLoading = ref(false);
const previewItem = ref<HubEntryView | null>(null);
const previewError = ref('');

const itemKey = (item: Pick<HubEntryView, 'name' | 'source'>): string => `${item.source}/${item.name}`;

/** 原始 SKILL.md 文本（frontmatter 与安装时 serializeSkillMd 同构） */
const previewRaw = computed<string>(() => {
  const p = previewItem.value;
  if (!p) return '';
  const lines = ['---', `description: ${p.description || '（待补充）'}`];
  if (p.triggers.length) {
    lines.push('triggers:');
    for (const t of p.triggers) lines.push(`  - ${t}`);
  }
  if (p.toolsAllowlist.length) {
    lines.push('tools_allowlist:');
    for (const t of p.toolsAllowlist) lines.push(`  - ${t}`);
  }
  lines.push('---', '', p.body);
  return lines.join('\n');
});

async function togglePreview(item: HubEntryView) {
  const key = itemKey(item);
  if (previewKey.value === key) {
    previewKey.value = '';
    previewItem.value = null;
    return;
  }
  previewKey.value = key;
  previewLoading.value = true;
  previewError.value = '';
  try {
    // 从服务端按 source+name 取权威条目（远程源实时拉取），与安装内容严格一致
    previewItem.value = await api.hubItem(item.source, item.name, ws.activeProjectId ?? undefined);
  } catch (e) {
    previewError.value = (e as Error).message;
    previewItem.value = null;
  } finally {
    previewLoading.value = false;
  }
}

// ── 远程源管理弹层 ──────────────────────────────────────────
const sourcesOpen = ref(false);
const sourcesDraft = ref<HubSourceConfig[]>([]);
const newSourceName = ref('');
const newSourceUrl = ref('');
const sourcesError = ref('');
const sourcesSaving = ref(false);

async function openSources() {
  sourcesOpen.value = true;
  sourcesError.value = '';
  newSourceName.value = '';
  newSourceUrl.value = '';
  try {
    const r = await api.hubSources();
    sourcesDraft.value = r.sources.map((s) => ({ ...s }));
    if (r.error) sourcesError.value = r.error;
  } catch (e) {
    sourcesError.value = (e as Error).message;
  }
}

function addSource() {
  const name = newSourceName.value.trim();
  const url = newSourceUrl.value.trim();
  if (!name || !url) {
    sourcesError.value = '源名称与 URL 均不能为空';
    return;
  }
  if (!/^https?:\/\//.test(url)) {
    sourcesError.value = 'URL 必须以 http(s):// 开头';
    return;
  }
  if (sourcesDraft.value.some((s) => s.name === name)) {
    sourcesError.value = `源名称「${name}」已存在`;
    return;
  }
  sourcesDraft.value.push({ name, url });
  newSourceName.value = '';
  newSourceUrl.value = '';
  sourcesError.value = '';
}

function removeSourceAt(index: number) {
  sourcesDraft.value.splice(index, 1);
}

async function saveSources() {
  if (sourcesSaving.value) return;
  sourcesSaving.value = true;
  sourcesError.value = '';
  try {
    await api.hubSaveSources(sourcesDraft.value.map((s) => ({ name: s.name.trim(), url: s.url.trim() })));
    sourcesOpen.value = false;
    showNotice('✓ 远程源配置已保存');
    await load();
  } catch (e) {
    sourcesError.value = (e as Error).message;
  } finally {
    sourcesSaving.value = false;
  }
}

// ── URL 导入弹层 ────────────────────────────────────────────
const importOpen = ref(false);
const importUrl = ref('');
const importName = ref('');
const importScope = ref<'user' | 'project'>('user');
const importBusy = ref(false);

async function doImport() {
  const url = importUrl.value.trim();
  if (!url || importBusy.value) return;
  importBusy.value = true;
  error.value = '';
  try {
    const r = await api.hubInstall({
      url,
      name: importName.value.trim() || undefined,
      scope: importScope.value,
      projectId: importScope.value === 'project' ? ws.activeProjectId ?? undefined : undefined,
    });
    importOpen.value = false;
    importUrl.value = '';
    importName.value = '';
    showNotice(`✓ 已从 URL 导入「${r.name}」到${scopeLabel[importScope.value]}`);
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    importBusy.value = false;
  }
}
</script>

<template>
  <section class="panel">
    <header class="panel-head">
      <div>
        <h2 class="panel-title">🛒 Skill Hub 技能市场</h2>
        <p class="panel-sub">
          从内置目录与远程 registry 浏览、预览并一键安装技能。
          安装后对后续会话的 <code>/</code> 技能补全与 prompt 组装即时生效；
          本地 Skill 无版本字段，重装 = 覆盖同名文件。
        </p>
      </div>
      <div class="head-ops">
        <button class="btn" :disabled="loading" @click="load">↻ 刷新</button>
        <button class="btn" @click="openSources">⚙ 管理远程源</button>
        <button class="btn" @click="importOpen = true">⬇ 从 URL 导入</button>
      </div>
    </header>

    <p v-if="error" class="error">✘ {{ error }}</p>
    <p v-else-if="notice" class="notice">{{ notice }}</p>
    <p v-if="data?.errors?.length" class="warn">
      部分目录/源存在问题：<span v-for="e in data.errors" :key="e" class="warn-item">{{ e }}</span>
    </p>

    <!-- 过滤工具行 -->
    <div class="toolbar">
      <input v-model="query" class="search" placeholder="搜索名称 / 描述 / 触发词…" />
      <div class="chips">
        <button
          v-for="c in categories"
          :key="c"
          class="cat-chip"
          :class="{ on: activeCategory === c }"
          @click="activeCategory = c"
        >{{ c }}</button>
      </div>
    </div>

    <!-- 卡片网格 -->
    <div v-if="loading" class="empty">加载中…</div>
    <div v-else-if="filteredItems.length === 0" class="empty">
      {{ query || activeCategory !== '全部' ? '没有匹配的技能，试试清空搜索或切换分类。' : '目录为空。' }}
    </div>
    <div v-else class="grid">
      <div v-for="item in filteredItems" :key="itemKey(item)" class="card" :class="{ open: previewKey === itemKey(item) }">
        <div class="card-head">
          <b class="sname">{{ item.name }}</b>
          <span class="tag source" :class="item.source === 'builtin' ? 'builtin' : 'remote'">
            {{ item.source === 'builtin' ? '内置' : item.source }}
          </span>
          <span class="pill">{{ item.category }}</span>
        </div>
        <p class="meta">v{{ item.version }} · {{ item.author }}</p>
        <p class="desc" :title="item.description">{{ item.description || '（无描述）' }}</p>
        <div class="chips">
          <span v-for="t in item.triggers" :key="t" class="chip">触发：{{ t }}</span>
        </div>
        <div class="chips installed">
          <span v-if="item.installedIn.user" class="tag inst user">✓ 用户级</span>
          <span v-if="item.installedIn.project" class="tag inst project">✓ 项目级</span>
          <span v-if="item.installedIn.builtin" class="tag inst builtin">✓ 内置</span>
        </div>
        <div class="card-ops">
          <button
            v-if="!item.installedIn.user && !item.installedIn.project && !item.installedIn.builtin"
            class="btn sm primary"
            :disabled="Boolean(busy)"
            @click="install(item, 'user')"
          >{{ busy === `${item.name}:user` ? '安装中…' : '安装到用户级' }}</button>
          <button
            v-else
            class="btn sm"
            :disabled="Boolean(busy)"
            :title="`覆盖${scopeLabel.user}同名文件`"
            @click="install(item, 'user')"
          >覆盖重装{{ busy === `${item.name}:user` ? '…' : '' }}</button>
          <button
            class="btn sm"
            :disabled="!projectEnabled || Boolean(busy)"
            :title="projectEnabled ? `安装到当前项目 .y-zero/skills/` : '未选择项目：回到工作台选中项目后可用'"
            @click="install(item, 'project')"
          >安装到项目级</button>
          <button class="btn sm" @click="togglePreview(item)">
            {{ previewKey === itemKey(item) ? '收起预览' : '预览' }}
          </button>
          <button
            v-if="item.installedIn.user"
            class="btn sm danger"
            :disabled="Boolean(busy)"
            @click="uninstall(item, 'user')"
          >卸载用户级</button>
          <button
            v-if="item.installedIn.project"
            class="btn sm danger"
            :disabled="Boolean(busy)"
            @click="uninstall(item, 'project')"
          >卸载项目级</button>
        </div>
      </div>
    </div>

    <!-- 预览详情区（markdown 消毒后渲染 + 原始 SKILL.md 折叠） -->
    <div v-if="previewKey" class="preview">
      <div class="preview-head">
        <b>{{ previewItem?.name ?? previewKey }}</b>
        <span v-if="previewItem" class="tag source" :class="previewItem.source === 'builtin' ? 'builtin' : 'remote'">
          {{ previewItem.source === 'builtin' ? '内置' : previewItem.source }}
        </span>
        <button class="btn sm close" @click="previewKey = ''; previewItem = null">✕ 关闭</button>
      </div>
      <p v-if="previewLoading" class="empty">加载预览中…</p>
      <p v-else-if="previewError" class="error">✘ {{ previewError }}</p>
      <template v-else-if="previewItem">
        <div class="preview-meta">
          <span class="pill">{{ previewItem.category }}</span>
          <span>v{{ previewItem.version }}</span>
          <span>{{ previewItem.author }}</span>
          <span v-if="previewItem.toolsAllowlist.length" class="allow">工具白名单：{{ previewItem.toolsAllowlist.join(' / ') }}</span>
        </div>
        <!-- body 经 markdown-it + DOMPurify 消毒后渲染（renderMarkdown） -->
        <div class="preview-body md" v-html="renderMarkdown(previewItem.body)" />
        <details class="raw">
          <summary>原始 SKILL.md</summary>
          <pre>{{ previewRaw }}</pre>
        </details>
      </template>
    </div>

    <!-- 远程源管理弹层 -->
    <div v-if="sourcesOpen" class="overlay" @click.self="sourcesOpen = false">
      <div class="modal">
        <div class="modal-head">
          <b>⚙ 管理远程源</b>
          <button class="btn sm close" @click="sourcesOpen = false">✕ 关闭</button>
        </div>
        <p class="modal-sub">
          每个源是一个 registry JSON（<code>{ "skills": [HubEntry] }</code>）。
          打开 Skill Hub 列表时实时拉取（10s 超时，单源失败不影响其他源）。
        </p>
        <p v-if="sourcesError" class="error">✘ {{ sourcesError }}</p>
        <div v-if="sourcesDraft.length" class="source-list">
          <div v-for="(s, i) in sourcesDraft" :key="s.name" class="source-row">
            <b class="sname">{{ s.name }}</b>
            <span class="url" :title="s.url">{{ s.url }}</span>
            <button class="btn sm danger" @click="removeSourceAt(i)">删除</button>
          </div>
        </div>
        <p v-else class="empty">暂无远程源，仅展示内置目录。</p>
        <div class="add-source">
          <input v-model="newSourceName" placeholder="源名称（如：团队源）" />
          <input v-model="newSourceUrl" class="grow" placeholder="https://…/registry.json" @keyup.enter="addSource" />
          <button class="btn sm" @click="addSource">＋ 添加</button>
        </div>
        <div class="modal-ops">
          <button class="btn primary" :disabled="sourcesSaving" @click="saveSources">
            {{ sourcesSaving ? '保存中…' : '保存配置' }}
          </button>
          <button class="btn" @click="sourcesOpen = false">取消</button>
        </div>
      </div>
    </div>

    <!-- URL 导入弹层 -->
    <div v-if="importOpen" class="overlay" @click.self="importOpen = false">
      <div class="modal">
        <div class="modal-head">
          <b>⬇ 从 URL 导入 Skill</b>
          <button class="btn sm close" @click="importOpen = false">✕ 关闭</button>
        </div>
        <p class="modal-sub">
          URL 指向 SKILL.md 原文（raw），解析 frontmatter（description / triggers / tools_allowlist）后安装；
          不填名称时从 URL 路径自动推导。
        </p>
        <div class="import-form">
          <label class="field grow">
            <span class="fl">SKILL.md 原文 URL *</span>
            <input v-model="importUrl" placeholder="https://…/SKILL.md" />
          </label>
          <label class="field">
            <span class="fl">Skill 名称（可选）</span>
            <input v-model="importName" placeholder="my-skill" />
          </label>
          <label class="field">
            <span class="fl">安装到</span>
            <select v-model="importScope">
              <option value="user">用户级 ~/.y-zero/skills/</option>
              <option value="project" :disabled="!projectEnabled">项目级 .y-zero/skills/</option>
            </select>
          </label>
        </div>
        <div class="modal-ops">
          <button class="btn primary" :disabled="importBusy || !importUrl.trim()" @click="doImport">
            {{ importBusy ? '导入中…' : '导入并安装' }}
          </button>
          <button class="btn" @click="importOpen = false">取消</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.panel { display: flex; flex-direction: column; gap: 12px; }
.panel-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.panel-title { font-size: 15px; font-weight: 600; }
.panel-sub { font-size: 12px; color: var(--text-dim); margin-top: 4px; line-height: 1.6; max-width: 640px; }
.panel-sub code { font-family: var(--mono); color: var(--accent); }
.head-ops { display: flex; gap: 8px; flex-shrink: 0; }

.error { color: var(--red); font-size: 12.5px; }
.notice { color: var(--green); font-size: 12.5px; }
.warn { color: var(--orange); font-size: 12px; }
.warn-item { display: inline-block; margin-right: 10px; font-family: var(--mono); }
.empty { color: var(--text-dim); font-size: 12.5px; padding: 16px 0; text-align: center; }

/* 过滤工具行 */
.toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.search {
  height: 30px; padding: 0 10px; font-size: 12.5px; width: 240px;
  background: var(--bg); border: 1px solid var(--border); border-radius: 8px; color: var(--text);
}
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.cat-chip {
  padding: 3px 12px; border-radius: 999px; border: 1px solid var(--border);
  background: var(--bg-elevated); color: var(--text-dim); font-size: 12px; cursor: pointer;
  transition: all 0.12s;
}
.cat-chip:hover { border-color: var(--border-strong); color: var(--text); }
.cat-chip.on { background: var(--accent-soft); border-color: var(--accent-border); color: var(--accent); font-weight: 600; }

/* 卡片网格：自适应列宽（1280px 下 ≥2 列，宽屏 3–4 列） */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 10px;
}
.card {
  display: flex; flex-direction: column; gap: 6px;
  border: 1px solid var(--border); border-radius: 10px;
  background: var(--bg-elevated); padding: 12px 14px;
  transition: border-color 0.12s;
}
.card:hover, .card.open { border-color: var(--border-strong); }
.card.open { border-color: var(--accent-border); }
.card-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sname { font-family: var(--mono); font-size: 13px; color: var(--text); }
.tag { font-size: 9.5px; font-family: var(--mono); padding: 1px 6px; border-radius: 4px; font-weight: 400; }
.tag.source.builtin { background: var(--bg-hover); color: var(--text-dim); border: 1px solid var(--accent-border); }
.tag.source.remote { background: var(--purple-soft); color: var(--purple); }
.tag.inst.user { background: var(--accent-soft); color: var(--accent); }
.tag.inst.project { background: var(--green-soft); color: var(--green); }
.tag.inst.builtin { background: var(--bg-hover); color: var(--text-dim); }
.pill {
  font-size: 10.5px; padding: 1px 8px; border-radius: 999px; margin-left: auto;
  background: var(--bg); border: 1px solid var(--border); color: var(--text-dim);
}
.meta { font-size: 11px; color: var(--text-dim); font-family: var(--mono); }
.desc {
  font-size: 12px; color: var(--text-dim); line-height: 1.6;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.chip {
  font-size: 10.5px; font-family: var(--mono); padding: 1px 7px; border-radius: 4px;
  background: var(--bg); border: 1px solid var(--border); color: var(--text-dim);
}
.chips.installed { min-height: 4px; }
.card-ops { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
.btn.sm { padding: 4px 10px; font-size: 11.5px; }
.btn.danger { color: var(--red); }
.btn.danger:hover:not(:disabled) { border-color: rgba(248, 81, 73, 0.5); background: var(--red-soft); }

/* 预览详情区 */
.preview {
  border: 1px solid var(--accent-border); border-radius: 10px;
  background: var(--bg-elevated); padding: 14px 16px;
  display: flex; flex-direction: column; gap: 10px;
}
.preview-head { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.preview-head .close { margin-left: auto; }
.preview-meta {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  font-size: 11.5px; color: var(--text-dim); font-family: var(--mono);
}
.preview-meta .pill { margin-left: 0; }
.preview-meta .allow { color: var(--text); }
.preview-body { font-size: 13px; line-height: 1.7; color: var(--text); }
.preview-body :deep(h1), .preview-body :deep(h2), .preview-body :deep(h3) { margin: 14px 0 6px; font-size: 14px; }
.preview-body :deep(p) { margin: 6px 0; }
.preview-body :deep(ul), .preview-body :deep(ol) { padding-left: 22px; margin: 6px 0; }
.preview-body :deep(code) { font-family: var(--mono); font-size: 12px; background: var(--bg); padding: 1px 5px; border-radius: 4px; }
.preview-body :deep(pre) { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; overflow-x: auto; }
.preview-body :deep(pre code) { background: transparent; padding: 0; }
.preview-body :deep(table) { border-collapse: collapse; margin: 8px 0; }
.preview-body :deep(th), .preview-body :deep(td) { border: 1px solid var(--border); padding: 4px 10px; font-size: 12.5px; }
.preview-body :deep(blockquote) { border-left: 3px solid var(--border-strong); margin: 8px 0; padding: 2px 12px; color: var(--text-dim); }
.raw summary { cursor: pointer; font-size: 12px; color: var(--text-dim); }
.raw pre {
  margin-top: 8px; font-family: var(--mono); font-size: 11.5px; line-height: 1.6;
  background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
  padding: 10px 12px; overflow-x: auto; white-space: pre-wrap; color: var(--text-dim);
}

/* 弹层 */
.overlay {
  position: fixed; inset: 0; z-index: 60;
  background: rgba(0, 0, 0, 0.55);
  display: flex; align-items: center; justify-content: center;
}
.modal {
  width: 620px; max-width: calc(100vw - 48px); max-height: 80vh; overflow-y: auto;
  background: var(--bg-panel); border: 1px solid var(--border-strong); border-radius: 12px;
  padding: 16px 18px; display: flex; flex-direction: column; gap: 10px;
}
.modal-head { display: flex; align-items: center; gap: 8px; font-size: 13.5px; }
.modal-head .close { margin-left: auto; }
.modal-sub { font-size: 12px; color: var(--text-dim); line-height: 1.6; }
.modal-sub code { font-family: var(--mono); color: var(--accent); }
.source-list { display: flex; flex-direction: column; gap: 6px; }
.source-row {
  display: flex; align-items: center; gap: 10px;
  border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; background: var(--bg-elevated);
}
.source-row .url {
  flex: 1; min-width: 0; font-family: var(--mono); font-size: 11.5px; color: var(--text-dim);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.add-source { display: flex; gap: 8px; }
.add-source input {
  height: 30px; padding: 0 9px; font-size: 12.5px; background: var(--bg);
  border: 1px solid var(--border); border-radius: 8px; color: var(--text);
}
.add-source .grow { flex: 1; }
.modal-ops { display: flex; gap: 8px; }

/* 导入表单 */
.import-form { display: flex; flex-wrap: wrap; gap: 10px; }
.field { display: flex; flex-direction: column; gap: 4px; min-width: 160px; }
.field.grow { flex: 1 1 100%; }
.fl { font-size: 11px; color: var(--text-dim); }
.field input, .field select { height: 30px; padding: 0 9px; font-size: 12.5px; }
</style>
