<script setup lang="ts">
// F-39 专家详情：容器（ModalShell 520px，D2）——内容与容器分离，Body 不依赖 ModalShell。
import { onMounted, ref } from 'vue';
import ModalShell from './ModalShell.vue';
import ExpertDetailBody from './ExpertDetailBody.vue';
import { useExpertsStore } from '../stores/experts';

const props = defineProps<{ name: string }>();
const emit = defineEmits<{ close: []; summon: [name: string] }>();

const store = useExpertsStore();
const ready = ref(false);

onMounted(async () => {
  await store.loadDetail(props.name);
  ready.value = true;
});
</script>

<template>
  <ModalShell title="专家详情" :width="520" @close="emit('close')">
    <ExpertDetailBody v-if="ready" :name="name" @summon="emit('summon', $event)" />
    <div v-else class="xd-loading">加载中…</div>
  </ModalShell>
</template>

<style scoped>
.xd-loading { padding: 32px 0; text-align: center; color: var(--text-dim); font-size: 13px; }
</style>
