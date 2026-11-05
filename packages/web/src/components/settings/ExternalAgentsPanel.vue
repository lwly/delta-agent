<script setup lang="ts">
// 设置页·外部 Agent 面板（F-55，设计稿 §10/§5.2）：探测到的外部 CLI Agent 展示——
// 版本/来源/登录态 + plan/yolo 档支持度。不提供安装/卸载（delta 只探测不安装，§10/§16）。
// F-56（PASI-87）：增补手动注册——「添加外部 Agent」两步向导（第 1 步模板网格点选，
// 第 2 步显示名称/命令/描述，交互模式对齐 Multica 自定义运行时向导）+ 手动条目移除。
// AC-55-7：拉取失败静默显示空态文案，不弹错误。
import { onMounted, ref } from 'vue';
import ModalShell from '../ModalShell.vue';
import ModelCombobox from './ModelCombobox.vue';
import { api, type ExternalAgentInfo, type ExternalAgentTemplate } from '../../api/client';

const loading = ref(false);
const agents = ref<ExternalAgentInfo[]>([]);
/** 探测时间为挂载时刻的快照（重新进入 tab 即重挂载） */
const probedAt = ref('');

/** 环境变量提示（空态用）：id `cli:claude-code` → DELTA_EXTERNAL_CLAUDE_CODE_PATH */
function envPathName(id: string): string {
  const bare = id.replace(/^[a-z]+:/i, '');
  return `DELTA_EXTERNAL_${bare.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_PATH`;
}

/** 展示名优先级：手动 displayName > 模板 label > 稳定 id（AC-56-2） */
function displayLabel(a: ExternalAgentInfo): string {
  return a.displayName || a.label || a.id;
}

async function load() {
  loading.value = true;
  try {
    const res = await api.externalAgents();
    agents.value = res.agents;
    probedAt.value = new Date().toLocaleTimeString();
  } catch {
    // 拉取失败静默空态（AC-55-7：降级是显式提示不是报错）
    agents.value = [];
    probedAt.value = '';
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function sourceLabel(s: ExternalAgentInfo['source']): string {
  return s === 'env' ? '环境变量' : s === 'manual' ? '手动注册' : s === 'cache' ? '缓存' : 'PATH';
}

// ── F-56 两步注册向导 ──
const wizardOpen = ref(false);
const wizardStep = ref<1 | 2>(1);
const templates = ref<ExternalAgentTemplate[]>([]);
const templatesLoading = ref(false);
/** 第 2 步表单 */
const picked = ref<ExternalAgentTemplate | null>(null);
const formName = ref('');
const formCommand = ref('');
const formDesc = ref('');
const formModel = ref('');
const submitting = ref(false);
const formError = ref('');
/** F-56 自动获取模型：动态探测 + 静态清单合并后的下拉候选与来源提示 */
const modelOptions = ref<string[]>([]);
const modelSource = ref<'' | 'probed' | 'static'>('');
const modelLoading = ref(false);

/** 进入第 2 步后拉取模型清单：跑 CLI 列举命令（最长 8s）→ 合并静态候选 → datalist */
async function loadModelOptions(t: ExternalAgentTemplate) {
  modelLoading.value = true;
  modelSource.value = '';
  try {
    const res = await api.externalAgentModels(t.id, formCommand.value || t.executable);
    modelOptions.value = res.models;
    modelSource.value = res.source;
  } catch {
    modelOptions.value = t.models ?? []; // 静默回落模板静态清单
    modelSource.value = '';
  } finally {
    modelLoading.value = false;
  }
}

async function openWizard() {
  wizardOpen.value = true;
  wizardStep.value = 1;
  picked.value = null;
  formError.value = '';
  templatesLoading.value = true;
  try {
    const res = await api.externalAgentTemplates();
    templates.value = res.templates;
  } catch {
    templates.value = []; // 静默空态（AC-55-7 精神）
  } finally {
    templatesLoading.value = false;
  }
}

/** 第 1 步点选模板 → 第 2 步表单（名称/命令预填模板缺省值，描述留空） */
function pickTemplate(t: ExternalAgentTemplate) {
  picked.value = t;
  formName.value = t.label;
  formCommand.value = t.executable;
  formDesc.value = '';
  formModel.value = '';
  formError.value = '';
  wizardStep.value = 2;
  void loadModelOptions(t); // F-56 自动获取模型（动态探测 + 静态合并，静默降级）
}

async function submitRegister() {
  if (!picked.value || submitting.value) return;
  submitting.value = true;
  formError.value = '';
  try {
    await api.registerExternalAgent({
      templateId: picked.value.id,
      command: formCommand.value,
      displayName: formName.value,
      description: formDesc.value,
      model: formModel.value,
    });
    wizardOpen.value = false;
    await load();
  } catch (e) {
    formError.value = (e as Error).message; // 400 校验错误就地展示，不弹全局错误
  } finally {
    submitting.value = false;
  }
}

async function removeManual(a: ExternalAgentInfo) {
  try {
    await api.removeExternalAgent(a.id);
    await load();
  } catch {
    // 移除失败静默（仅手动条目可移除，探测缓存条目按钮不出现）
  }
}

// ── F-56 增补：修改模型（手动与自动探测条目统一支持）──
const editOpen = ref(false);
const editAgent = ref<ExternalAgentInfo | null>(null);
const editModel = ref('');
const editSaving = ref(false);
const editError = ref('');
/** 编辑弹窗的模型下拉候选（同注册向导：动态探测 + 静态清单合并，静默降级） */
const editOptions = ref<string[]>([]);
const editSource = ref<'' | 'probed' | 'static'>('');
const editLoading = ref(false);

function openEdit(a: ExternalAgentInfo) {
  editAgent.value = a;
  editModel.value = a.model ?? '';
  editError.value = '';
  editOpen.value = true;
  void loadEditOptions(a);
}

/** 拉取该 agent 的候选模型：agent id 即模板 id（cli:*），命令用条目当前 command */
async function loadEditOptions(a: ExternalAgentInfo) {
  editLoading.value = true;
  editSource.value = '';
  try {
    const res = await api.externalAgentModels(a.id, a.command);
    editOptions.value = res.models;
    editSource.value = res.source;
  } catch {
    editOptions.value = [];
    editSource.value = '';
  } finally {
    editLoading.value = false;
  }
}

async function submitEditModel() {
  if (!editAgent.value || editSaving.value) return;
  editSaving.value = true;
  editError.value = '';
  try {
    // 空串 = 清除模型，恢复 CLI 默认模型（后端 PATCH 语义）
    await api.setExternalAgentModel(editAgent.value.id, editModel.value.trim());
    editOpen.value = false;
    await load();
  } catch (e) {
    editError.value = (e as Error).message; // 400/404 就地展示，不弹全局错误
  } finally {
    editSaving.value = false;
  }
}
</script>

<template>
  <section class="panel">
    <header class="panel-head">
      <div>
        <h2 class="panel-title">外部 Agent</h2>
        <p class="panel-sub">
          探测本机已安装的外部 CLI Agent，或手动注册（<code>claude</code> / <code>codex</code> /
          <code>codebuddy</code> / <code>cursor-agent</code> / <code>opencode</code> / <code>dsh</code>）。
          新建会话时可在模型选择器中以 <code>cli:</code> 前缀选用。
        </p>
      </div>
      <div class="head-ops">
        <button class="btn" @click="openWizard">＋ 添加</button>
        <button class="btn" :disabled="loading" @click="load">↻ 重新探测</button>
      </div>
    </header>

    <!-- agent 卡片列表 -->
    <div class="rows">
      <div v-for="a in agents" :key="a.id" class="row">
        <div class="row-main">
          <code class="agent-id mono" :title="a.id">{{ displayLabel(a) }}</code>
          <span class="agent-cmd mono" :title="a.command">{{ a.command }}</span>
          <span class="agent-ver">{{ a.version }}</span>
          <span class="tag tier" :title="a.kind === 'reserved' ? 'Tier D：协议适配预留，暂不可执行' : `Tier ${a.tier} 协议`">Tier {{ a.tier }}</span>
          <span v-if="a.model" class="tag model" :title="`指定模型：${a.model}`">⚙ {{ a.model }}</span>
          <span class="tag src" :title="`来源：${a.command}`">{{ sourceLabel(a.source) }}</span>
          <button
            v-if="a.kind !== 'reserved'"
            class="btn"
            :title="a.model ? `当前模型：${a.model}，点击修改` : '指定该 CLI 启动时使用的模型'"
            @click="openEdit(a)"
          >改模型</button>
          <button v-if="a.manual" class="btn danger" title="移除手动注册条目" @click="removeManual(a)">移除</button>
        </div>
        <p v-if="a.description" class="row-desc">{{ a.description }}</p>
        <div class="row-caps">
          <span class="cap" :class="{ ok: a.loginState, miss: !a.loginState }">
            登录态 {{ a.loginState ? '✓' : '✗' }}
          </span>
          <span class="cap" :class="{ ok: a.planSupported, miss: !a.planSupported }" title="plan 只读档：上游 CLI 是否有只读计划模式">
            plan 档 {{ a.planSupported ? '✓' : '✗' }}
          </span>
          <span class="cap" :class="{ ok: a.yoloSupported, miss: !a.yoloSupported }" title="yolo 档：上游 CLI 是否有跳过全部确认的执行档">
            yolo 档 {{ a.yoloSupported ? '✓' : '✗' }}
          </span>
        </div>
        <p v-if="!a.loginState && !a.manual" class="login-hint">未检测到登录态：请运行对应 CLI 完成登录（delta 只探测不代登录）</p>
        <p v-if="a.kind === 'reserved'" class="login-hint">协议适配预留（Tier D）：可注册与探测，执行能力待后续版本。</p>
      </div>
      <div v-if="agents.length === 0 && !loading" class="empty-wrap">
        <p class="empty">未探测到外部 Agent——可点「＋ 添加」手动注册。</p>
        <p class="empty-sub">
          如已安装但未探测到，可设置显式路径环境变量：
          <code class="mono">{{ envPathName('cli:claude-code') }}</code> /
          <code class="mono">{{ envPathName('cli:codex') }}</code>
        </p>
      </div>
    </div>

    <!-- F-56 两步注册向导：第 1 步模板网格，第 2 步配置表单（交互模式对齐 Multica 自定义运行时向导） -->
    <ModalShell v-if="wizardOpen" :title="wizardStep === 1 ? '添加外部 Agent · 选择基础运行时' : '添加外部 Agent · 配置运行时'" :width="560" @close="wizardOpen = false">
      <div v-if="wizardStep === 1" class="tpl-grid-wrap">
        <p v-if="templatesLoading" class="empty">模板加载中…</p>
        <p v-else-if="templates.length === 0" class="empty">模板加载失败——请重试</p>
        <div v-else class="tpl-grid">
          <button v-for="t in templates" :key="t.id" class="tpl-card" @click="pickTemplate(t)">
            <span class="tpl-label">{{ t.label }}</span>
            <code class="mono tpl-exec">{{ t.executable }}</code>
            <span class="tag tier">Tier {{ t.tier }}</span>
            <span class="tpl-desc">{{ t.description }}</span>
          </button>
        </div>
      </div>
      <div v-else-if="picked" class="form">
        <div class="field">
          <label>基础运行时</label>
          <div class="base-readonly"><span class="tpl-label">{{ picked.label }}</span><code class="mono">{{ picked.id }}</code><span class="tag tier">Tier {{ picked.tier }}</span></div>
        </div>
        <div class="field">
          <label for="ext-name">显示名称</label>
          <input id="ext-name" v-model="formName" type="text" placeholder="模板名" maxlength="100" />
        </div>
        <div class="field">
          <label for="ext-cmd">命令</label>
          <input id="ext-cmd" v-model="formCommand" type="text" class="mono" placeholder="可执行命令（绝对路径或 PATH 裸名）" />
          <p class="field-hint">注册后即写入 external.json，下次探测以此命令为准。</p>
        </div>
        <div class="field">
          <label for="ext-model">模型（可选）</label>
          <!-- 自定义组合框：候选 = 自动获取（CLI 列举命令解析）+ 模板静态清单合并，仍可自由输入 -->
          <ModelCombobox input-id="ext-model" v-model="formModel" :options="modelOptions" :loading="modelLoading" />
          <p class="field-hint">
            <template v-if="modelLoading">正在自动获取 {{ picked?.label }} 支持的模型…</template>
            <template v-else-if="modelSource === 'probed'">已自动获取 {{ modelOptions.length }} 个模型（来自 CLI 实时列举），也可直接输入任意 ID。</template>
            <template v-else-if="modelOptions.length > 0">常用模型 {{ modelOptions.length }} 个已入下拉（CLI 未提供列举命令，静态建议），也可直接输入任意 ID。</template>
            <template v-else>留空 = 用该 CLI 的默认模型。</template>
            claude/codebuddy 为 --model，opencode 为 -m（provider/model），codex 走 -c model=…。
          </p>
        </div>
        <div class="field">
          <label for="ext-desc">描述（可选）</label>
          <textarea id="ext-desc" v-model="formDesc" rows="2" maxlength="500" placeholder="这个 agent 用来做什么"></textarea>
        </div>
        <p v-if="formError" class="form-error">{{ formError }}</p>
        <div class="form-ops">
          <button class="btn" @click="wizardStep = 1">← 上一步</button>
          <button class="btn primary" :disabled="submitting || formName.trim() === '' || formCommand.trim() === ''" @click="submitRegister">
            {{ submitting ? '注册中…' : '注册外部 Agent' }}
          </button>
        </div>
      </div>
    </ModalShell>

    <!-- F-56 增补：修改模型弹窗——手动与自动探测条目统一入口（dsh 预留档除外） -->
    <ModalShell v-if="editOpen && editAgent" title="修改模型" :width="480" @close="editOpen = false">
      <div class="form">
        <div class="field">
          <label>Agent</label>
          <div class="base-readonly">
            <span class="tpl-label">{{ displayLabel(editAgent) }}</span>
            <code class="mono">{{ editAgent.id }}</code>
            <span class="tag src">{{ sourceLabel(editAgent.source) }}</span>
          </div>
        </div>
        <div class="field">
          <label for="edit-model">模型（可选）</label>
          <!-- 自定义组合框：候选 = 自动获取 + 静态清单合并，等值项标「当前」，仍可自由输入 -->
          <ModelCombobox input-id="edit-model" v-model="editModel" :options="editOptions" :loading="editLoading" />
          <p class="field-hint">
            <template v-if="editLoading">正在自动获取支持的模型…</template>
            <template v-else-if="editSource === 'probed'">已自动获取 {{ editOptions.length }} 个模型（来自 CLI 实时列举），也可直接输入任意 ID。</template>
            <template v-else-if="editOptions.length > 0">常用模型 {{ editOptions.length }} 个已入下拉（静态建议），也可直接输入任意 ID。</template>
            <template v-else>留空 = 恢复该 CLI 的默认模型。</template>
            当前：{{ editAgent.model || '未指定（CLI 默认模型）' }}。修改后下次探测/新会话生效。
          </p>
        </div>
        <p v-if="editError" class="form-error">{{ editError }}</p>
        <div class="form-ops">
          <button class="btn" @click="editOpen = false">取消</button>
          <button class="btn primary" :disabled="editSaving" @click="submitEditModel">
            {{ editSaving ? '保存中…' : '保存' }}
          </button>
        </div>
      </div>
    </ModalShell>

    <!-- 能力降级固定说明（设计稿 §5.2/§10）：显式声明，不弹错误 -->
    <p class="foot-note">
      ⚠ 外部会话不使用 delta 沙箱；内置 Function 不可注入；无上下文压缩与记忆蒸馏；订阅内调用不计费（<code>usage.billing=subscription</code>）。
    </p>
    <p v-if="agents.length > 0" class="probe-meta">探测时间：{{ probedAt }}</p>
  </section>
</template>

<style scoped>
.panel { display: flex; flex-direction: column; gap: 12px; }
.panel-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.panel-title { font-size: 15px; font-weight: 600; }
.panel-sub { font-size: 12px; color: var(--text-dim); margin-top: 4px; line-height: 1.6; }
.panel-sub code { font-family: var(--mono); color: var(--accent); }
.head-ops { display: flex; gap: 8px; flex-shrink: 0; }

.rows { display: flex; flex-direction: column; gap: 10px; }
.row {
  border: 1px solid var(--border); border-radius: 10px;
  background: var(--bg-elevated); padding: 12px 14px;
  display: flex; flex-direction: column; gap: 8px;
}
.row:hover { border-color: var(--border-strong); }
.row-main { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.agent-id { font-size: 12.5px; color: var(--accent); }
.agent-cmd { font-size: 11.5px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 320px; }
.agent-ver { font-size: 12px; color: var(--text); }
.tag { font-size: 9.5px; font-family: var(--mono); padding: 1px 6px; border-radius: 4px; }
.tag.tier { background: var(--accent-soft); color: var(--accent); }
.tag.model { background: var(--bg-hover); color: var(--accent); }
.tag.src { background: var(--bg-hover); color: var(--text-dim); }

.row-caps { display: flex; gap: 14px; flex-wrap: wrap; }
.cap { font-size: 12px; color: var(--text-dim); }
.cap.ok { color: var(--green); }
.cap.miss { color: var(--orange); }

.login-hint { font-size: 11.5px; color: var(--orange); line-height: 1.6; }

.empty-wrap { text-align: center; padding: 24px 0; }
.empty { color: var(--text-faint); font-size: 12.5px; }
.empty-sub { color: var(--text-faint); font-size: 11.5px; margin-top: 6px; line-height: 1.7; }
.empty-sub code { font-family: var(--mono); color: var(--text-dim); }

.foot-note { font-size: 11.5px; color: var(--text-dim); line-height: 1.7; border-top: 1px dashed var(--border); padding-top: 10px; }
.foot-note code { font-family: var(--mono); color: var(--text-dim); }
.probe-meta { font-size: 10.5px; color: var(--text-faint); }
.mono { font-family: var(--mono); }

/* ── F-56 两步向导 ── */
.tpl-grid-wrap { min-height: 200px; }
.tpl-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.tpl-card {
  display: flex; flex-direction: column; align-items: flex-start; gap: 4px;
  border: 1px solid var(--border); border-radius: 10px; background: var(--bg);
  padding: 12px 14px; cursor: pointer; text-align: left; color: var(--text);
}
.tpl-card:hover { border-color: var(--accent); }
.tpl-label { font-size: 13px; font-weight: 600; }
.tpl-exec { font-size: 11px; color: var(--text-dim); }
.tpl-desc { font-size: 11px; color: var(--text-faint); line-height: 1.5; }
.tag { font-size: 9.5px; font-family: var(--mono); padding: 1px 6px; border-radius: 4px; }
.tag.tier { background: var(--accent-soft); color: var(--accent); }
.row-desc { font-size: 11.5px; color: var(--text-dim); margin: 0; }
.btn.danger { color: var(--orange); }
.form { display: flex; flex-direction: column; gap: 12px; }
.field { display: flex; flex-direction: column; gap: 5px; }
.field label { font-size: 12px; color: var(--text-dim); }
.field input, .field textarea {
  border: 1px solid var(--border); border-radius: 8px; background: var(--bg);
  color: var(--text); padding: 7px 10px; font-size: 12.5px; resize: vertical;
}
.field input.mono { font-family: var(--mono); }
.field-hint { font-size: 11px; color: var(--text-faint); margin: 0; }
.base-readonly {
  display: flex; align-items: center; gap: 8px;
  border: 1px solid var(--border); border-radius: 8px; background: var(--bg);
  padding: 8px 10px; font-size: 12.5px;
}
.base-readonly code { font-size: 11px; color: var(--text-dim); font-family: var(--mono); }
.form-error { font-size: 12px; color: var(--orange); margin: 0; }
.form-ops { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
.btn.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
</style>
