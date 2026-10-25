<script setup lang="ts">
// F-38 变更清单（PRD F-38-6/7，design D7/D8 + §5.3 时序）
// 上下分栏：汇总头（+N -M ⟳）+ 清单（≤50% 高、独立滚动、选中行 --bg-active）+ 详情区（FileDiffView）
// 只读：不提供暂存 / 提交 / 回滚任何入口；错误与业务态（非 git）都是内联卡片，不弹全局 toast。
import { computed } from 'vue';
import { useFilePanelStore, NO_SCOPE_HINT } from '../stores/filePanel';
import { classifyFile } from '../utils/fileIcon';
import FileDiffView from './FileDiffView.vue';

const panel = useFilePanelStore();

/** 变更行 skeleton 数 */
const SKELETON_ROWS = 5;

/** 非 git / git 超时等业务态（200 + reason），与请求失败（changesError）分开呈现 */
const businessReason = computed(() => (panel.changesError ? '' : panel.changesReason));
const showEmpty = computed(
  () => !panel.changesLoading && !panel.changesError && !businessReason.value && panel.changes.length === 0,
);

function iconOf(name: string): { label: string; color: string } {
  // 图标按文件名分类；空文件名（异常）由 classifyFile 回落 other
  return classifyFile(name);
}

function onPick(path: string): void {  void panel.selectChange(path);
}

function retry(): void {
  void panel.refreshChanges(true);
}
</script>

<template>
  <div class="changes">
    <!-- 汇总头：文件变更 + 绿加红减 + 刷新 -->
    <div class="ch-head">
      <span class="ch-title">文件变更</span>
      <span class="ch-total add" :title="`新增 ${panel.changeTotals.added} 行`">+{{ panel.changeTotals.added }}</span>
      <span class="ch-total del" :title="`删除 ${panel.changeTotals.removed} 行`">-{{ panel.changeTotals.removed }}</span>
      <span v-if="panel.changes.length" class="ch-count">{{ panel.changeTotalFiles }} 个文件</span>
      <button class="ch-refresh" type="button" title="刷新变更清单" :disabled="panel.changesLoading" @click="retry">⟳</button>
    </div>

    <!-- 清单区（最大 50% 高，独立滚动） -->
    <div class="ch-list">
      <div v-if="!panel.scope" class="ch-state">
        <p class="ch-state-text">{{ NO_SCOPE_HINT }}</p>
      </div>

      <div v-else-if="panel.changesLoading && panel.changes.length === 0" class="ch-skeleton">
        <div v-for="i in SKELETON_ROWS" :key="i" class="ch-skel-row"><span class="ch-skel-bar" /></div>
      </div>

      <div v-else-if="panel.changesError" class="ch-state error">
        <p class="ch-state-text">✘ {{ panel.changesError }}</p>
        <button class="ch-state-btn" type="button" @click="retry">加载失败，点击重试</button>
      </div>

      <div v-else-if="businessReason" class="ch-state">
        <p class="ch-state-text">{{ businessReason }}</p>
        <button class="ch-state-btn" type="button" @click="retry">重新检查</button>
      </div>

      <div v-else-if="showEmpty" class="ch-state">
        <p class="ch-state-text">工作区无未提交变更</p>
      </div>

      <template v-else>
        <button
          v-for="file in panel.changes"
          :key="file.path"
          class="ch-row"
          :class="{ active: panel.selectedChangePath === file.path }"
          type="button"
          :title="file.orig_path ? `${file.orig_path} → ${file.path}` : file.path"
          @click="onPick(file.path)"
        >
          <span class="ch-icon" :style="{ color: iconOf(file.path).color }">{{ iconOf(file.path).label }}</span>
          <span class="ch-path">{{ file.path }}</span>
          <span v-if="file.binary" class="ch-bin">二进制</span>
          <template v-else>
            <span class="ch-num add">+{{ file.added }}</span>
            <span class="ch-num del">-{{ file.removed }}</span>
          </template>
        </button>

        <!-- 截断提示（PRD §6）：上限由 core 的 MAX_CHANGE_FILES 决定，
             这里用「实际下发的条数 + 服务端 total_files」表达，不硬编码 300，避免常量漂移 -->
        <p v-if="panel.changesTruncated" class="ch-truncated">
          已截断，仅显示前 {{ panel.changes.length }} 个（共 {{ panel.changeTotalFiles }} 个文件）
        </p>
      </template>
    </div>

    <!-- 详情区 -->
    <div class="ch-detail">
      <FileDiffView v-if="panel.selectedChangePath" :path="panel.selectedChangePath" @clear="panel.clearChangeSelection()" />
      <div v-else class="ch-detail-empty">请选择一个产物查看详情</div>
    </div>
  </div>
</template>

<style scoped>
.changes { flex: 1; min-height: 0; display: flex; flex-direction: column; }

/* 汇总头 */
.ch-head {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  min-height: 32px;
  padding: 0 10px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
}
.ch-title { color: var(--text); font-weight: 600; }
.ch-total { font-family: var(--mono); font-size: 12px; }
.ch-count { color: var(--text-faint); font-size: 11px; }
.ch-refresh {
  margin-left: auto;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  color: var(--text-dim);
  font-size: 12px;
  padding: 1px 7px;
  border-radius: 6px;
  cursor: pointer;
}
.ch-refresh:hover:not(:disabled) { background: var(--bg-hover); color: var(--text); }
.ch-refresh:disabled { opacity: 0.45; cursor: not-allowed; }

/* 绿加红减：--green / --red 只表达增删语义 */
.add { color: var(--green); }
.del { color: var(--red); }

/* 清单：最大 50% 高、独立滚动（PRD F-38-7） */
.ch-list {
  max-height: 50%;
  min-height: 96px;
  overflow-y: auto;
  border-bottom: 1px solid var(--border);
  flex: 0 0 auto;
}
.ch-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 24px;
  min-height: 24px;
  padding: 0 10px;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: background 0.1s;
}
.ch-row:hover { background: var(--bg-hover); }
.ch-row.active { background: var(--bg-active); }
.ch-icon {
  width: 14px;
  height: 14px;
  min-width: 14px;
  border-radius: 3px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: var(--mono);
  font-size: 7.5px;
  background: rgba(255, 255, 255, 0.06);
}
.ch-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ch-num { font-family: var(--mono); font-size: 12px; }
.ch-bin {
  font-size: 9.5px;
  font-family: var(--mono);
  color: var(--text-faint);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 4px;
}

.ch-skeleton { padding: 8px 10px; }
.ch-skel-row { height: 24px; display: flex; align-items: center; }
.ch-skel-bar {
  display: block;
  height: 9px;
  width: 70%;
  border-radius: 4px;
  background: linear-gradient(90deg, var(--bg-elevated), var(--bg-hover), var(--bg-elevated));
  animation: ch-pulse 1.4s ease-in-out infinite;
}
@keyframes ch-pulse {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}

.ch-state { padding: 16px 12px; text-align: center; }
.ch-state.error .ch-state-text { color: var(--red); }
.ch-state-text { font-size: 12px; color: var(--text-faint); line-height: 1.6; word-break: break-word; }
.ch-state-btn {
  margin-top: 10px;
  padding: 3px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-elevated);
  color: var(--text-dim);
  font-size: 11.5px;
  cursor: pointer;
}
.ch-state-btn:hover { background: var(--bg-hover); color: var(--text); }
.ch-truncated { padding: 6px 10px; font-size: 11px; color: var(--text-faint); }

/* 详情区 */
.ch-detail { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.ch-detail-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--text-faint);
}
</style>
