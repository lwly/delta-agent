<script setup lang="ts">
// F-39 专家详情内容（只读信息卡 + 1 个主按钮；不 import ModalShell，可被将来 Drawer 直接复用）。
// 安全口径：不展示包绝对路径与任何凭据；工具白名单透明展示（限制 N/16）。
import { computed, onMounted, ref } from 'vue';
import { useExpertsStore } from '../stores/experts';

const props = defineProps<{ name: string }>();
const emit = defineEmits<{ summon: [name: string] }>();

const store = useExpertsStore();
const detail = computed(() => store.details[props.name] ?? null);
const avatar = ref<string | null>(null);
const showPrompt = ref(false);

onMounted(async () => {
  await store.loadDetail(props.name);
  if (detail.value?.hasAvatar) avatar.value = await store.loadAvatar(props.name);
});

const layerLabel = computed(() => {
  const l = detail.value?.layer;
  return l === 'builtin' ? '内置' : l === 'user' ? '用户级' : '项目级';
});
</script>

<template>
  <div v-if="detail" class="xdb">
    <div class="head">
      <img v-if="avatar" class="avatar" :src="avatar" alt="" />
      <span v-else class="avatar fallback">{{ (detail.displayName.zh || detail.displayName.en || '?').slice(0, 1) }}</span>
      <div class="titles">
        <h4>{{ detail.displayName.zh || detail.displayName.en }}</h4>
        <p class="sub">{{ detail.profession.zh || detail.profession.en }} · {{ detail.expertType === 'team' ? `团队 · ${detail.members.length} 人` : '单人' }} · {{ layerLabel }}</p>
      </div>
    </div>

    <p v-if="detail.description" class="desc">{{ detail.description }}</p>

    <div v-if="detail.skills.length" class="block">
      <span class="label">预置技能</span>
      <span v-for="s in detail.skills" :key="s" class="chip">{{ s }}</span>
    </div>

    <div class="block">
      <span class="label">工具白名单</span>
      <template v-if="detail.tools">
        <span v-for="t in detail.tools" :key="t" class="chip">{{ t }}</span>
        <span class="hint">ⓘ 该专家限制 {{ detail.tool_stats.restricted }}/{{ detail.tool_stats.total }} 个工具</span>
      </template>
      <span v-else class="hint">不收窄（全部工具可用）</span>
    </div>

    <div v-if="detail.members.length" class="block col">
      <span class="label">团队成员（lead 置顶）</span>
      <div
        v-for="m in [...detail.members].sort((a, b) => (a.role === b.role ? 0 : a.role === 'lead' ? -1 : 1))"
        :key="m.id"
        class="member"
        :class="{ lead: m.role === 'lead' }"
      >
        <span class="m-ico">{{ m.role === 'lead' ? '★' : '·' }}</span>
        <span class="m-name">{{ m.name.zh || m.name.en }}</span>
        <span class="m-prof">{{ m.profession.zh || m.profession.en }}</span>
        <span v-if="m.role === 'lead'" class="m-badge">主理人</span>
      </div>
    </div>

    <div class="block col">
      <button class="prompt-toggle" type="button" @click="showPrompt = !showPrompt">
        {{ showPrompt ? '▾' : '▸' }} 提示词摘要（{{ detail.prompt_stats.chars }} 字 ≈ {{ detail.prompt_stats.tokens }} tok{{ detail.prompt_stats.truncated ? '，注入时截断' : '' }}）
      </button>
      <pre v-if="showPrompt" class="prompt-pre">{{ detail.prompt_preview }}</pre>
    </div>

    <div class="actions">
      <button class="summon" type="button" @click="emit('summon', detail.name)">召唤专家</button>
    </div>
  </div>
  <div v-else class="xdb empty">详情加载失败</div>
</template>

<style scoped>
.xdb { display: flex; flex-direction: column; gap: 14px; font-size: 13px; }
.xdb.empty { padding: 24px; text-align: center; color: var(--text-dim); }
.head { display: flex; gap: 14px; align-items: center; }
.avatar { width: 64px; height: 64px; border-radius: 12px; object-fit: cover; }
.avatar.fallback {
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--accent-soft, rgba(74, 158, 255, 0.14)); color: var(--accent, #4a9eff);
  font-size: 26px; font-weight: 700;
}
.titles h4 { margin: 0 0 4px; font-size: 16px; }
.titles .sub { margin: 0; color: var(--text-dim); font-size: 12px; }
.desc { margin: 0; color: var(--text-dim); }
.block { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.block.col { flex-direction: column; align-items: stretch; }
.label { font-size: 12px; color: var(--text-faint); min-width: 64px; }
.chip {
  padding: 2px 8px; border-radius: 6px; font-size: 11px;
  background: var(--bg-panel); border: 1px solid var(--border); color: var(--text-dim);
}
.hint { font-size: 11px; color: var(--text-faint); }
.member { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 8px; }
.member.lead { background: var(--accent-soft, rgba(74, 158, 255, 0.1)); }
.m-name { font-weight: 600; }
.m-prof { color: var(--text-dim); font-size: 12px; flex: 1; }
.m-badge { font-size: 11px; color: var(--accent, #4a9eff); }
.prompt-toggle { background: none; border: 0; color: var(--text-dim); cursor: pointer; padding: 0; font-size: 12px; text-align: left; }
.prompt-pre {
  margin: 6px 0 0; padding: 10px; max-height: 200px; overflow: auto;
  background: var(--bg-panel); border: 1px solid var(--border); border-radius: 8px;
  font-size: 11px; white-space: pre-wrap; color: var(--text-dim);
}
.actions { display: flex; justify-content: flex-end; }
.summon {
  padding: 8px 20px; border: 0; border-radius: 8px; cursor: pointer;
  background: var(--accent, #4a9eff); color: #fff; font-size: 13px; font-weight: 600;
}
</style>
