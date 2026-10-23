<script setup lang="ts">
// F-37 Web 底栏三段式（对齐 TUI 语义，PRD §5.2）：
// 项目名 ｜ 当前分支（点击弹出下拉：本地分支列表 + 当前打勾 + 新建分支输入框）｜ Worktree checkbox
// 运行中全部置灰禁用；切换结果经 chat store notice（toast 语义）+ git_notice 行内反馈。
import { computed, ref, watch } from 'vue';
import { useChatStore } from '../stores/chat';
import type { BranchInfo } from '../api/client';

const chat = useChatStore();

// ── 分支下拉 ────────────────────────────────────────────────
const showBranchMenu = ref(false);
const branches = ref<BranchInfo[]>([]);
const branchesLoading = ref(false);
const switching = ref(false);
const newBranchName = ref('');
const menuWrap = ref<HTMLElement | null>(null);

const worktreeBusy = ref(false);

const gs = computed(() => chat.gitState);
const disabled = computed(() => chat.running || switching.value || worktreeBusy.value);
const canInteract = computed(() => !!gs.value?.isRepo && !disabled.value);
const wtEnabled = computed(() => gs.value?.worktree.enabled === true);

/** 打开分支下拉并拉取列表（非 repo / 运行中不发起）。 */
async function openBranchMenu() {
  if (!canInteract.value) return;
  showBranchMenu.value = !showBranchMenu.value;
  if (!showBranchMenu.value) return;
  branchesLoading.value = true;
  try {
    const list = await chat.listBranches();
    if (list) branches.value = list;
  } finally {
    branchesLoading.value = false;
  }
}

async function pickBranch(b: BranchInfo) {
  if (b.current || switching.value) return;
  switching.value = true;
  try {
    await chat.checkout({ branch: b.name });
    showBranchMenu.value = false;
  } finally {
    switching.value = false;
  }
}

/** 就地新建分支（checkout -b）。 */
async function createBranch() {
  const name = newBranchName.value.trim();
  if (!name || switching.value) return;
  switching.value = true;
  try {
    await chat.checkout({ newBranch: name });
    newBranchName.value = '';
    showBranchMenu.value = false;
  } finally {
    switching.value = false;
  }
}

/** Worktree checkbox：勾选切入（缺省从当前 HEAD）/ 取消切回。 */
async function onWorktreeToggle(ev: Event) {
  const enabled = (ev.target as HTMLInputElement).checked;
  worktreeBusy.value = true;
  try {
    await chat.toggleWorktree(enabled);
  } finally {
    worktreeBusy.value = false;
  }
}

// 会话切换 / running 状态变化时收起下拉
watch(() => [chat.sessionId, chat.running], () => {
  showBranchMenu.value = false;
});
</script>

<template>
  <div v-if="gs" class="git-bar">
    <!-- 左：项目名 -->
    <span class="seg project" :title="gs.projectName">📁 {{ gs.projectName }}</span>

    <!-- 中：当前分支（下拉） -->
    <div ref="menuWrap" class="seg branch-wrap">
      <button class="branch-btn" :disabled="!canInteract" :title="disabled && chat.running ? '任务运行中，结束后再切换' : '切换分支'" @click="openBranchMenu">
        ⎇ {{ branchesLoading ? '加载中…' : switching ? '切换中…' : gs.branch ?? '（非 git 仓库）' }}
        <span class="caret">▾</span>
      </button>
      <div v-if="showBranchMenu" class="branch-menu">
        <button
          v-for="b in branches"
          :key="b.name"
          class="branch-item"
          :class="{ current: b.current }"
          @click="pickBranch(b)"
        >
          <span class="tick">{{ b.current ? '✔' : '' }}</span>{{ b.name }}
        </button>
        <div v-if="branches.length === 0 && !branchesLoading" class="branch-empty">（无本地分支）</div>
        <div class="new-branch">
          <input
            v-model="newBranchName"
            placeholder="+ 新建分支（回车创建并切换）"
            :disabled="switching"
            @keydown.enter.prevent="createBranch"
          />
        </div>
      </div>
    </div>

    <!-- 右：Worktree 开关 -->
    <label class="seg wt" :title="wtEnabled ? `已切入：${gs.worktree.path ?? ''}（取消勾选切回主工作区，目录保留）` : '勾选后自动 git worktree add 独立目录并切换会话工作根'">
      <input
        type="checkbox"
        :checked="wtEnabled"
        :disabled="!gs.isRepo || disabled"
        @change="onWorktreeToggle"
      />
      Worktree{{ wtEnabled ? ' ●' : '' }}
    </label>
  </div>
</template>

<style scoped>
.git-bar {
  max-width: 860px;
  margin: 0 auto 10px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-panel);
  font-size: 12px;
  color: var(--text-dim);
}
.seg { display: flex; align-items: center; gap: 6px; min-width: 0; }
.seg.project { font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 30%; }
.branch-wrap { position: relative; flex: 1; display: flex; justify-content: center; }
.branch-btn {
  border: none; background: transparent; color: var(--accent);
  font-size: 12px; font-family: var(--mono); cursor: pointer;
  padding: 3px 8px; border-radius: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.branch-btn:hover:not(:disabled) { background: var(--bg-hover); }
.branch-btn:disabled { color: var(--text-faint); cursor: not-allowed; }
.caret { font-size: 9px; color: var(--text-faint); margin-left: 4px; }
.branch-menu {
  position: absolute; top: calc(100% + 6px); left: 50%; transform: translateX(-50%);
  z-index: 45; min-width: 260px; max-height: 280px; overflow-y: auto;
  background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 9px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4); padding: 5px;
}
.branch-item {
  display: flex; align-items: center; gap: 6px; width: 100%;
  border: none; background: transparent; color: var(--text-dim);
  font-size: 12px; font-family: var(--mono); text-align: left;
  padding: 6px 9px; border-radius: 6px; cursor: pointer; transition: background 0.12s;
}
.branch-item:hover { background: var(--bg-hover); color: var(--text); }
.branch-item.current { color: var(--accent); font-weight: 600; }
.branch-item .tick { width: 14px; flex: none; }
.branch-empty { padding: 8px 10px; color: var(--text-faint); font-size: 11.5px; }
.new-branch { border-top: 1px solid var(--border); margin-top: 4px; padding-top: 6px; }
.new-branch input {
  width: 100%; padding: 5px 9px; font-size: 12px;
  background: var(--bg); color: var(--text);
  border: 1px solid var(--border); border-radius: 6px; outline: none;
}
.new-branch input:focus { border-color: rgba(88, 166, 255, 0.5); }
.seg.wt { white-space: nowrap; cursor: pointer; }
.seg.wt input[type='checkbox'] { accent-color: var(--green); cursor: pointer; }
.seg.wt:has(input:disabled) { opacity: 0.5; cursor: not-allowed; }
</style>
