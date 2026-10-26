<script setup lang="ts">
// F-39 P1（T15）：设置页「专家」Tab —— 三层分组 / 停用开关 / 撤销信任 / 删除 / 导入 / 创建 / 导出
import { computed, onMounted, ref } from 'vue';
import { api, type ExpertListItem } from '../../api/client';
import { useExpertsStore } from '../../stores/experts';

const store = useExpertsStore();
const disabled = ref<string[]>([]);
const busy = ref(false);
const msg = ref('');
const err = ref('');

// 创建表单
const showCreate = ref(false);
const form = ref({ name: '', displayName: '', profession: '', description: '', expertType: 'agent' as 'agent' | 'team', layer: 'user' as 'user' | 'project' });
const fileInput = ref<HTMLInputElement | null>(null);

onMounted(refresh);

async function refresh() {
  await store.load();
  try {
    const r = await api.listExperts();
    disabled.value = r.disabled ?? [];
  } catch {
    /* 忽略 */
  }
}

const groups = computed(() => {
  const by = (l: string) => store.list.filter((e) => e.layer === l);
  return [
    { label: '内置（只读）', list: by('builtin') },
    { label: '用户级 ~/.delta/experts', list: by('user') },
    { label: '项目级 .delta/experts', list: by('project') },
  ].filter((g) => g.list.length > 0);
});

function isDisabled(e: ExpertListItem): boolean {
  return disabled.value.includes(e.name);
}

async function run(fn: () => Promise<void>, okMsg: string) {
  busy.value = true;
  err.value = '';
  msg.value = '';
  try {
    await fn();
    msg.value = okMsg;
    await refresh();
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

const toggleDisabled = (e: ExpertListItem) => run(async () => { await api.setExpertDisabled(e.name, !isDisabled(e)); }, isDisabled(e) ? `已恢复 ${e.name}` : `已停用 ${e.name}`);
const revoke = (e: ExpertListItem) => run(async () => { await api.revokeTrust(e.name); }, `已撤销对 ${e.name} 的信任`);
const remove = (e: ExpertListItem) => run(async () => { await api.deleteExpert(e.name); }, `已删除 ${e.name}`);

async function create() {
  await run(async () => {
    await api.createExpert({ ...form.value });
    showCreate.value = false;
    form.value = { name: '', displayName: '', profession: '', description: '', expertType: 'agent', layer: 'user' };
  }, '已创建专家骨架');
}

async function onPickZip(ev: Event) {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const b64 = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error('读取文件失败'));
    r.readAsDataURL(file);
  });
  await run(async () => { await api.importExpert(b64, 'user'); }, `已导入 ${file.name}`);
  if (fileInput.value) fileInput.value.value = '';
}

const exportUrl = (e: ExpertListItem) => api.exportExpertUrl(e.name);
</script>

<template>
  <div class="experts-panel">
    <div class="ops">
      <button class="btn" type="button" :disabled="busy" @click="fileInput?.click()">⬆ 导入 zip</button>
      <button class="btn" type="button" :disabled="busy" @click="showCreate = !showCreate">＋ 创建专家</button>
      <input ref="fileInput" type="file" accept=".zip" hidden @change="onPickZip" />
    </div>

    <div v-if="showCreate" class="create">
      <input v-model="form.name" class="ipt" placeholder="包名（小写字母开头，如 my-expert）" />
      <input v-model="form.displayName" class="ipt" placeholder="展示名" />
      <input v-model="form.profession" class="ipt" placeholder="职业" />
      <input v-model="form.description" class="ipt" placeholder="一句话描述（可选）" />
      <div class="row">
        <select v-model="form.expertType" class="ipt sel">
          <option value="agent">单人专家</option>
          <option value="team">团队</option>
        </select>
        <select v-model="form.layer" class="ipt sel">
          <option value="user">用户级</option>
          <option value="project">项目级</option>
        </select>
        <button class="btn primary" type="button" :disabled="busy || !form.name || !form.displayName || !form.profession" @click="create">创建</button>
      </div>
    </div>

    <p v-if="msg" class="ok">{{ msg }}</p>
    <p v-if="err" class="error">✘ {{ err }}</p>

    <div v-for="g in groups" :key="g.label" class="group">
      <h4 class="g-title">{{ g.label }}</h4>
      <div v-for="e in g.list" :key="e.name" class="row-item">
        <span class="ico">{{ e.expertType === 'team' ? '▣' : '◆' }}</span>
        <span class="name">{{ e.displayName.zh || e.displayName.en }}</span>
        <span class="sub">{{ e.profession.zh || e.profession.en }} · {{ e.expertType === 'team' ? `${e.memberCount}人` : '单人' }}</span>
        <span v-if="isDisabled(e)" class="tag off">已停用</span>
        <span class="spacer" />
        <a v-if="e.layer !== 'builtin'" class="op" :href="exportUrl(e)" download>导出</a>
        <button v-if="e.layer !== 'builtin'" class="op" type="button" :disabled="busy" @click="toggleDisabled(e)">
          {{ isDisabled(e) ? '恢复' : '停止使用' }}
        </button>
        <button
          v-if="e.layer !== 'builtin' && e.trusted"
          class="op"
          type="button"
          :disabled="busy"
          title="撤销信任：下次召唤需重新确认"
          @click="revoke(e)"
        >撤销信任</button>
        <button v-if="e.layer !== 'builtin'" class="op danger" type="button" :disabled="busy" @click="remove(e)">删除</button>
      </div>
    </div>

    <p v-if="store.errors.length" class="errors">⚠ {{ store.errors.join('；') }}</p>
  </div>
</template>

<style scoped>
.experts-panel { display: flex; flex-direction: column; gap: 12px; font-size: 13px; }
.ops { display: flex; gap: 8px; }
.btn { padding: 6px 12px; border: 1px solid var(--border); border-radius: 8px; background: none; color: var(--text); cursor: pointer; }
.btn.primary { background: var(--accent, #4a9eff); border-color: var(--accent, #4a9eff); color: #fff; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.create { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--border); border-radius: 10px; }
.ipt { padding: 6px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-panel); color: var(--text); }
.sel { width: 140px; }
.row { display: flex; gap: 8px; align-items: center; }
.group { display: flex; flex-direction: column; gap: 4px; }
.g-title { margin: 0 0 4px; font-size: 12px; color: var(--text-faint); }
.row-item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 10px; }
.ico { color: var(--accent, #4a9eff); }
.name { font-weight: 600; }
.sub { color: var(--text-dim); font-size: 12px; }
.tag.off { font-size: 11px; color: var(--orange, #d29922); }
.spacer { flex: 1; }
.op { background: none; border: 0; color: var(--text-dim); cursor: pointer; font-size: 12px; text-decoration: none; }
.op:hover { color: var(--text); }
.op.danger:hover { color: var(--red, #f85149); }
.ok { margin: 0; color: var(--green, #3fb950); }
.error { margin: 0; color: var(--red, #f85149); }
.errors { margin: 0; color: var(--orange, #d29922); font-size: 12px; }
</style>
