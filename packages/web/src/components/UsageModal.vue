<script setup lang="ts">
// 用量报告弹窗（F-31）：薄壳 = ModalShell + UsagePanel（内容面板同时被设置页复用）
import ModalShell from './ModalShell.vue';
import UsagePanel from './settings/UsagePanel.vue';

const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <ModalShell title="用量报告" icon="📊" :width="680" @close="emit('close')">
    <UsagePanel />
  </ModalShell>
</template>
