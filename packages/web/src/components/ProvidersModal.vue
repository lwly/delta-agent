<script setup lang="ts">
// 模型配置弹窗（F-04a）：薄壳 = ModalShell + ProvidersPanel（内容面板同时被设置页复用）
import ModalShell from './ModalShell.vue';
import ProvidersPanel from './settings/ProvidersPanel.vue';

const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <ModalShell title="模型配置" icon="⚙" :width="600" @close="emit('close')">
    <ProvidersPanel />
  </ModalShell>
</template>
