<script setup lang="ts">
// F-39 P1（T16）：首次召唤信任确认（ModalShell 360px，知情同意）
// 展示 = 来源层 + 工具清单（写/执行高亮）+ 提示词摘要前几行；
// 取消 → 不建会话（侧栏无新条目）；信任 → 服务端复核 tools_hash 后落 trusted[]。
import { computed, onMounted, ref } from 'vue';
import ModalShell from './ModalShell.vue';
import { api } from '../api/client';
import { useExpertsStore } from '../stores/experts';

const props = defineProps<{ name: string }>();
const emit = defineEmits<{ close: []; confirmed: [name: string] }>();

const store = useExpertsStore();
const detail = computed(() => store.details[props.name] ?? null);
const busy = ref(false);
const errorMsg = ref('');

onMounted(async () => {
  await store.loadDetail(props.name);
});

async function confirm() {
  if (!detail.value) return;
  busy.value = true;
  errorMsg.value = '';
  try {
    await api.trustExpert(props.name, detail.value.tools_hash);
    emit('confirmed', props.name);
  } catch (e) {
    errorMsg.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <ModalShell title="首次使用该专家" :width="360" @close="emit('close')">
    <div v-if="detail" class="trust">
      <p class="src">
        来源：<b>{{ detail.layer === 'user' ? '用户级' : detail.layer === 'project' ? '项目级' : '内置' }}</b>
        · v{{ detail.version }} · {{ detail.profession.zh || detail.profession.en }}
      </p>
      <div class="tools">
        <span class="label">工具白名单</span>
        <div class="chips">
          <span
            v-for="t in detail.tools ?? []"
            :key="t"
            class="chip"
            :class="{ risky: ['write_file', 'edit_file', 'run_command', 'run_tests'].includes(t) }"
          >{{ t }}</span>
          <span v-if="!detail.tools || detail.tools.length === 0" class="chip">不收窄（全部工具可用）</span>
        </div>
        <p v-if="detail.tools?.some((t) => ['write_file', 'edit_file'].includes(t))" class="warn">⚠ 该专家将可修改你的文件</p>
        <p v-if="detail.tools?.some((t) => ['run_command', 'run_tests'].includes(t))" class="warn">⚠ 该专家将可执行命令</p>
      </div>
      <pre class="preview">{{ detail.prompt_preview.slice(0, 160) }}…</pre>
      <p class="note">信任只是知情同意，不是权限边界：白名单外的调用始终被注册表拒绝；版本或工具集变化后需重新确认。</p>
      <p v-if="errorMsg" class="err">✘ {{ errorMsg }}</p>
      <div class="actions">
        <button class="btn" type="button" :disabled="busy" @click="emit('close')">取消</button>
        <button class="btn primary" type="button" :disabled="busy" @click="confirm">{{ busy ? '…' : '信任并召唤' }}</button>
      </div>
    </div>
    <div v-else class="loading">加载中…</div>
  </ModalShell>
</template>

<style scoped>
.trust { display: flex; flex-direction: column; gap: 10px; font-size: 12px; }
.loading { padding: 24px; text-align: center; color: var(--text-dim); }
.src { margin: 0; color: var(--text-dim); }
.label { font-size: 11px; color: var(--text-faint); }
.chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.chip { padding: 1px 7px; border-radius: 6px; background: var(--bg-panel); border: 1px solid var(--border); color: var(--text-dim); font-size: 11px; }
.chip.risky { color: var(--orange, #d29922); border-color: var(--orange, #d29922); }
.warn { margin: 4px 0 0; color: var(--orange, #d29922); }
.preview {
  margin: 0; padding: 8px; max-height: 96px; overflow: hidden;
  background: var(--bg-panel); border: 1px solid var(--border); border-radius: 8px;
  font-size: 11px; white-space: pre-wrap; color: var(--text-dim);
}
.note { margin: 0; color: var(--text-faint); font-size: 11px; }
.err { margin: 0; color: var(--red, #f85149); }
.actions { display: flex; justify-content: flex-end; gap: 8px; }
.btn { padding: 6px 14px; border-radius: 8px; border: 1px solid var(--border); background: none; color: var(--text); cursor: pointer; }
.btn.primary { background: var(--accent, #4a9eff); border-color: var(--accent, #4a9eff); color: #fff; font-weight: 600; }
</style>
