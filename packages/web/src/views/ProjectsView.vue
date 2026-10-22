<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useWorkspaceStore } from '../stores/workspace';

const store = useWorkspaceStore();
const router = useRouter();
const newRoot = ref('');
const searchQ = ref('');
const searchResults = ref<Array<{ id: string; title: string }>>([]);
const error = ref('');

onMounted(async () => {
  await store.refreshProjects();
  await store.refreshTrash();
  if (store.projects.length > 0) await store.selectProject(store.projects[0]!.id);
});

async function addProject() {
  error.value = '';
  try {
    await store.createProject(newRoot.value.trim());
    newRoot.value = '';
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function addSession() {
  const s = await store.createSession({ title: `新对话 ${new Date().toLocaleString('zh-CN')}` });
  router.push(`/chat/${s.id}`);
}

async function removeProject(p: { id: string; name: string }) {
  const name = prompt(`移除项目将级联删除其下会话（进回收站）。\n请输入项目名确认：${p.name}`);
  if (name === null) return;
  try {
    await store.removeProject(p.id, name);
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function doSearch() {
  searchResults.value = (await store.search(searchQ.value)) as Array<{ id: string; title: string }>;
}
</script>

<template>
  <div class="layout">
    <section class="panel">
      <h2>项目</h2>
      <div class="row">
        <input v-model="newRoot" placeholder="项目根目录绝对路径" @keyup.enter="addProject" />
        <button @click="addProject">注册项目</button>
      </div>
      <p v-if="error" class="error">{{ error }}</p>
      <ul class="list">
        <li
          v-for="p in store.projects"
          :key="p.id"
          :class="{ active: p.id === store.activeProjectId }"
          @click="store.selectProject(p.id)"
        >
          <span class="grow">{{ p.name }}</span>
          <span class="muted">{{ p.session_count }} 会话</span>
          <button class="danger" @click.stop="removeProject(p)">移除</button>
        </li>
      </ul>
    </section>

    <section class="panel">
      <h2>会话</h2>
      <div class="row">
        <input v-model="searchQ" placeholder="搜索对话（标题/内容）" @keyup.enter="doSearch" />
        <button @click="doSearch">搜索</button>
        <button class="primary" :disabled="!store.activeProjectId" @click="addSession">新建对话</button>
      </div>
      <ul v-if="searchResults.length" class="list">
        <li v-for="r in searchResults" :key="r.id" @click="router.push(`/chat/${r.id}`)">
          <span class="grow">{{ r.title }}</span><span class="muted">检索命中</span>
        </li>
      </ul>
      <ul class="list">
        <li
          v-for="s in store.sessions"
          :key="s.id"
          :class="{ active: router.currentRoute.value.params.sessionId === s.id }"
          @click="router.push(`/chat/${s.id}`)"
        >
          <span class="grow">{{ s.title }}</span>
          <span class="muted">{{ s.model || '默认模型' }}</span>
          <button class="danger" @click.stop="store.removeSession(s.id)">删除</button>
        </li>
        <li v-if="store.sessions.length === 0" class="muted">（当前项目暂无会话）</li>
      </ul>
    </section>

    <section class="panel">
      <h2>回收站 <span class="muted">（30 天后自动清除）</span></h2>
      <ul class="list">
        <li v-for="t in store.trash" :key="t.kind + t.id">
          <span class="grow">[{{ t.kind === 'project' ? '项目' : '会话' }}] {{ t.name }}</span>
          <span class="muted">{{ new Date(t.deleted_at).toLocaleString('zh-CN') }}</span>
          <button @click="store.restore(t.kind, t.id)">恢复</button>
          <button class="danger" @click="store.purge(t.kind, t.id)">彻底清除</button>
        </li>
        <li v-if="store.trash.length === 0" class="muted">（空）</li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.layout { display: grid; grid-template-columns: 1fr 1.4fr 1.2fr; gap: 16px; height: 100%; }
.panel { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 14px; overflow: auto; }
h2 { margin: 0 0 10px; font-size: 15px; }
.row { display: flex; gap: 8px; margin-bottom: 10px; }
.row input { flex: 1; }
.list { list-style: none; margin: 0; padding: 0; }
.list li {
  display: flex; align-items: center; gap: 8px; padding: 7px 9px; border-radius: 6px;
  cursor: pointer; font-size: 14px;
}
.list li:hover, .list li.active { background: #eef2f7; }
.grow { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.muted { color: #8b949e; font-size: 12px; }
.error { color: #cf222e; font-size: 13px; }
input, button {
  padding: 6px 10px; border: 1px solid #d0d7de; border-radius: 6px; font-size: 13px; background: #fff;
}
button { cursor: pointer; }
button:hover { background: #f3f4f6; }
button.primary { background: #1f883d; color: #fff; border-color: #1f883d; }
button.danger { color: #cf222e; }
</style>
