<script setup lang="ts">
// 记忆管理弹窗（F-06a）：薄壳 = ModalShell + MemoryPanel（内容面板同时被设置页复用）
import ModalShell from './ModalShell.vue';
import MemoryPanel from './settings/MemoryPanel.vue';

const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <ModalShell title="记忆管理" icon="🧠" :width="620" @close="emit('close')">
    <MemoryPanel />
  </ModalShell>
</template>
