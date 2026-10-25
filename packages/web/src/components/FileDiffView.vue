<script setup lang="ts">
// F-38 单文件 diff 详情（PRD F-38-7，design D8/D9 + §5.3）
// 服务端已把 unified diff 解析成结构化行（core/files/patch.ts），本组件只负责渲染：
// hunk 头 --text-faint；新增行 --green-soft 底 + 绿行号；删除行 --red-soft 底 + 红行号；等宽 12px。
// 只读：无编辑 / 暂存 / 回滚入口。
import { computed } from 'vue';
import { useFilePanelStore } from '../stores/filePanel';

const props = defineProps<{ path: string }>();
const emit = defineEmits<{ (e: 'clear'): void }>();

const panel = useFilePanelStore();

const diff = computed(() => panel.diffs[props.path]);
const loading = computed(() => panel.diffLoading[props.path] === true);
const error = computed(() => panel.diffError[props.path] ?? '');

/** 无 hunk 行且带 reason（二进制 / 截断到空）→ 提示卡而非空白区 */
const infoReason = computed(() => {
  const d = diff.value;
  if (!d || !d.ok) return d?.reason ?? '';
  if (d.rows.length === 0) return d.reason ?? '该文件无差异内容';
  return '';
});

function retry(): void {
  void panel.loadDiff(props.path, true);
}

async function copyPath(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.path);
  } catch {
    // 剪贴板不可用时静默
  }
}
</script>

<template>
  <div class="diff">
    <!-- 详情头：相对路径 + 复制 + × 清除选择 -->
    <div class="d-head">
      <span class="d-path" :title="path">{{ path }}</span>
      <button class="d-op" type="button" title="复制相对路径" @click="copyPath">📋</button>
      <button class="d-op" type="button" title="清除选择" @click="emit('clear')">×</button>
    </div>

    <div class="d-body">
      <div v-if="loading && !diff" class="d-state">加载中…</div>

      <div v-else-if="error" class="d-state error">
        <p class="d-state-text">✘ {{ error }}</p>
        <button class="d-state-btn" type="button" @click="retry">加载失败，点击重试</button>
      </div>

      <template v-else-if="diff">
        <div v-if="infoReason" class="d-state">
          <p class="d-state-text">{{ infoReason }}</p>
        </div>

        <template v-else>
          <template v-for="(row, i) in diff.rows" :key="i">
            <!-- hunk 头：整行弱化 -->
            <div v-if="row.type === 'hunk'" class="d-hunk">{{ row.text }}</div>
            <!-- 增 / 删 / 上下文行：旧行号 + 新行号 gutter + 正文 -->
            <div v-else class="d-row" :class="row.type">
              <span class="d-no">{{ row.old_no ?? '' }}</span>
              <span class="d-no">{{ row.new_no ?? '' }}</span>
              <span class="d-text">{{ row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' ' }}{{ row.text }}</span>
            </div>
          </template>

          <!-- 截断提示（服务端已截到前 2000 行 / 256KB） -->
          <p v-if="diff.truncated" class="d-truncated">
            {{ diff.reason ?? 'diff 过大已截断，建议在终端查看' }}
          </p>
        </template>
      </template>

      <div v-else class="d-state">加载中…</div>
    </div>
  </div>
</template>

<style scoped>
.diff { flex: 1; min-height: 0; display: flex; flex-direction: column; }

/* 详情头 32px（与变更汇总头同高，视觉成组） */
.d-head {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  min-height: 32px;
  padding: 0 10px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
}
.d-path {
  flex: 1;
  min-width: 0;
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.d-op {
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  color: var(--text-dim);
  font-size: 11.5px;
  line-height: 1;
  padding: 3px 7px;
  border-radius: 6px;
  cursor: pointer;
}
.d-op:hover { background: var(--bg-hover); color: var(--text); }

.d-body { flex: 1; min-height: 0; overflow: auto; font-family: var(--mono); font-size: 12px; }

/* hunk 头：@@ … @@ 弱化色 */
.d-hunk {
  height: 20px;
  line-height: 20px;
  padding: 0 10px;
  color: var(--text-faint);
  background: var(--bg-elevated);
  white-space: pre;
}

/* diff 行 20px / 等宽 12px（PRD §5.6）；行号列 40px */
.d-row { display: flex; height: 20px; line-height: 20px; }
.d-no {
  width: 40px;
  min-width: 40px;
  padding-right: 6px;
  text-align: right;
  color: var(--text-faint);
  user-select: none;
  border-right: 1px solid var(--border);
}
.d-text {
  flex: 1;
  padding: 0 10px 0 8px;
  color: var(--text);
  white-space: pre;
}
/* 绿加红减：底色 soft，行号同色（--green/--red 仅表达增删） */
.d-row.add { background: var(--green-soft); }
.d-row.add .d-no { color: var(--green); }
.d-row.del { background: var(--red-soft); }
.d-row.del .d-no { color: var(--red); }
.d-row.ctx { background: transparent; }
.d-row.ctx .d-text { color: var(--text-dim); }

.d-truncated {
  padding: 8px 10px;
  font-size: 11px;
  color: var(--orange);
  font-family: var(--sans);
}

.d-state { padding: 16px 12px; text-align: center; font-family: var(--sans); }
.d-state.error .d-state-text { color: var(--red); }
.d-state-text { font-size: 12px; color: var(--text-faint); line-height: 1.6; word-break: break-word; }
.d-state-btn {
  margin-top: 10px;
  padding: 3px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-elevated);
  color: var(--text-dim);
  font-size: 11.5px;
  cursor: pointer;
}
.d-state-btn:hover { background: var(--bg-hover); color: var(--text); }
</style>
