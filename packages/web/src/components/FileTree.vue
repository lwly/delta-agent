<script setup lang="ts">
// F-38 文件树（PRD F-38-4，design D6/D12）
// - 懒加载：点文件夹才拉子层，首次展开显示 skeleton，已加载层缓存不再请求
// - 行高 24px / 每层缩进 12px（缩进最多 12 层，防横向溢出）/ 13px 字号 / 超长省略
// - 目录优先 + 大小写不敏感排序由后端完成，前端只按 cache 顺序展开
// - 只读：无右键菜单、无拖拽、无新建
import { computed } from 'vue';
import { useFilePanelStore, NO_SCOPE_HINT } from '../stores/filePanel';
import { classifyFile } from '../utils/fileIcon';

const panel = useFilePanelStore();

/** 缩进最多叠加 12 层（PRD §6 树深度约束） */
const MAX_INDENT_DEPTH = 12;
const INDENT_PX = 12;
/** skeleton 行数（加载态占位） */
const SKELETON_ROWS = 6;

type TreeRow =
  | { variant: 'entry'; name: string; path: string; type: 'dir' | 'file'; depth: number; expanded: boolean }
  | { variant: 'skeleton'; depth: number; key: string }
  | { variant: 'error'; depth: number; message: string; path: string }
  | { variant: 'empty'; depth: number; text: string; key: string };

/**
 * 扁平化渲染列表：仅展开已缓存前缀，避免递归组件与重复渲染。
 * 空目录 / 错误 / 加载态都作为「特殊行」混在同一列表里，保证缩进与层级视觉一致。
 */
const rows = computed<TreeRow[]>(() => {
  const out: TreeRow[] = [];
  const walk = (rel: string, depth: number): void => {
    const entries = panel.treeCache[rel];
    if (!entries) return;
    if (entries.length === 0) {
      out.push({ variant: 'empty', depth, text: '该目录为空', key: `empty:${rel}` });
      return;
    }
    for (const entry of entries) {
      const childPath = rel ? `${rel}/${entry.name}` : entry.name;
      const expanded = entry.type === 'dir' && panel.expanded[childPath] === true;
      out.push({
        variant: 'entry',
        name: entry.name,
        path: childPath,
        type: entry.type,
        depth: Math.min(depth, MAX_INDENT_DEPTH),
        expanded,
      });
      if (entry.type !== 'dir' || !expanded) continue;
      const childDepth = Math.min(depth + 1, MAX_INDENT_DEPTH);
      const err = panel.treeError[childPath];
      if (err) {
        out.push({ variant: 'error', depth: childDepth, message: err, path: childPath });
        continue;
      }
      if (panel.treeLoading[childPath] === true && !panel.treeCache[childPath]) {
        for (let i = 0; i < 2; i += 1) {
          out.push({ variant: 'skeleton', depth: childDepth, key: `sk:${childPath}:${i}` });
        }
        continue;
      }
      walk(childPath, childDepth);
    }
  };
  walk('', 0);
  return out;
});

/** 根层加载中（尚未有缓存）→ 整树骨架屏 */
const rootLoading = computed(() => !panel.treeCache[''] && panel.treeLoading[''] === true);
const rootError = computed(() => panel.treeError[''] ?? '');
const rootTotal = computed(() => panel.treeCache['']?.length ?? 0);

function indentOf(depth: number): string {
  return `${depth * INDENT_PX}px`;
}

function iconOf(name: string): { label: string; color: string } {
  return classifyFile(name);
}

function onRowClick(row: Extract<TreeRow, { variant: 'entry' }>): void {
  if (row.type === 'dir') void panel.toggleDir(row.path);
  else panel.openFile(row.path);
}

function retry(rel: string): void {
  void panel.ensureTree(rel, true);
}
</script>

<template>
  <div class="file-tree">
    <!-- 无作用域（未选会话/项目）：面板空态动作区放行进入后由这里接管，提示先选项目 -->
    <div v-if="!panel.scope" class="ft-state">
      <p class="ft-state-text">{{ NO_SCOPE_HINT }}</p>
    </div>

    <!-- 根层错误态（内联卡片，不弹全局 toast） -->
    <div v-else-if="rootError" class="ft-state error">
      <p class="ft-state-text">✘ {{ rootError }}</p>
      <button class="ft-retry" type="button" @click="retry('')">加载失败，点击重试</button>
    </div>

    <!-- 根层骨架屏 -->
    <div v-else-if="rootLoading" class="ft-skeleton">
      <div v-for="i in SKELETON_ROWS" :key="i" class="ft-skel-row">
        <span class="ft-skel-bar" :style="{ marginLeft: `${(i % 3) * INDENT_PX}px` }" />
      </div>
    </div>

    <template v-else>
      <div v-if="rows.length === 0" class="ft-state">
        <p class="ft-state-text">该目录为空</p>
      </div>
      <div v-else class="ft-rows" role="tree">
        <template v-for="row in rows" :key="row.variant === 'entry' ? row.path : row.variant === 'error' ? `err:${row.path}` : row.key">
          <div
            v-if="row.variant === 'entry'"
            class="ft-row"
            :class="{ dir: row.type === 'dir', file: row.type === 'file' }"
            role="treeitem"
            :aria-expanded="row.type === 'dir' ? row.expanded : undefined"
            :title="row.path"
            :style="{ paddingLeft: `calc(6px + ${indentOf(row.depth)})` }"
            @click="onRowClick(row)"
          >
            <!-- 目录：chevron 10px，展开旋转 90° -->
            <span v-if="row.type === 'dir'" class="ft-chevron" :class="{ open: row.expanded }">▸</span>
            <span v-else class="ft-chevron placeholder" />
            <!-- 类型图标：14×14 圆角方块 + 2 字母角标（仅装饰，不响应点击） -->
            <span v-if="row.type === 'file'" class="ft-icon" :style="{ color: iconOf(row.name).color }">
              {{ iconOf(row.name).label }}
            </span>
            <span v-else class="ft-icon dir-icon">📁</span>
            <span class="ft-name">{{ row.name }}</span>
          </div>

          <div v-else-if="row.variant === 'skeleton'" class="ft-row skeleton" :style="{ paddingLeft: `calc(6px + ${indentOf(row.depth)})` }">
            <span class="ft-skel-bar" />
          </div>

          <div v-else-if="row.variant === 'error'" class="ft-row error-row" :style="{ paddingLeft: `calc(6px + ${indentOf(row.depth)})` }">
            <span class="ft-err-text">✘ {{ row.message }}</span>
            <button class="ft-retry inline" type="button" @click="retry(row.path)">重试</button>
          </div>

          <div v-else class="ft-row empty-row" :style="{ paddingLeft: `calc(6px + ${indentOf(row.depth)})` }">
            <span class="ft-empty-text">{{ row.text }}</span>
          </div>
        </template>
      </div>

      <!-- 单层 500 条截断提示（PRD §6） -->
      <p v-if="panel.treeTruncated['']" class="ft-truncated">
        仅显示前 500 项（共 {{ panel.treeTruncated[''] }} 项）
      </p>
      <p v-else-if="rootTotal === 0" class="ft-truncated">该目录为空</p>
    </template>
  </div>
</template>

<style scoped>
.file-tree { flex: 1; min-height: 0; overflow: auto; padding: 4px 0 8px; }

/* 行高 24px / 13px 字号（PRD §5.6） */
.ft-row {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  min-height: 24px;
  padding-right: 8px;
  font-size: 13px;
  color: var(--text);
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.1s;
}
.ft-row:hover { background: var(--bg-hover); }
.ft-row.dir { color: var(--text-dim); }
.ft-row.skeleton, .ft-row.error-row, .ft-row.empty-row { cursor: default; }
.ft-row.skeleton:hover, .ft-row.error-row:hover, .ft-row.empty-row:hover { background: transparent; }

/* chevron 10px；展开旋转 90° */
.ft-chevron {
  width: 10px;
  min-width: 10px;
  font-size: 10px;
  line-height: 1;
  color: var(--text-faint);
  transition: transform 0.12s;
  display: inline-flex;
  justify-content: center;
}
.ft-chevron.open { transform: rotate(90deg); }
.ft-chevron.placeholder { visibility: hidden; }

/* 类型图标 14×14 圆角方块 + 2 字母角标 */
.ft-icon {
  width: 14px;
  height: 14px;
  min-width: 14px;
  border-radius: 3px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: var(--mono);
  font-size: 7.5px;
  line-height: 1;
  background: rgba(255, 255, 255, 0.06);
}
.ft-icon.dir-icon { background: transparent; font-size: 11px; }

.ft-name { overflow: hidden; text-overflow: ellipsis; }

.ft-skel-bar {
  display: inline-block;
  height: 9px;
  width: 52%;
  border-radius: 4px;
  background: linear-gradient(90deg, var(--bg-elevated), var(--bg-hover), var(--bg-elevated));
  animation: ft-pulse 1.4s ease-in-out infinite;
}
@keyframes ft-pulse {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}

.ft-state { padding: 14px 12px; text-align: center; }
.ft-state.error .ft-state-text { color: var(--red); }
.ft-state-text { font-size: 12px; color: var(--text-faint); }
.ft-retry {
  margin-top: 8px;
  padding: 3px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-elevated);
  color: var(--text-dim);
  font-size: 11.5px;
  cursor: pointer;
}
.ft-retry:hover { background: var(--bg-hover); color: var(--text); }
.ft-retry.inline { margin-top: 0; margin-left: 6px; padding: 1px 6px; font-size: 10.5px; }

.ft-err-text { font-size: 11.5px; color: var(--red); overflow: hidden; text-overflow: ellipsis; }
.ft-empty-text { font-size: 11.5px; color: var(--text-faint); }
.ft-truncated { padding: 6px 12px; font-size: 11px; color: var(--text-faint); }
</style>
