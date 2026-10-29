<script setup lang="ts">
// 设置页·市场面板（F-52）：内置清单 + ~/.delta/registry.json 订阅源 → 浏览 / 预览 / 一键安装。
// Skills 页签沿用 Skill Hub 交互并新增 scripts 强制二次确认（409 弹窗逐脚本展示）；
// MCP 页签一键安装 = 配置草案 + 连通性测试进度，通过才写入 mcp.json。
// 数据源：GET /api/market、/api/market/item；安装：POST /api/market/install（409 走 apiFetch 直读）；
// 卸载：DELETE /api/market/item；订阅源：GET/PUT /api/market/sources。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  api,
  apiFetch,
  type MarketEntryView,
  type MarketItemResponse,
  type MarketSourceConfig,
  type MarketSnapshotResponse,
} from '../../api/client';
import { useWorkspaceStore } from '../../stores/workspace';
import { renderMarkdown } from '../../render';

const ws = useWorkspaceStore();

const loading = ref(false);
const error = ref('');
const notice = ref('');
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
const data = ref<MarketSnapshotResponse | null>(null);

/** 页签：skills | mcp */
const tab = ref<'skills' | 'mcp'>('skills');

const scopeLabel = { user: '用户级', project: '项目级' } as const;

// ── 过滤状态 ────────────────────────────────────────────────
const query = ref('');
const activeCategory = ref('全部');

const items = computed<MarketEntryView[]>(() =>
  (data.value?.items ?? []).filter((i) => i.kind === (tab.value === 'skills' ? 'skill' : 'mcp')));

const categories = computed<string[]>(() => {
  const set = new Set<string>();
  for (const item of items.value) if (item.category) set.add(item.category);
  return ['全部', ...[...set].sort()];
});

const filteredItems = computed<MarketEntryView[]>(() => {
  const needle = query.value.trim().toLowerCase();
  return items.value.filter((item) => {
    if (activeCategory.value !== '全部' && item.category !== activeCategory.value) return false;
    if (!needle) return true;
    return item.name.toLowerCase().includes(needle) || item.description.toLowerCase().includes(needle);
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
    data.value = await api.marketList(ws.activeProjectId ?? undefined);
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

const itemKey = (item: Pick<MarketEntryView, 'name' | 'kind' | 'source'>): string => `${item.kind}/${item.source}/${item.name}`;

/** 安装按钮进行中文案（MCP 有连通测试阶段） */
function stageLabel(item: MarketEntryView): string {
  return item.kind === 'mcp' ? '连通测试中…' : '安装中…';
}

/** 已装判定（skill 与 mcp 的层名不同） */
function installedLayers(item: MarketEntryView): string[] {
  const ins = item.installedIn;
  if (item.kind === 'skill') {
    return Object.entries(ins).filter(([, v]) => v).map(([k]) => (k === 'user' ? 'user' : k === 'project' ? 'project' : 'builtin'));
  }
  return Object.entries(ins).filter(([, v]) => v).map(([k]) => (k === 'global' ? 'user' : 'project'));
}

// ── 安装 / 卸载（含 scripts 确认与安装进度）─────────────────
const busy = ref('');
/** 安装进度阶段：fetching（取条目/清单）→ testing（仅 MCP 连通测试）→ writing → done/error */
const installStage = ref('');

/** scripts 二次确认弹窗状态（服务端 409 触发） */
const confirmOpen = ref(false);
const confirmItem = ref<MarketEntryView | null>(null);
const confirmScripts = ref<{ name: string; content: string }[]>([]);
const confirmScope = ref<'user' | 'project'>('user');
const confirmBusy = ref(false);

async function install(item: MarketEntryView, scope: 'user' | 'project') {
  if (busy.value) return;
  busy.value = itemKey(item);
  error.value = '';
  installStage.value = 'fetching';
  try {
    if (item.kind === 'mcp') installStage.value = 'testing';
    const { httpStatus, body } = await api.marketInstall({
      kind: item.kind,
      source: item.source,
      name: item.name,
      scope: item.kind === 'mcp' && scope === 'user' ? 'global' : scope,
      projectId: scope === 'project' ? ws.activeProjectId ?? undefined : undefined,
    });
    if (httpStatus === 409 && body.status === 'scripts_required') {
      // AC-52-3：含 scripts 的 Skill 强制逐脚本二次确认
      confirmItem.value = item;
      confirmScripts.value = (body.scripts as { name: string; content: string }[]) ?? [];
      confirmScope.value = scope;
      confirmOpen.value = true;
      return;
    }
    if (httpStatus >= 400) {
      error.value = (body.error as string) ?? `安装失败（HTTP ${httpStatus}）`;
      return;
    }
    const toolCount = body.toolCount as number | undefined;
    showNotice(
      item.kind === 'mcp'
        ? `✓ MCP Server「${item.name}」连通正常（${toolCount} 个工具），已写入${scope === 'project' ? '项目级' : '全局'} mcp.json`
        : `✓ 已${installedLayers(item).length ? '覆盖重装' : '安装'}「${item.name}」到${scopeLabel[scope]}`,
    );
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = '';
    installStage.value = '';
  }
}

/** scripts 弹窗确认后带 confirmScripts 重发安装 */
async function confirmInstall() {
  const item = confirmItem.value;
  if (!item || confirmBusy.value) return;
  confirmBusy.value = true;
  error.value = '';
  try {
    const { httpStatus, body } = await api.marketInstall({
      kind: item.kind,
      source: item.source,
      name: item.name,
      scope: confirmScope.value,
      confirmScripts: true,
      projectId: confirmScope.value === 'project' ? ws.activeProjectId ?? undefined : undefined,
    });
    if (httpStatus >= 400) {
      error.value = (body.error as string) ?? `安装失败（HTTP ${httpStatus}）`;
      confirmOpen.value = false;
      return;
    }
    const written = (body.scriptsWritten as string[]) ?? [];
    showNotice(`✓ 已安装「${item.name}」到${scopeLabel[confirmScope.value]}${written.length ? `（含脚本 ${written.join('、')}）` : ''}`);
    confirmOpen.value = false;
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    confirmBusy.value = false;
  }
}

/** 卸载指定层（内置层不可卸载，按钮层面已拦截） */
async function uninstall(item: MarketEntryView, scope: 'user' | 'project') {
  if (busy.value) return;
  const label = item.kind === 'mcp' && scope === 'user' ? '全局' : scopeLabel[scope];
  if (!window.confirm(`卸载${label}${item.kind === 'mcp' ? ' MCP Server' : ' Skill'}「${item.name}」？`)) return;
  busy.value = itemKey(item);
  error.value = '';
  try {
    await api.marketRemove(
      item.kind,
      item.name,
      item.kind === 'mcp' && scope === 'user' ? 'global' : scope,
      scope === 'project' ? ws.activeProjectId ?? undefined : undefined,
    );
    showNotice(`✓ 已卸载${label}「${item.name}」`);
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = '';
  }
}

// ── 预览（远程条目服务端附 untrusted 包裹预览）───────────────
const previewKey = ref('');
const previewLoading = ref(false);
const previewItem = ref<MarketEntryView | null>(null);
const previewBody = ref('');
const previewDesc = ref('');
const previewUntrusted = ref(false);
const previewError = ref('');

async function togglePreview(item: MarketEntryView) {
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
    const r: MarketItemResponse = await api.marketItem(item.kind, item.source, item.name, ws.activeProjectId ?? undefined);
    previewItem.value = r.entry;
    if (r.preview) {
      // 远程条目：description/body 为外部内容，服务端已按 F-44 口径 wrapUntrusted 包裹
      previewUntrusted.value = true;
      previewDesc.value = r.preview.description;
      previewBody.value = r.preview.body ?? '';
    } else {
      previewUntrusted.value = false;
      previewDesc.value = r.entry.description;
      previewBody.value = r.entry.kind === 'skill' ? r.entry.body : '';
    }
  } catch (e) {
    previewError.value = (e as Error).message;
    previewItem.value = null;
  } finally {
    previewLoading.value = false;
  }
}

// ── 订阅源管理弹层（registry.json）──────────────────────────
const sourcesOpen = ref(false);
const sourcesDraft = ref<MarketSourceConfig[]>([]);
const sourcesLegacy = ref(false);
const newSourceName = ref('');
const newSourceUrl = ref('');
const newSourceKind = ref<'skills' | 'mcp'>('skills');
const sourcesError = ref('');
const sourcesSaving = ref(false);

async function openSources() {
  sourcesOpen.value = true;
  sourcesError.value = '';
  newSourceName.value = '';
  newSourceUrl.value = '';
  newSourceKind.value = 'skills';
  try {
    const r = await api.marketSources();
    sourcesDraft.value = r.sources.map((s) => ({ ...s }));
    sourcesLegacy.value = Boolean(r.legacy);
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
  sourcesDraft.value.push({ name, url, kind: newSourceKind.value });
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
    await api.marketSaveSources(sourcesDraft.value.map((s) => ({ name: s.name.trim(), url: s.url.trim(), kind: s.kind })));
    sourcesOpen.value = false;
    showNotice('✓ 订阅源配置已保存（~/.delta/registry.json）');
    await load();
  } catch (e) {
    sourcesError.value = (e as Error).message;
  } finally {
    sourcesSaving.value = false;
  }
}
</script>

<template>
  <section class="panel">
    <header class="panel-head">
      <div>
        <h2 class="panel-title">🛒 市场</h2>
        <p class="panel-sub">
          内置清单 + 订阅源（<code>~/.delta/registry.json</code>）浏览与一键安装：Skill 装用户级/项目级目录即刻生效；
          MCP Server 安装前自动做连通性测试，通过才写入 mcp.json。
          含脚本的 Skill 安装前会强制逐脚本确认；离线时自动回退仅内置清单。
        </p>
      </div>
      <div class="head-ops">
        <button class="btn" :disabled="loading" @click="load">↻ 刷新</button>
        <button class="btn" @click="openSources">⚙ 管理订阅源</button>
      </div>
    </header>

    <p v-if="error" class="error">✘ {{ error }}</p>
    <p v-else-if="notice" class="notice">{{ notice }}</p>
    <p v-if="data?.legacySources" class="warn">
      当前订阅源来自旧 skill-hub.json（registry.json 尚未创建），在「管理订阅源」保存一次即完成迁移。
    </p>
    <p v-if="data?.sources?.some((s) => s.status === 'error')" class="warn">
      部分订阅源拉取失败，已回退（内置清单始终可用）：
      <span v-for="s in data.sources.filter((x) => x.status === 'error')" :key="s.name" class="warn-item">
        {{ s.name }}——{{ s.error }}
      </span>
    </p>
    <p v-if="data?.errors?.length" class="warn">
      <span v-for="e in data.errors" :key="e" class="warn-item">{{ e }}</span>
    </p>

    <!-- 页签 + 过滤工具行 -->
    <div class="toolbar">
      <div class="tabs">
        <button class="tab" :class="{ on: tab === 'skills' }" @click="tab = 'skills'; activeCategory = '全部'">
          🧩 Skills（{{ (data?.items ?? []).filter((i) => i.kind === 'skill').length }}）
        </button>
        <button class="tab" :class="{ on: tab === 'mcp' }" @click="tab = 'mcp'; activeCategory = '全部'">
          🔌 MCP Server（{{ (data?.items ?? []).filter((i) => i.kind === 'mcp').length }}）
        </button>
      </div>
      <input v-model="query" class="search" placeholder="搜索名称 / 描述…" />
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
      {{ query || activeCategory !== '全部' ? '没有匹配的条目，试试清空搜索或切换分类。' : '清单为空。' }}
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
        <p class="meta">v{{ item.version }} · {{ item.author }}<template v-if="item.kind === 'skill' && item.scripts?.length"> · ⚠ 含 {{ item.scripts.length }} 个脚本</template></p>
        <p class="desc" :title="item.description">{{ item.description || '（无描述）' }}</p>
        <div v-if="item.kind === 'skill' && item.triggers.length" class="chips">
          <span v-for="t in item.triggers" :key="t" class="chip">触发：{{ t }}</span>
        </div>
        <p v-if="item.kind === 'mcp'" class="chip mono">
          {{ item.draft.command ? `${item.draft.command} ${(item.draft.args ?? []).join(' ')}` : item.draft.url }}
        </p>
        <div class="chips installed">
          <span v-for="l in installedLayers(item)" :key="l" class="tag inst" :class="l">✓ {{ scopeLabel[l as 'user' | 'project'] ?? '内置' }}</span>
        </div>
        <div class="card-ops">
          <button
            v-if="installedLayers(item).length === 0"
            class="btn sm primary"
            :disabled="Boolean(busy)"
            @click="install(item, 'user')"
          >{{ busy === itemKey(item) ? stageLabel(item) : item.kind === 'mcp' ? '测试并安装' : '安装到用户级' }}</button>
          <button
            v-else
            class="btn sm"
            :disabled="Boolean(busy)"
            title="覆盖重装同名配置/文件"
            @click="install(item, 'user')"
          >{{ busy === itemKey(item) ? stageLabel(item) : '覆盖重装' }}</button>
          <button
            class="btn sm"
            :disabled="!projectEnabled || Boolean(busy)"
            :title="projectEnabled ? (item.kind === 'mcp' ? '写入当前项目 .delta/mcp.json' : '安装到当前项目 .delta/skills/') : '未选择项目：回到工作台选中项目后可用'"
            @click="install(item, 'project')"
          >安装到项目级</button>
          <button v-if="item.kind === 'skill'" class="btn sm" @click="togglePreview(item)">
            {{ previewKey === itemKey(item) ? '收起预览' : '预览' }}
          </button>
          <button
            v-if="installedLayers(item).includes('user')"
            class="btn sm danger"
            :disabled="Boolean(busy)"
            @click="uninstall(item, 'user')"
          >卸载{{ item.kind === 'mcp' ? '全局' : '用户级' }}</button>
          <button
            v-if="installedLayers(item).includes('project')"
            class="btn sm danger"
            :disabled="Boolean(busy)"
            @click="uninstall(item, 'project')"
          >卸载项目级</button>
        </div>
      </div>
    </div>

    <!-- 预览详情区（远程条目为 untrusted 包裹文本；markdown 消毒后渲染） -->
    <div v-if="previewKey" class="preview">
      <div class="preview-head">
        <b>{{ previewItem?.name ?? previewKey }}</b>
        <span v-if="previewItem" class="tag source" :class="previewItem.source === 'builtin' ? 'builtin' : 'remote'">
          {{ previewItem.source === 'builtin' ? '内置' : previewItem.source }}
        </span>
        <span v-if="previewUntrusted" class="tag untrusted">不可信内容（来自订阅源）</span>
        <button class="btn sm close" @click="previewKey = ''; previewItem = null">✕ 关闭</button>
      </div>
      <p v-if="previewLoading" class="empty">加载预览中…</p>
      <p v-else-if="previewError" class="error">✘ {{ previewError }}</p>
      <template v-else-if="previewItem">
        <div class="preview-meta">
          <span class="pill">{{ previewItem.category }}</span>
          <span>v{{ previewItem.version }}</span>
          <span>{{ previewItem.author }}</span>
          <span v-if="previewItem.kind === 'skill' && previewItem.toolsAllowlist.length" class="allow">工具白名单：{{ previewItem.toolsAllowlist.join(' / ') }}</span>
        </div>
        <div class="preview-body md" v-html="renderMarkdown(previewBody)" />
        <p v-if="previewItem.kind === 'skill' && previewItem.scripts?.length" class="warn">
          ⚠ 该条目含 {{ previewItem.scripts.length }} 个脚本，安装时将强制逐脚本确认。
        </p>
      </template>
    </div>

    <!-- scripts 二次确认弹层（AC-52-3：逐脚本展示） -->
    <div v-if="confirmOpen" class="overlay" @click.self="confirmOpen = false">
      <div class="modal">
        <div class="modal-head">
          <b>⚠ 安装确认：Skill「{{ confirmItem?.name }}」包含 {{ confirmScripts.length }} 个脚本</b>
          <button class="btn sm close" @click="confirmOpen = false">✕ 关闭</button>
        </div>
        <p class="modal-sub">
          脚本将以你的身份执行能力（技能触发时），安装前请逐脚本确认内容可信。
          来源：{{ confirmItem?.source }}。
        </p>
        <div v-for="s in confirmScripts" :key="s.name" class="script-block">
          <div class="script-name">scripts/{{ s.name }}</div>
          <pre>{{ s.content }}</pre>
        </div>
        <div class="modal-ops">
          <button class="btn primary" :disabled="confirmBusy" @click="confirmInstall">
            {{ confirmBusy ? '安装中…' : '确认安装（含以上脚本）' }}
          </button>
          <button class="btn" @click="confirmOpen = false">取消</button>
        </div>
      </div>
    </div>

    <!-- 订阅源管理弹层 -->
    <div v-if="sourcesOpen" class="overlay" @click.self="sourcesOpen = false">
      <div class="modal">
        <div class="modal-head">
          <b>⚙ 管理订阅源</b>
          <button class="btn sm close" @click="sourcesOpen = false">✕ 关闭</button>
        </div>
        <p class="modal-sub">
          每个源是一个 registry JSON（<code>{ "skills": [...], "mcpServers": [...] }</code>）。
          打开市场时实时拉取（10s 超时，单源失败不影响其他源与内置清单）。
        </p>
        <p v-if="sourcesLegacy" class="warn">当前数据来自旧 skill-hub.json，保存后写入 registry.json 并以此为准。</p>
        <p v-if="sourcesError" class="error">✘ {{ sourcesError }}</p>
        <div v-if="sourcesDraft.length" class="source-list">
          <div v-for="(s, i) in sourcesDraft" :key="s.name" class="source-row">
            <b class="sname">{{ s.name }}</b>
            <span class="tag" :class="s.kind === 'mcp' ? 'remote' : 'builtin'">{{ s.kind }}</span>
            <span class="url" :title="s.url">{{ s.url }}</span>
            <button class="btn sm danger" @click="removeSourceAt(i)">删除</button>
          </div>
        </div>
        <p v-else class="empty">暂无订阅源，仅展示内置清单。</p>
        <div class="add-source">
          <input v-model="newSourceName" placeholder="源名称（如：团队源）" />
          <select v-model="newSourceKind">
            <option value="skills">skills</option>
            <option value="mcp">mcp</option>
          </select>
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

/* 页签 + 过滤工具行 */
.toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.tabs { display: flex; gap: 6px; }
.tab {
  padding: 4px 12px; border-radius: 8px; border: 1px solid var(--border);
  background: var(--bg-elevated); color: var(--text-dim); font-size: 12.5px; cursor: pointer;
}
.tab.on { background: var(--accent-soft); border-color: var(--accent-border); color: var(--accent); font-weight: 600; }
.search {
  height: 30px; padding: 0 10px; font-size: 12.5px; width: 220px;
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

/* 卡片网格 */
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
.tag.untrusted { background: var(--orange-soft, rgba(255, 170, 0, 0.15)); color: var(--orange); }
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
.chip.mono { align-self: flex-start; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
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

/* 弹层 */
.overlay {
  position: fixed; inset: 0; z-index: 60;
  background: rgba(0, 0, 0, 0.55);
  display: flex; align-items: center; justify-content: center;
}
.modal {
  width: 680px; max-width: calc(100vw - 48px); max-height: 80vh; overflow-y: auto;
  background: var(--bg-panel); border: 1px solid var(--border-strong); border-radius: 12px;
  padding: 16px 18px; display: flex; flex-direction: column; gap: 10px;
}
.modal-head { display: flex; align-items: center; gap: 8px; font-size: 13.5px; }
.modal-head .close { margin-left: auto; }
.modal-sub { font-size: 12px; color: var(--text-dim); line-height: 1.6; }
.modal-sub code { font-family: var(--mono); color: var(--accent); }
.script-block {
  border: 1px solid var(--border); border-radius: 8px; overflow: hidden;
}
.script-name {
  font-family: var(--mono); font-size: 11.5px; padding: 5px 10px;
  background: var(--bg); color: var(--orange); border-bottom: 1px solid var(--border);
}
.script-block pre {
  margin: 0; padding: 10px 12px; font-family: var(--mono); font-size: 11.5px; line-height: 1.6;
  background: var(--bg-elevated); color: var(--text); overflow-x: auto; white-space: pre-wrap;
}
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
.add-source input, .add-source select {
  height: 30px; padding: 0 9px; font-size: 12.5px; background: var(--bg);
  border: 1px solid var(--border); border-radius: 8px; color: var(--text);
}
.add-source .grow { flex: 1; }
.modal-ops { display: flex; gap: 8px; }
</style>
