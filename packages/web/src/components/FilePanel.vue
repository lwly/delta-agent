<script setup lang="ts">
// F-38 右侧面板容器（PRD F-38-1/2/3，design D11/D12/T04）
// 职责：容器宽度与拖拽、标签条（固定两标签 + 动态预览标签 + 关闭）、内容路由、空态动作区。
// 业务状态全部来自 stores/filePanel；本组件只持「拖拽中 / 局部菜单开合」这类瞬时 UI 状态。
import { computed, onUnmounted, ref } from 'vue';
import { useFilePanelStore, NO_SCOPE_HINT, type PanelTab } from '../stores/filePanel';
import { useChatStore } from '../stores/chat';
import { PANEL_DEFAULT_WIDTH } from '../utils/panelSize';
import FileTree from './FileTree.vue';
import FilePreview from './FilePreview.vue';
import ChangesPanel from './ChangesPanel.vue';

const panel = useFilePanelStore();
// F-47：空态动作「打开终端」上抛（开关逻辑在工作台——面板保持纯展示）
const emit = defineEmits<{ (e: 'open-terminal'): void }>();
const chat = useChatStore();

/** 标签条高度 / 面板宽度均为布局规格（PRD §5.6）：36px 标签条、320~720 宽度 */
const resizing = ref(false);
let stopResize: (() => void) | null = null;

/** 拖拽左边缘调宽（面板贴右，左移即变宽） */
function startResize(ev: PointerEvent): void {
  ev.preventDefault();
  const startX = ev.clientX;
  const startWidth = panel.width;
  resizing.value = true;
  document.body.style.userSelect = 'none';
  const onMove = (e: PointerEvent): void => panel.setWidth(startWidth + (startX - e.clientX));
  const onUp = (): void => {
    resizing.value = false;
    document.body.style.userSelect = '';
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    stopResize = null;
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  stopResize = onUp;
}

/** 双击分隔条复位默认宽度（PRD F-38-1） */
function resetWidth(): void {
  panel.setWidth(PANEL_DEFAULT_WIDTH);
}

onUnmounted(() => {
  stopResize?.();
  document.body.style.userSelect = '';
});

/** 动态标签显示文件名（去目录、过长省略，title 给完整路径） */
function baseName(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx < 0 ? p : p.slice(idx + 1);
}

function isFileTab(tab: PanelTab): tab is Extract<PanelTab, { kind: 'file' }> {
  return tab.kind === 'file';
}

/** 标签文案：文件标签显示文件名，固定标签显示「文件」/「变更」 */
function tabLabel(tab: PanelTab): string {
  if (tab.kind === 'file') return baseName(tab.path);
  return tab.kind === 'files' ? '文件' : '变更';
}

/** 标签文案的完整含义（title）：文件给完整路径，固定标签给操作说明 */
function tabTitle(tab: PanelTab): string {
  return tab.kind === 'file' ? tab.path : tabLabel(tab);
}

/** 点标签：固定标签走 openTab（变更需补一次数据；被关掉过会插回），文件标签走 activateTab */
function onTabClick(tab: PanelTab): void {
  if (tab.kind === 'file') panel.activateTab(tab.id);
  else panel.openTab(tab.kind);
}

/** 空态提示：无作用域 → 先选项目；有作用域 → 引导选入口（PRD F-38-3） */
const emptyHint = computed(() => (panel.scope ? '选择一个入口开始浏览' : NO_SCOPE_HINT));

/** 空态动作：打开浏览器（工作根）/ 查看工作空间 / 查看变更（「打开终端」按 Q2 不渲染） */
function revealRoot(): void {
  void panel.reveal('');
}
</script>

<template>
  <aside class="file-panel" :class="{ overlay: panel.narrow, resizing }" :style="{ width: `${panel.width}px` }">
    <!-- 左边缘拖拽手柄（双击复位） -->
    <div class="fp-resize" title="拖动调整面板宽度（双击复位为 420px）" @pointerdown="startResize" @dblclick="resetWidth" />

    <!-- 标签条 36px（PRD F-38-2）：单行横向滚动 = 文件 | 变更 | 动态文件标签… | 恢复「＋」 | 工作根名（sticky 右侧）。
         三类标签统一渲染，**都带 ×**（固定标签也可关闭；关光后回到空态动作区） -->
    <div class="fp-tabs" role="tablist" aria-label="文件面板标签">
      <div v-for="tab in panel.tabs" :key="tab.id" class="fp-dyn">
        <button
          class="fp-tab"
          :class="{ active: panel.activeTabId === tab.id, dyn: isFileTab(tab) }"
          type="button"
          role="tab"
          :aria-selected="panel.activeTabId === tab.id"
          :title="tabTitle(tab)"
          @click="onTabClick(tab)"
        >
          <span class="fp-tab-name">{{ tabLabel(tab) }}</span>
        </button>
        <button
          class="fp-tab-close"
          type="button"
          :title="`关闭「${tabLabel(tab)}」`"
          @click.stop="panel.closeTab(tab.id)"
        >×</button>
      </div>

      <!-- 恢复被 × 关掉的固定标签（两个都在时不渲染，避免无功能占位） -->
      <button
        v-if="panel.missingFixedTabs"
        class="fp-tab-restore"
        type="button"
        title="重新打开「文件」/「变更」标签"
        @click="panel.restoreFixedTabs()"
      >＋</button>

      <!-- 工作根名：sticky 贴右，横向滚动时不压住标签（点击 = 在文件管理器中打开） -->
      <button
        v-if="panel.rootName"
        class="fp-root"
        type="button"
        :title="`工作根：${panel.rootName}（点击在文件管理器中打开）`"
        @click="revealRoot"
      >📁 {{ panel.rootName }}</button>
    </div>

    <!-- 内容区 -->
    <div class="fp-body">
      <!-- 空态动作区（PRD F-38-3）：无激活标签时显示 —— 首次打开面板即此态 -->
      <div v-if="!panel.activeTabId" class="fp-empty">
        <p class="fp-empty-hint">{{ emptyHint }}</p>
        <!-- 打开浏览器必须有工作根 → 无作用域时禁用；另两个动作永远可点，进入后由子组件自身空态接管 -->
        <button
          class="fp-action"
          type="button"
          :disabled="!panel.scope"
          :title="panel.scope ? '在系统文件管理器中打开工作根' : NO_SCOPE_HINT"
          @click="revealRoot"
        >
          <span class="fp-action-ico">📂</span>打开浏览器
        </button>
        <button class="fp-action" type="button" @click="panel.openTab('files')">
          <span class="fp-action-ico">🗂</span>查看工作空间
        </button>
        <!-- F-47：打开终端改为内嵌面板（工作台底部），替代方案（系统文件管理器）保留 -->
        <button
          class="fp-action"
          type="button"
          :disabled="!chat.sessionId"
          :title="chat.sessionId ? '打开内置终端（绑定当前会话工作根）' : '先打开会话'"
          @click="emit('open-terminal')"
        >
          <span class="fp-action-ico">🖥</span>打开终端
        </button>
        <button class="fp-action" type="button" @click="panel.openTab('changes')">
          <span class="fp-action-ico">±</span>查看变更
        </button>
        <p v-if="panel.revealError" class="fp-inline-error">✘ {{ panel.revealError }}</p>
      </div>

      <FileTree v-else-if="panel.activeTabId === 'files'" />
      <ChangesPanel v-else-if="panel.activeTabId === 'changes'" />
      <FilePreview v-else-if="panel.activeFilePath" :key="panel.activeFilePath" :path="panel.activeFilePath" />
      <div v-else class="fp-empty"><p class="fp-empty-hint">请选择左侧的一个文件</p></div>
    </div>
  </aside>
</template>

<style scoped>
/* 类型图标色板（PRD §5.7：七类，刻意避开 --green/--red）。
   以局部 CSS 变量写在容器上：子组件通过继承拿到同一套色板，不改 theme.css 全局令牌。 */
.file-panel {
  --file-icon-doc: #6aa9ff;
  --file-icon-chart: var(--purple);
  --file-icon-code: #56b6c2;
  --file-icon-component: #e5c07b;
  --file-icon-config: #d19a66;
  --file-icon-asset: #a89984;
  --file-icon-other: var(--text-dim);

  position: relative;
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  min-width: 0;
  height: 100%;
  background: var(--bg-panel);
  border-left: 1px solid var(--border);
}
/* 窄屏（<1200px）：覆盖式浮层，不挤压主区（D11 取「默认收起 + 覆盖式」，成本低于遮罩方案） */
.file-panel.overlay {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 60;
  box-shadow: -12px 0 32px rgba(0, 0, 0, 0.45);
}
.file-panel.resizing { user-select: none; }

/* 左边缘拖拽手柄：6px 命中区 + hover 强调色 */
.fp-resize {
  position: absolute;
  top: 0;
  left: -3px;
  width: 6px;
  height: 100%;
  cursor: col-resize;
  z-index: 2;
}
.fp-resize:hover { background: var(--accent-soft); }

/* 标签条 36px 单行（PRD §5.6 / F-38-2）：横向滚动装下全部标签，纵向不滚 */
.fp-tabs {
  display: flex;
  align-items: stretch;
  gap: 2px;
  height: 36px;
  min-height: 36px;
  padding: 0 6px;
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}
.fp-tabs::-webkit-scrollbar { height: 0; }

/* 工作根名：sticky 贴右，滚动时以面板底色遮盖下方标签，不产生第二行 */
.fp-root {
  position: sticky;
  right: 0;
  margin-left: auto;
  align-self: center;
  flex: 0 0 auto;
  max-width: 40%;
  padding: 2px 6px 2px 8px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: var(--bg-panel);
  font-family: inherit;
  font-size: 10.5px;
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.fp-root:hover { background: var(--bg-hover); color: var(--text); }
.fp-tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  height: 28px;
  align-self: center;
  max-width: 160px;
  padding: 0 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-dim);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
  white-space: nowrap;
  overflow: hidden;
}
.fp-tab:hover { background: var(--bg-hover); color: var(--text); }
.fp-tab.active { background: var(--bg-elevated); color: var(--text); }
/* 激活标签底部 2px 强调色下划线 */
.fp-tab.active::after {
  content: '';
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: -5px;
  height: 2px;
  background: var(--accent);
  border-radius: 1px;
}
.fp-tab-name { overflow: hidden; text-overflow: ellipsis; }

/* 动态标签组（与固定标签同一条带内）：× 紧贴标签右侧 */
.fp-dyn { display: inline-flex; align-items: center; gap: 0; flex: 0 0 auto; }
.fp-tab.dyn { max-width: 160px; }
.fp-tab-close {
  border: none;
  background: transparent;
  color: var(--text-faint);
  font-size: 13px;
  line-height: 1;
  padding: 2px 4px;
  border-radius: 4px;
  cursor: pointer;
}
.fp-tab-close:hover { background: var(--bg-hover); color: var(--text); }

/* 恢复固定标签「＋」：仅在「文件」/「变更」被关掉时出现，28px 与标签同高 */
.fp-tab-restore {
  flex: 0 0 auto;
  align-self: center;
  height: 28px;
  min-width: 24px;
  padding: 0 6px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-faint);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.fp-tab-restore:hover { background: var(--bg-hover); color: var(--text); }

.fp-body { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }

/* 空态动作区（PRD §5.6：整行 32px，图标 + 文案居中，hover --bg-hover） */
.fp-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 24px 16px;
}
.fp-empty-hint { font-size: 12px; color: var(--text-faint); margin-bottom: 6px; text-align: center; }
.fp-action {
  width: 100%;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--text-dim);
  font-size: 12.5px;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.fp-action:hover:not(:disabled) { background: var(--bg-hover); color: var(--text); }
.fp-action:disabled { opacity: 0.45; cursor: not-allowed; }
.fp-action-ico { font-size: 13px; }
.fp-inline-error { margin-top: 8px; font-size: 11.5px; color: var(--red); }
</style>
