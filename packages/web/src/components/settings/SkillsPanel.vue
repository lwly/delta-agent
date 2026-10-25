<script setup lang="ts">
// 设置页·Skills 配置面板：三层技能列表（内置/用户级/项目级，同名覆盖标注）
// + 新建/编辑/删除（仅用户级与项目级可写，内置层只读可另存）。
// 数据源：GET /api/skills/detail（分层原始发现 + 合并视图）；写入：POST/DELETE /api/skills/:name
import { computed, onMounted, ref, watch } from 'vue';
import { api, type SkillDetailResponse, type SkillDetailView } from '../../api/client';
import { useWorkspaceStore } from '../../stores/workspace';

const ws = useWorkspaceStore();

const loading = ref(false);
const error = ref('');
const notice = ref('');
const data = ref<SkillDetailResponse | null>(null);

// ── 编辑器状态 ──────────────────────────────────────────────
// mode: create=新建 / edit=编辑既有（user|project）/ view=内置只读
const editor = ref<{
  mode: 'create' | 'edit' | 'view';
  originalName: string;
  originalScope: 'user' | 'project';
  name: string;
  scope: 'user' | 'project';
  description: string;
  triggersText: string;
  allowlistText: string;
  body: string;
} | null>(null);
const saving = ref(false);
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;

const projectEnabled = computed(() => Boolean(ws.activeProjectId));
const activeProjectName = computed(
  () => ws.projects.find((p) => p.id === ws.activeProjectId)?.name ?? '',
);

async function load() {
  loading.value = true;
  error.value = '';
  try {
    data.value = await api.skillDetails(ws.activeProjectId ?? undefined);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);
// 切换活跃项目 → 项目层技能随之变化，重新发现
watch(() => ws.activeProjectId, () => void load());

const layerMeta: Record<string, { label: string; cls: string }> = {
  builtin: { label: '内置', cls: 'builtin' },
  user: { label: '用户级', cls: 'user' },
  project: { label: '项目级', cls: 'project' },
};

/** 有效技能列表：内置 → 用户 → 项目排序（与覆盖优先级一致） */
const sortedSkills = computed<SkillDetailView[]>(() => {
  const skills = data.value?.skills ?? [];
  const order = { project: 0, user: 1, builtin: 2 } as Record<string, number>;
  return [...skills].sort((a, b) => (order[a.layer] ?? 9) - (order[b.layer] ?? 9) || a.name.localeCompare(b.name));
});

function openCreate() {
  editor.value = {
    mode: 'create', originalName: '', originalScope: 'user',
    name: '', scope: 'user', description: '', triggersText: '', allowlistText: '',
    body: '# 指令\n\n（描述该 Skill 何时触发、执行哪些步骤）\n',
  };
}

function openEdit(s: SkillDetailView) {
  const writable = s.layer !== 'builtin';
  editor.value = {
    mode: writable ? 'edit' : 'view',
    originalName: s.name,
    originalScope: s.layer === 'project' ? 'project' : 'user',
    name: s.name,
    scope: s.layer === 'project' ? 'project' : 'user',
    description: s.description,
    triggersText: s.triggers.join(', '),
    allowlistText: s.toolsAllowlist.join(', '),
    body: s.body,
  };
}

/** 内置层只读 → 另存为用户级副本（进入可编辑态，名称不变、落用户层） */
function duplicateToUser(s: SkillDetailView) {
  editor.value = {
    mode: 'edit',
    originalName: '',
    originalScope: 'user',
    name: s.name,
    scope: 'user',
    description: s.description,
    triggersText: s.triggers.join(', '),
    allowlistText: s.toolsAllowlist.join(', '),
    body: s.body,
  };
}

function closeEditor() {
  editor.value = null;
}

async function save() {
  const ed = editor.value;
  if (!ed || saving.value) return;
  error.value = '';
  if (!NAME_RE.test(ed.name)) {
    error.value = '名称仅允许字母数字与 - _，以字母数字开头，长度 2–64';
    return;
  }
  saving.value = true;
  try {
    await api.saveSkill(ed.name, {
      scope: ed.scope,
      projectId: ed.scope === 'project' ? ws.activeProjectId ?? undefined : undefined,
      description: ed.description,
      triggers: ed.triggersText.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
      toolsAllowlist: ed.allowlistText.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
      body: ed.body,
    });
    notice.value = `Skill「${ed.name}」已保存到${ed.scope === 'user' ? '用户级' : '项目级'}目录`;
    closeEditor();
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}

async function remove(s: SkillDetailView) {
  const scope = s.layer === 'project' ? 'project' : 'user';
  const where = scope === 'user' ? '用户级' : '项目级';
  if (!window.confirm(`删除${where} Skill「${s.name}」？该目录（含 references/）将被移除。`)) return;
  error.value = '';
  try {
    await api.deleteSkill(s.name, scope, scope === 'project' ? ws.activeProjectId ?? undefined : undefined);
    notice.value = `Skill「${s.name}」已删除`;
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}
</script>

<template>
  <section class="panel">
    <header class="panel-head">
      <div>
        <h2 class="panel-title">Skills 技能</h2>
        <p class="panel-sub">
          三层优先级：项目级 &gt; 用户级 &gt; 内置（同名覆盖）。
          <template v-if="projectEnabled">项目层扫描 <code>{{ activeProjectName }}</code> 的 .y-zero/skills/</template>
          <template v-else>未选择项目：项目层不参与（回到工作台选中项目后启用）</template>
        </p>
      </div>
      <div class="head-ops">
        <button class="btn" :disabled="loading" @click="load">↻ 刷新</button>
        <button class="btn primary" @click="openCreate">＋ 新建 Skill</button>
      </div>
    </header>

    <p v-if="error" class="error">✘ {{ error }}</p>
    <p v-else-if="notice" class="notice">✔ {{ notice }}</p>
    <p v-if="data?.errors?.length" class="warn">部分 Skill 包解析失败：<span v-for="e in data.errors" :key="e" class="warn-item">{{ e }}</span></p>

    <!-- 编辑器 -->
    <div v-if="editor" class="editor">
      <div class="editor-head">
        <b>{{ editor.mode === 'create' ? '新建 Skill' : editor.mode === 'edit' ? `编辑：${editor.originalName}` : '查看（内置只读）' }}</b>
        <span class="tag layer" :class="layerMeta[editor.mode === 'create' ? editor.scope : editor.originalScope]?.cls">
          {{ editor.mode === 'create' ? '新建' : layerMeta[editor.originalScope]?.label }}
        </span>
        <button class="btn sm close" @click="closeEditor">✕ 关闭</button>
      </div>
      <div class="editor-grid">
        <label class="field">
          <span class="fl">名称（目录名）</span>
          <input v-model="editor.name" :disabled="editor.mode === 'edit' || editor.mode === 'view'" placeholder="code-review" />
        </label>
        <label class="field">
          <span class="fl">写入层</span>
          <select v-model="editor.scope" :disabled="editor.mode === 'view'">
            <option value="user">用户级 ~/.y-zero/skills/</option>
            <option value="project" :disabled="!projectEnabled">项目级 .y-zero/skills/</option>
          </select>
        </label>
        <label class="field grow">
          <span class="fl">描述（frontmatter description）</span>
          <input v-model="editor.description" :disabled="editor.mode === 'view'" placeholder="何时使用这个技能" />
        </label>
        <label class="field">
          <span class="fl">触发词（逗号分隔）</span>
          <input v-model="editor.triggersText" :disabled="editor.mode === 'view'" placeholder="review, 审查" />
        </label>
        <label class="field">
          <span class="fl">工具白名单（逗号分隔，可空）</span>
          <input v-model="editor.allowlistText" :disabled="editor.mode === 'view'" placeholder="read_file, grep" />
        </label>
      </div>
      <label class="field">
        <span class="fl">指令主体（SKILL.md 正文，Markdown）</span>
        <textarea v-model="editor.body" class="body-input" rows="12" :disabled="editor.mode === 'view'" />
      </label>
      <div class="editor-ops" v-if="editor.mode !== 'view'">
        <button class="btn primary" :disabled="saving || !editor.name" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
        <button class="btn" @click="closeEditor">取消</button>
        <span class="hint">保存后对后续会话的 / 技能补全与 prompt 组装生效</span>
      </div>
      <div class="editor-ops" v-else>
        <button class="btn" @click="duplicateToUser(sortedSkills.find((s) => s.name === editor!.originalName)!)">另存为用户级副本</button>
      </div>
    </div>

    <!-- 技能列表 -->
    <div class="list">
      <div v-for="s in sortedSkills" :key="s.layer + '/' + s.name" class="row">
        <div class="row-main">
          <div class="row-title">
            <span class="tag layer" :class="layerMeta[s.layer]?.cls">{{ layerMeta[s.layer]?.label }}</span>
            <b class="sname">{{ s.name }}</b>
            <span v-if="s.shadowing" class="tag shadow" :title="`同名 Skill 同时存在于更低层，当前展示的是 ${layerMeta[s.layer]?.label} 版本`">覆盖 {{ layerMeta[s.shadowing]?.label }}</span>
            <span
              v-if="(data?.availability[s.name]?.length ?? 0) > 1"
              class="tag avail"
              :title="'同名存在于：' + (data?.availability[s.name] ?? []).map((l) => layerMeta[l]?.label ?? l).join(' / ')"
            >{{ (data?.availability[s.name] ?? []).length }} 层同名</span>
          </div>
          <p class="sdesc">{{ s.description || '（无描述）' }}</p>
          <div class="chips">
            <span v-for="t in s.triggers" :key="t" class="chip">触发：{{ t }}</span>
            <span v-for="t in s.toolsAllowlist" :key="t" class="chip alt">工具：{{ t }}</span>
            <span v-if="s.references.length" class="chip alt">references × {{ s.references.length }}</span>
          </div>
          <p class="sdir" :title="s.dir">{{ s.dir }}</p>
        </div>
        <div class="row-ops">
          <button class="btn sm" @click="openEdit(s)">{{ s.layer === 'builtin' ? '查看' : '编辑' }}</button>
          <button v-if="s.layer !== 'builtin'" class="btn sm danger" @click="remove(s)">删除</button>
        </div>
      </div>
      <p v-if="!loading && sortedSkills.length === 0" class="empty">未发现任何 Skill。点「＋ 新建 Skill」创建第一个用户级技能。</p>
    </div>
  </section>
</template>

<style scoped>
.panel { display: flex; flex-direction: column; gap: 12px; }
.panel-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.panel-title { font-size: 15px; font-weight: 600; }
.panel-sub { font-size: 12px; color: var(--text-dim); margin-top: 4px; line-height: 1.6; }
.panel-sub code { font-family: var(--mono); color: var(--accent); }
.head-ops { display: flex; gap: 8px; flex-shrink: 0; }

.error { color: var(--red); font-size: 12.5px; }
.notice { color: var(--green); font-size: 12.5px; }
.warn { color: var(--orange); font-size: 12px; }
.warn-item { display: inline-block; margin-right: 10px; font-family: var(--mono); }
.empty { color: var(--text-faint); font-size: 12.5px; padding: 16px 0; text-align: center; }
.hint { font-size: 11px; color: var(--text-faint); }

.tag { font-size: 9.5px; font-family: var(--mono); padding: 1px 6px; border-radius: 4px; font-weight: 400; }
.tag.layer.builtin { background: var(--bg-hover); color: var(--text-dim); }
.tag.layer.user { background: var(--accent-soft); color: var(--accent); }
.tag.layer.project { background: var(--green-soft); color: var(--green); }
.tag.shadow { background: var(--orange-soft); color: var(--orange); }
.tag.avail { background: var(--bg-elevated); color: var(--text-faint); border: 1px solid var(--border); }

/* 编辑器 */
.editor {
  border: 1px solid var(--accent-border); border-radius: 10px;
  background: var(--bg-elevated); padding: 14px 16px;
  display: flex; flex-direction: column; gap: 10px;
}
.editor-head { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.editor-head .close { margin-left: auto; }
.editor-grid { display: flex; flex-wrap: wrap; gap: 10px; }
.field { display: flex; flex-direction: column; gap: 4px; min-width: 200px; }
.field.grow { flex: 1; }
.fl { font-size: 11px; color: var(--text-dim); }
.field input, .field select { height: 30px; padding: 0 9px; font-size: 12.5px; }
.body-input {
  font-family: var(--mono); font-size: 12.5px; line-height: 1.6;
  width: 100%; resize: vertical; background: var(--bg); color: var(--text);
}
.editor-ops { display: flex; align-items: center; gap: 8px; }

/* 列表 */
.list { display: flex; flex-direction: column; gap: 8px; }
.row {
  display: flex; align-items: flex-start; gap: 12px;
  border: 1px solid var(--border); border-radius: 10px;
  background: var(--bg-elevated); padding: 12px 14px;
  transition: border-color 0.12s;
}
.row:hover { border-color: var(--border-strong); }
.row-main { flex: 1; min-width: 0; }
.row-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sname { font-family: var(--mono); font-size: 13px; color: var(--text); }
.sdesc { font-size: 12px; color: var(--text-dim); margin: 5px 0; line-height: 1.6; }
.chips { display: flex; flex-wrap: wrap; gap: 5px; }
.chip {
  font-size: 10.5px; font-family: var(--mono); padding: 1px 7px; border-radius: 4px;
  background: var(--bg); border: 1px solid var(--border); color: var(--text-dim);
}
.chip.alt { color: var(--text-faint); }
.sdir {
  font-size: 10.5px; font-family: var(--mono); color: var(--text-faint);
  margin-top: 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.row-ops { display: flex; gap: 6px; flex-shrink: 0; }
.btn.sm { padding: 4px 10px; font-size: 11.5px; }
.btn.danger { color: var(--red); }
.btn.danger:hover:not(:disabled) { border-color: rgba(248, 81, 73, 0.5); background: var(--red-soft); }
</style>
