<script setup lang="ts">
// 弹窗外壳：遮罩 + 面板（点遮罩关闭），与原型 .modal-mask/.modal 同款
defineProps<{
  title: string;
  width?: number;
  icon?: string;
}>();
const emit = defineEmits<{ close: [] }>();

/** 点遮罩本身（而非面板内部）时关闭 */
function onMaskClick(e: MouseEvent) {
  if (e.target === e.currentTarget) emit('close');
}
</script>

<template>
  <div class="mask" @click="onMaskClick">
    <div class="modal" :style="{ width: `${width ?? 460}px` }">
      <div class="head">
        <h3><span v-if="icon" class="ico">{{ icon }}</span>{{ title }}</h3>
        <button class="x" title="关闭" @click="emit('close')">✕</button>
      </div>
      <div class="body">
        <slot />
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.55);
  display: flex; align-items: center; justify-content: center; z-index: 100;
}
.modal {
  max-width: calc(100vw - 48px); max-height: calc(100vh - 80px);
  background: var(--bg-elevated); border: 1px solid var(--border);
  border-radius: 14px; padding: 20px 22px 18px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
  animation: fadeIn 0.18s ease; display: flex; flex-direction: column;
}
.head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
h3 { font-size: 15px; display: flex; align-items: center; gap: 8px; }
.ico { font-size: 14px; }
.x {
  width: 26px; height: 26px; border-radius: 7px; border: none;
  background: transparent; color: var(--text-faint); cursor: pointer; font-size: 13px;
}
.x:hover { background: var(--bg-hover); color: var(--text); }
.body { overflow-y: auto; min-height: 0; }
</style>
