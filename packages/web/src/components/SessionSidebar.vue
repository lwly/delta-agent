<script setup lang="ts">
import { useSessionSidebar } from '../composables/useSessionSidebar';
import ModalShell from './ModalShell.vue';
import SearchModal from './SearchModal.vue';

const {
  ws,
  chat,
  expanded,
  newRoot,
  error,
  addError,
  showNewProject,
  showRemove,
  removeTarget,
  removeConfirmName,
  showSearch,
  sidebarScrollEl,
  todayLabel,
  todayPct,
  platform,
  canPickDirectory,
  projectMenuFor,
  renamingProjectId,
  renameProjectText,
  removeNeedsName,
  removeReady,
  openTrash,
  avatarTone,
  modeCls,
  modeShort,
  relTime,
  selectProject,
  addProject,
  browseProjectRoot,
  newSession,
  openSession,
  isSessionRunning,
  pauseSession,
  toggleProjectMenu,
  revealProject,
  copyProjectPath,
  startRenameProject,
  saveRenameProject,
  askRemoveProject,
  askRemoveSession,
  doRemove,
  onSidebarScroll,
} = useSessionSidebar();
</script>

<template>
  <div v-if="projectMenuFor" class="menu-overlay" @click="projectMenuFor = ''" />
  <aside class="sidebar">
    <div class="brand">
      <span class="brand-dot" title="本地工作区" />
      <span class="brand-text">
        <span class="brand-name">Delta-Agent</span>
      </span>
      <svg class="brand-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m8 9 4-4 4 4" /><path d="m8 15 4 4 4-4" /></svg>
    </div>

    <div class="side-section">
      <div class="sidebar-actions">
        <button class="btn-sm" @click="showNewProject = true">＋ 新项目</button>
        <button class="btn-sm primary" :disabled="!ws.activeProjectId" @click="newSession()">＋ 新对话</button>
      </div>
      <div class="sidebar-search">
        <input placeholder="🔍 检索会话与消息…" readonly @click="showSearch = true" />
      </div>
    </div>

    <div ref="sidebarScrollEl" class="sidebar-scroll" @scroll.passive="onSidebarScroll">
      <div class="section-title">会话</div>
      <p v-if="error" class="error">✘ {{ error }}</p>
      <div v-for="p in ws.projects" :key="p.id" class="project-group">
        <div
          class="project-header"
          :class="{ active: p.id === ws.activeProjectId && !chat.sessionId }"
          tabindex="0"
          @click="selectProject(p.id)"
        >
          <span class="project-caret" :class="{ open: expanded.has(p.id) }">▶</span>
          <span
            class="project-dot"
            :class="{ running: ws.runningProjectIds.includes(p.id) }"
            :title="ws.runningProjectIds.includes(p.id) ? '项目下有会话运行中' : undefined"
          />
          <input
            v-if="renamingProjectId === p.id"
            v-model="renameProjectText"
            class="rename-input"
            autofocus
            @click.stop
            @keydown.enter.prevent="saveRenameProject(p)"
            @keydown.escape.prevent="renamingProjectId = ''"
            @blur="saveRenameProject(p)"
          />
          <span v-else class="project-name" :title="p.root_path">{{ p.name }}</span>
          <span class="project-count">{{ p.session_count }}</span>
          <button class="item-del" title="更多操作" @click.stop="toggleProjectMenu(p.id)">⋯</button>
          <div v-if="projectMenuFor === p.id" class="project-menu" @click.stop>
            <button class="menu-item" @click="revealProject(p)"><span class="mi">📂</span>打开文件夹</button>
            <button class="menu-item" @click="copyProjectPath(p)"><span class="mi">📋</span>复制路径</button>
            <button class="menu-item" @click="startRenameProject(p)"><span class="mi">✏️</span>重命名</button>
            <button class="menu-item danger" @click="askRemoveProject(p)"><span class="mi">🗑</span>从列表中移除</button>
          </div>
        </div>
        <div v-if="expanded.has(p.id) && p.id === ws.activeProjectId" class="session-list">
          <div
            v-for="s in ws.sessions"
            :key="s.id"
            class="session-item"
            :class="{ active: s.id === chat.sessionId }"
            tabindex="0"
            @click="openSession(s.id)"
          >
            <span class="session-avatar" :class="`session-avatar--${avatarTone(s.id)}`">
              <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2.6 14.5 9l6.7.3-5.3 4.2 1.9 6.6L12 16.3 6.2 20.1l1.9-6.6L2.8 9.3 9.5 9z" /></svg>
            </span>
            <span class="session-main">
              <span class="session-top">
                <span class="session-title" :title="s.title">{{ s.title }}</span>
                <span class="session-time" :title="s.updated_at">{{ relTime(s.updated_at) }}</span>
              </span>
              <span class="session-sub">
                <span class="mode-tag" :class="modeCls(s.mode)">{{ modeShort(s.mode) }}</span>
              </span>
            </span>
            <span v-if="s.worktree_path" class="wt-badge" title="已绑定 worktree：会话重开自动还原">🌿</span>
            <span v-if="isSessionRunning(s.id)" class="mode-tag running" title="执行中">运行中</span>
            <span v-else-if="s.status === 'paused'" class="mode-tag paused" title="已暂停，打开会话发送消息即恢复">已暂停</span>
            <button
              v-if="isSessionRunning(s.id)"
              class="item-del"
              title="暂停执行（发送消息可恢复）"
              @click.stop="pauseSession(s.id)"
            >⏸</button>
            <button v-else class="item-del" title="删除会话（软删除）" @click.stop="askRemoveSession(s)">✕</button>
          </div>
          <div v-if="ws.sessions.length === 0" class="session-empty">（暂无会话，点「＋ 新对话」开始）</div>
          <div v-if="ws.sessionsHasMore || ws.loadingMoreSessions" class="session-empty">
            {{ ws.loadingMoreSessions ? '加载中…' : '↓ 滚动加载更早会话' }}
          </div>
        </div>
      </div>
      <p v-if="ws.projects.length === 0" class="session-empty" style="padding: 10px 8px">
        还没有项目，点「＋ 新项目」注册本地仓库根目录。
      </p>
    </div>

    <div class="side-section bottom-group">
      <div class="sidebar-footer">
        <div class="footer-row" :title="`今日 token ${todayLabel} / 200k（展示口径）`">
          <span class="footer-label">Token（今日）</span>
          <span class="footer-val">{{ todayLabel }} / 2M</span>
        </div>
        <div class="budget-bar">
          <span class="budget-fill" :class="{ warn: todayPct >= 80 }" :style="{ width: `${Math.max(2, todayPct)}%` }" />
        </div>
        <div class="footer-secondary">
          <span class="footer-val link" tabindex="0" title="回收站" @click="openTrash()">🗑 回收站 · {{ ws.trash.length }} 项</span>
          <span class="footer-sep">·</span>
          <span :title="'平台信息：' + platform">{{ platform }}</span>
        </div>
      </div>
    </div>
  </aside>

  <ModalShell v-if="showNewProject" title="注册项目" icon="📁" @close="showNewProject = false">
    <p v-if="canPickDirectory" class="modal-tip">
      点击<b>选择文件夹…</b>挑选项目根目录，Agent 会在该目录内读写代码。
    </p>
    <p v-else class="modal-tip">
      输入项目根目录的<b>绝对路径</b>，Agent 会在该目录内读写代码。<br />
      <span class="modal-tip-sub">提示：桌面版可直接选择文件夹；浏览器形态受安全模型限制只能手输。</span>
    </p>
    <div class="path-row">
      <input
        v-model="newRoot"
        class="full"
        :readonly="canPickDirectory"
        :placeholder="canPickDirectory ? '尚未选择目录' : '/path/to/your/project'"
        :title="canPickDirectory ? '桌面版请用「选择文件夹…」' : ''"
        @keyup.enter="addProject()"
      />
      <button v-if="canPickDirectory" class="btn primary" @click="browseProjectRoot()">选择文件夹…</button>
    </div>
    <p v-if="addError" class="error">✘ {{ addError }}</p>
    <div class="modal-btns">
      <button class="btn" @click="showNewProject = false">取消</button>
      <button class="btn primary" :disabled="!newRoot.trim()" @click="addProject()">注册</button>
    </div>
  </ModalShell>

  <ModalShell v-if="showRemove" title="确认移除" icon="⚠" @close="showRemove = false">
    <template v-if="removeTarget">
      <p class="modal-tip">
        移除<template v-if="removeTarget.kind === 'project'">项目将<b>级联删除其下会话</b></template><template v-else>该会话</template>（软删除，进回收站 30 天）。
        <template v-if="removeNeedsName">请输入项目名 <b>{{ removeTarget.name }}</b> 确认。</template>
      </p>
      <input v-if="removeNeedsName" v-model="removeConfirmName" class="full" :placeholder="removeTarget.name" />
      <div class="modal-btns">
        <button class="btn" @click="showRemove = false">取消</button>
        <button class="btn danger-btn" :disabled="!removeReady" @click="doRemove()">移除（软删除）</button>
      </div>
    </template>
  </ModalShell>

  <SearchModal v-if="showSearch" @close="showSearch = false" @open-session="(id) => openSession(id)" />
</template>

<style scoped>
.menu-overlay { position: fixed; inset: 0; z-index: 40; }
.sidebar {
  width: 260px; min-width: 260px; height: 100%;
  background: var(--bg-panel); border-right: 1px solid var(--border);
  display: flex; flex-direction: column;
}
.brand { display: flex; align-items: center; gap: 10px; padding: 4px 12px; min-height: 40px; }
.brand-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); flex-shrink: 0; }
.brand-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.brand-name { font-weight: 600; font-size: 13px; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.brand-caret { width: 14px; height: 14px; color: var(--text-faint); flex-shrink: 0; }
.side-section { padding: 12px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 8px; }
.side-section.bottom-group { border-bottom: none; border-top: 1px solid var(--border); }
.sidebar-actions { display: flex; gap: 8px; }
.btn-sm {
  flex: 1; padding: 7px 0; border-radius: 7px;
  border: 1px solid var(--border); background: var(--bg-elevated);
  color: var(--text); font-size: 12.5px; cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.btn-sm:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--border-strong); }
.btn-sm:active:not(:disabled) { background: var(--bg-active); }
.btn-sm.primary { background: var(--accent); border-color: transparent; color: #fff; font-weight: 600; }
.btn-sm.primary:hover:not(:disabled) { background: var(--accent-strong); }
.btn-sm.primary:active:not(:disabled) { background: var(--accent-press); }
.btn-sm:disabled { opacity: 0.4; cursor: not-allowed; }
.sidebar-search { padding: 0; }
.sidebar-search input {
  width: 100%; height: 32px; padding: 0 10px; font-size: 12px; cursor: pointer;
  color: var(--text-dim); background: var(--bg-elevated);
  border: none; border-radius: var(--radius-md);
}
.sidebar-scroll { flex: 1; overflow-y: auto; padding: 12px 8px; }
.section-title {
  font-size: 10px; font-weight: 600; color: var(--text-faint);
  letter-spacing: 0.14em; text-transform: uppercase;
  padding: 0 8px 8px;
}
.project-group { margin-top: 8px; }
.project-header {
  position: relative;
  display: flex; align-items: center; gap: 8px;
  padding: 7px 8px; border-radius: 7px; cursor: pointer; transition: background 0.15s;
}
.project-header:hover { background: var(--bg-hover); }
.project-header:active { background: var(--bg-active); }
.project-header.active { background: var(--bg-active); box-shadow: inset 2px 0 0 var(--accent); }
.project-caret { font-size: 10px; color: var(--text-faint); transition: transform 0.15s; width: 10px; }
.project-caret.open { transform: rotate(90deg); }
.project-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); flex-shrink: 0; }
.project-dot.running { animation: dot-breathe 1.6s ease-in-out infinite; }
@keyframes dot-breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
.project-name { font-weight: 600; font-size: 13px; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.project-count {
  font-size: 11px; color: var(--text-dim); background: var(--bg-elevated);
  border: 1px solid var(--border); padding: 1px 7px; border-radius: 8px;
}
.rename-input {
  flex: 1; min-width: 0; font-size: 13px; font-weight: 600;
  background: var(--bg-elevated); color: var(--text);
  border: 1px solid var(--accent); border-radius: 5px; padding: 2px 6px; outline: none;
}
.project-menu {
  position: absolute; top: calc(100% + 4px); right: 6px; z-index: 41;
  min-width: 168px; padding: 5px;
  background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--radius-md);
  box-shadow: var(--shadow-pop);
  display: flex; flex-direction: column;
}
.project-menu .menu-item {
  display: flex; align-items: center; gap: 8px;
  border: none; background: transparent; color: var(--text-dim);
  font-size: 12.5px; text-align: left; padding: 7px 9px; border-radius: 6px; cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.project-menu .menu-item:hover { background: var(--bg-hover); color: var(--text); }
.project-menu .menu-item .mi { width: 16px; text-align: center; flex: none; }
.project-menu .menu-item.danger:hover { background: var(--red-soft); color: var(--red); }
.session-list { margin: 2px 0 4px 10px; border-left: 1px solid var(--border); padding-left: 6px; }
.session-item {
  position: relative;
  display: flex; align-items: center; gap: 10px;
  height: 52px; padding: 6px 10px; border-radius: var(--radius-md); cursor: pointer;
  color: var(--text-dim); font-size: 12.5px;
  transition: background 0.12s ease-out, color 0.12s ease-out; margin: 1px 0;
}
.session-item:hover { background: var(--bg-hover); color: var(--text); }
.session-item.active { background: var(--bg-active); color: var(--text); box-shadow: inset 2px 0 0 var(--accent); }
.session-avatar {
  width: 28px; height: 28px; border-radius: var(--radius-md); flex-shrink: 0;
  display: flex; align-items: center; justify-content: center; color: #fff;
}
.session-avatar svg { width: 14px; height: 14px; }
.session-avatar--blue { background: var(--avatar-blue); }
.session-avatar--red { background: var(--avatar-red); }
.session-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.session-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
.session-title { flex: 1; min-width: 0; font-size: 13px; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.session-time { font-size: 11px; color: var(--text-faint); white-space: nowrap; flex: none; }
.session-empty { color: var(--text-faint); font-size: 11.5px; padding: 4px 8px; }
.item-del {
  opacity: 0; width: 20px; height: 20px; border-radius: 5px; flex-shrink: 0;
  border: none; background: transparent; color: var(--text-faint);
  cursor: pointer; font-size: 11px;
  display: flex; align-items: center; justify-content: center; transition: all 0.15s;
}
.session-item:hover .item-del, .project-header:hover .item-del { opacity: 1; }
.item-del:hover { background: var(--red-soft); color: var(--red); }
.mode-tag {
  flex: none; font-size: 10.5px; line-height: 1; padding: 3px 6px;
  border-radius: 4px; background: var(--bg-elevated); color: var(--text-faint);
}
.mode-tag.running {
  color: var(--green); background: var(--green-soft); font-weight: 600;
  display: inline-flex; align-items: center; gap: 4px;
  animation: tag-breathe 2.4s ease-in-out infinite;
}
.mode-tag.running::before {
  content: ''; width: 6px; height: 6px; border-radius: 50%;
  background: var(--green); animation: dot-breathe 1.2s ease-in-out infinite;
}
@keyframes tag-breathe { 0%, 100% { background: var(--green-soft); } 50% { background: var(--bg-hover); } }
.mode-tag.paused { color: var(--orange); background: var(--orange-soft); }
.wt-badge { flex: none; font-size: 11px; line-height: 1; }
.sidebar-footer { display: flex; flex-direction: column; gap: 8px; padding: 0; font-size: 11.5px; color: var(--text-faint); }
.footer-row { display: flex; justify-content: space-between; align-items: center; }
.footer-label { color: var(--text-dim); }
.footer-val { font-family: var(--mono); color: var(--text-dim); }
.footer-val.link { cursor: pointer; transition: color 0.12s; font-family: inherit; }
.footer-val.link:hover { color: var(--text); }
.budget-bar { width: 100%; height: 4px; background: var(--bg-hover); border-radius: 2px; overflow: hidden; }
.budget-fill { display: block; height: 100%; background: var(--accent); border-radius: 2px; transition: width 0.4s; }
.budget-fill.warn { background: var(--orange); }
.footer-secondary { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-faint); flex-wrap: wrap; }
.footer-secondary .footer-sep { opacity: 0.5; }
.error { color: var(--red); font-size: 12.5px; margin-bottom: 8px; }
.modal-tip { font-size: 13px; color: var(--text-dim); line-height: 1.7; margin-bottom: 12px; }
.modal-tip b { color: var(--text); }
.modal-tip-sub { font-size: 12px; color: var(--text-faint); }
.full { width: 100%; margin-bottom: 12px; }
.path-row { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
.path-row .full, .path-row .btn { margin-bottom: 0; }
.path-row input[readonly] { color: var(--text-dim); background: var(--bg-elevated); cursor: default; }
.modal-btns { display: flex; gap: 10px; justify-content: flex-end; }
@media (max-width: 1023px) {
  .sidebar {
    position: fixed; left: 48px; top: 0; bottom: 0; z-index: 50;
    transform: translateX(-110%);
    transition: transform 0.15s ease-out;
  }
}
@media (max-width: 767px) {
  .sidebar { left: 0; }
}
</style>
