<script setup lang="ts">
// F-39 已选专家胶囊：数据源必须是会话字段（chat.sessionMeta.expert），禁止本地 ref 镜像。
// ✕ 语义 = 新建无专家会话（P0 恒定新建，空会话也新建；就地解绑属 P1）。
defineProps<{
  displayName: string;
  type: 'agent' | 'team';
  /** 包已删除（会话打开时后端 missing 判定） */
  missing?: boolean;
  disabled?: boolean;
}>();

const emit = defineEmits<{ remove: [] }>();
</script>

<template>
  <span class="expert-capsule" :class="{ missing }" :title="`当前会话专家：${displayName}（会话创建时确定）`">
    <button
      class="xc-x"
      type="button"
      :disabled="disabled"
      :title="disabled ? 'Agent 运行中，停止后可切换专家' : '取消专家（将新建无专家对话）'"
      @click="emit('remove')"
    >
      ✕
    </button>
    <span v-if="missing" class="xc-warn" title="原绑定专家已不存在，本次按无专家运行">⚠</span>
    <span class="xc-ico">{{ type === 'team' ? '▣' : '◆' }}</span>
    <span class="xc-name">{{ displayName }}</span>
  </span>
</template>

<style scoped>
.expert-capsule {
  display: inline-flex; align-items: center; gap: 6px;
  height: 26px; padding: 0 10px 0 6px; box-sizing: border-box;
  background: var(--accent-soft, rgba(74, 158, 255, 0.14));
  border: 1px solid var(--accent-border, rgba(74, 158, 255, 0.4));
  border-radius: 8px; font-size: 12px; color: var(--text);
}
.expert-capsule.missing { border-color: var(--orange, #d29922); }
.xc-x {
  width: 14px; height: 14px; line-height: 1; padding: 0;
  background: none; border: 0; cursor: pointer;
  color: var(--text-dim); font-size: 11px; display: inline-flex; align-items: center; justify-content: center;
}
.xc-x:hover:not(:disabled) { color: var(--red, #f85149); }
.xc-x:disabled { opacity: 0.45; cursor: not-allowed; }
.xc-warn { color: var(--orange, #d29922); }
.xc-ico { color: var(--accent, #4a9eff); }
</style>
