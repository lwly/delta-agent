<script setup lang="ts">
// F-22b 新建/编辑定时任务弹窗表单（WorkBuddy 模式）：
// 名称 / 大 prompt / 工作空间下拉（可手输）/ 权限下拉（yolo 二次确认）/
// 重复下拉（每小时/每天/每周/每月/自定义）+ 有效期（长期/自定义起止）。
// cron 生成与校验走纯函数（cronBuilder），提交后以后端 parseCron 校验为准。
import { computed, reactive, ref } from 'vue';
import { api, type CronJobView } from '../api/client';
import ModalShell from './ModalShell.vue';
import {
  buildCron,
  parseCronToForm,
  validateCronForm,
  type CronFormSchedule,
} from '../utils/cronBuilder';

const props = defineProps<{
  /** 编辑目标；null = 新建 */
  job: CronJobView | null;
  /** GET /api/cron 返回的工作空间候选（serve 启动目录 + 既有任务 cwd） */
  workspaces: string[];
}>();

const emit = defineEmits<{ close: []; saved: [] }>();

const MANUAL = '__manual__';

/** 'YYYY-MM-DD' 本地日期串（编辑回填用） */
function dateStr(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 本地时区 'YYYY-MM-DD' → ISO（start 00:00 / end 23:59:59） */
function dateToIso(d: string, endOfDay: boolean): string {
  const [y, m, day] = d.split('-').map(Number);
  return endOfDay
    ? new Date(y!, m! - 1, day!, 23, 59, 59, 0).toISOString()
    : new Date(y!, m! - 1, day!, 0, 0, 0, 0).toISOString();
}

const editing = computed(() => props.job !== null);

// ── 表单状态 ──
const form = reactive({
  name: props.job?.name ?? '',
  prompt: props.job?.prompt ?? '',
  permission: (props.job?.permission ?? 'default') as 'plan' | 'default' | 'yolo',
  maxCost: props.job?.max_cost_usd !== undefined ? String(props.job.max_cost_usd) : '',
});
const schedule = ref<CronFormSchedule>(
  props.job ? parseCronToForm(props.job.cron) : { mode: 'daily', time: '09:00', weekDays: [], monthDay: null, customExpr: '' },
);
const validity = ref<'forever' | 'custom'>(props.job?.valid_from || props.job?.valid_until ? 'custom' : 'forever');
const validFromDate = ref(dateStr(props.job?.valid_from));
const validUntilDate = ref(dateStr(props.job?.valid_until));

// 工作空间：候选下拉 + 「手动输入…」兜底；编辑的任务 cwd 不在候选里时自动切手输
const wsMode = ref<'pick' | 'manual'>(
  props.job && !props.workspaces.includes(props.job.cwd) ? 'manual' : 'pick',
);
const wsPick = ref(wsMode.value === 'pick' ? (props.workspaces[0] ?? MANUAL) : MANUAL);
const wsManual = ref(wsMode.value === 'manual' ? (props.job?.cwd ?? '') : '');

/** 下拉选「手动输入…」→ 切换为文本框；候选为空时 effectiveCwd 也收敛到手输值 */
const effectiveCwd = computed(() => {
  if (wsMode.value === 'manual' || wsPick.value === MANUAL) return wsManual.value;
  return wsPick.value;
});

function onWsPickChange(): void {
  if (wsPick.value === MANUAL) wsMode.value = 'manual';
}

// ── 选项 ──
const weekOptions = [
  { value: 0, label: '周日' },
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
];
const monthDayOptions = Array.from({ length: 31 }, (_, i) => i + 1);
const repeatOptions: Array<{ value: CronFormSchedule['mode']; label: string }> = [
  { value: 'hourly', label: '每小时' },
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' },
  { value: 'custom', label: '自定义' },
];

// ── yolo 二次确认（决策 4）：首次点确定 → 行内确认条 → 再点确认才提交；切回非 yolo 重置 ──
const yoloArmed = ref(false);
const errors = ref<Record<string, string>>({});
const submitError = ref('');
const busy = ref(false);

function onPermissionChange(): void {
  yoloArmed.value = false;
}

function toggleWeekDay(d: number): void {
  const list = schedule.value.weekDays;
  const idx = list.indexOf(d);
  if (idx === -1) schedule.value.weekDays = [...list, d];
  else schedule.value.weekDays = list.filter((x) => x !== d);
}

/** end 早于当前时间 → 提交前警告（PRD §5.2） */
const expiringWarning = computed(() => {
  if (validity.value !== 'custom' || !validUntilDate.value) return '';
  return dateToIso(validUntilDate.value, true) < new Date().toISOString() ? '⚠ 任务创建后立即过期' : '';
});

async function submit(): Promise<void> {
  submitError.value = '';
  if (form.permission === 'yolo' && !yoloArmed.value) {
    yoloArmed.value = true; // 首次点确定：弹出二次确认条，不提交
    return;
  }
  const values = {
    name: form.name,
    prompt: form.prompt,
    cwd: effectiveCwd.value,
    permission: form.permission,
    validity: validity.value,
    validFrom: validFromDate.value,
    validUntil: validUntilDate.value,
    schedule: schedule.value,
  };
  errors.value = validateCronForm(values);
  if (Object.keys(errors.value).length > 0) return;
  const cron = buildCron(schedule.value);
  if (!cron) {
    submitError.value = '调度配置不完整，请检查时间/星期/日期选择';
    return;
  }
  const maxCost = Number(form.maxCost);
  const common = {
    name: form.name.trim(),
    cron,
    prompt: form.prompt,
    cwd: effectiveCwd.value.trim(),
    permission: form.permission,
    valid_from: validity.value === 'custom' && validFromDate.value ? dateToIso(validFromDate.value, false) : null,
    valid_until: validity.value === 'custom' && validUntilDate.value ? dateToIso(validUntilDate.value, true) : null,
    ...(Number.isFinite(maxCost) && maxCost > 0 ? { max_cost_usd: maxCost } : {}),
  };
  busy.value = true;
  try {
    if (editing.value && props.job) {
      await api.cronUpdate(props.job.id, common);
    } else {
      // 新建：null（长期有效）等价于缺省，省略空字段以满足 CronJobInput 类型（string | undefined）
      const { valid_from, valid_until, ...rest } = common;
      await api.cronAdd({
        ...rest,
        ...(valid_from ? { valid_from } : {}),
        ...(valid_until ? { valid_until } : {}),
        enabled: true,
      });
    }
    emit('saved');
  } catch (e) {
    // 后端 400（重名 / 目录不存在 / 表达式非法等）直接内联展示
    submitError.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <ModalShell :title="editing ? '编辑定时任务' : '新建定时任务'" icon="⏰" :width="560" @close="emit('close')">
    <div class="form">
      <label class="field">
        <span class="label">任务名称</span>
        <input v-model="form.name" placeholder="如：每日整理项目日报" />
        <span v-if="errors.name" class="err">{{ errors.name }}</span>
      </label>

      <label class="field">
        <span class="label">任务描述（prompt）</span>
        <textarea v-model="form.prompt" rows="4" placeholder="描述 agent 要完成的任务，等价 yzero run -p" />
        <span v-if="errors.prompt" class="err">{{ errors.prompt }}</span>
      </label>

      <div class="field">
        <span class="label">工作空间（运行目录）</span>
        <select v-if="wsMode === 'pick'" v-model="wsPick" @change="onWsPickChange">
          <option v-for="w in workspaces" :key="w" :value="w">{{ w }}</option>
          <option :value="MANUAL">手动输入…</option>
        </select>
        <input
          v-else
          v-model="wsManual"
          placeholder="输入绝对路径，如 /Users/me/project"
        />
        <button v-if="wsMode === 'manual'" class="link" @click="wsMode = 'pick'">改用候选列表</button>
        <span v-if="errors.cwd" class="err">{{ errors.cwd }}</span>
      </div>

      <div class="field">
        <span class="label">权限</span>
        <select v-model="form.permission" @change="onPermissionChange">
          <option value="default">标准确认（每次操作询问确认）</option>
          <option value="plan">只读（仅分析，不修改文件）</option>
          <option value="yolo">允许完全访问（跳过所有确认）</option>
        </select>
        <span v-if="form.permission === 'yolo'" class="yolo-hint">该任务将无需确认执行所有操作</span>
        <div v-if="form.permission === 'yolo' && yoloArmed" class="yolo-confirm">
          <span>确认允许该任务无需确认执行所有操作？</span>
          <button class="btn small" @click="yoloArmed = false">再想想</button>
          <button class="btn small primary" :disabled="busy" @click="submit">确认{{ editing ? '保存' : '创建' }}</button>
        </div>
      </div>

      <div class="field">
        <span class="label">重复</span>
        <div class="row">
          <select v-model="schedule.mode" class="mode">
            <option v-for="o in repeatOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
          <input
            v-if="schedule.mode !== 'hourly' && schedule.mode !== 'custom'"
            v-model="schedule.time"
            type="time"
            class="time"
          />
        </div>
        <div v-if="schedule.mode === 'weekly'" class="sub-row">
          <button
            v-for="o in weekOptions"
            :key="o.value"
            class="chip"
            :class="{ on: schedule.weekDays.includes(o.value) }"
            @click="toggleWeekDay(o.value)"
          >
            {{ o.label }}
          </button>
        </div>
        <span v-if="errors.weekDays" class="err">{{ errors.weekDays }}</span>
        <select v-if="schedule.mode === 'monthly'" v-model.number="schedule.monthDay" class="day">
          <option :value="null" disabled>选择日期</option>
          <option v-for="d in monthDayOptions" :key="d" :value="d">{{ d }} 日</option>
        </select>
        <span v-if="errors.monthDay" class="err">{{ errors.monthDay }}</span>
        <input
          v-if="schedule.mode === 'custom'"
          v-model="schedule.customExpr"
          placeholder='cron 表达式（5 字段），如 "*/15 8-18 * * 1-5" 或 @hourly'
          class="custom"
        />
        <span v-if="errors.customExpr" class="err">{{ errors.customExpr }}</span>
        <span v-if="errors.time" class="err">{{ errors.time }}</span>
      </div>

      <div class="field">
        <span class="label">有效期</span>
        <div class="row">
          <button class="chip" :class="{ on: validity === 'forever' }" @click="validity = 'forever'">长期有效</button>
          <button class="chip" :class="{ on: validity === 'custom' }" @click="validity = 'custom'">自定义起止日期</button>
        </div>
        <div v-if="validity === 'custom'" class="row dates">
          <input v-model="validFromDate" type="date" />
          <span class="tilde">→</span>
          <input v-model="validUntilDate" type="date" />
        </div>
        <span v-if="errors.validFrom" class="err">{{ errors.validFrom }}</span>
        <span v-if="errors.validUntil" class="err">{{ errors.validUntil }}</span>
        <span v-if="expiringWarning" class="warn">{{ expiringWarning }}</span>
      </div>

      <details class="more">
        <summary>更多设置</summary>
        <label class="field">
          <span class="label">单次费用上限（USD，可选）</span>
          <input v-model="form.maxCost" type="number" min="0" step="0.01" placeholder="缺省用 CLI 默认" />
        </label>
      </details>

      <p v-if="submitError" class="error">✘ {{ submitError }}</p>

      <div class="footer">
        <button class="btn" @click="emit('close')">取消</button>
        <button class="btn primary" :disabled="busy" @click="submit">
          {{ busy ? '保存中…' : yoloArmed && form.permission === 'yolo' ? '请在上方确认' : editing ? '保存' : '确定' }}
        </button>
      </div>
    </div>
  </ModalShell>
</template>

<style scoped>
.form { display: flex; flex-direction: column; gap: 12px; }
.field { display: flex; flex-direction: column; gap: 4px; }
.label { color: var(--text-dim); font-size: 12px; }
input, select, textarea {
  background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
  color: var(--text); padding: 7px 10px; font-size: 13px; width: 100%; box-sizing: border-box;
}
textarea { resize: vertical; font-family: inherit; }
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--accent-border); }
.row { display: flex; gap: 8px; align-items: center; }
.row .mode { flex: 1; }
.row .time { width: 130px; }
.row.dates input { flex: 1; }
.tilde { color: var(--text-faint); }
.sub-row { display: flex; gap: 6px; flex-wrap: wrap; }
.chip {
  border: 1px solid var(--border); border-radius: 14px; background: transparent;
  color: var(--text-dim); font-size: 12px; padding: 4px 12px; cursor: pointer;
}
.chip:hover { color: var(--text); }
.chip.on { color: var(--text); border-color: var(--accent); background: var(--accent-soft); }
.day { width: 140px; }
.custom { font-family: var(--mono); font-size: 12.5px; }
.yolo-hint { color: #d29922; font-size: 11.5px; }
.yolo-confirm {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  border: 1px solid #d29922; background: rgba(210, 153, 34, 0.08);
  border-radius: 8px; padding: 6px 10px; font-size: 12px; color: var(--text);
}
.link { border: none; background: transparent; color: var(--accent); font-size: 11.5px; cursor: pointer; padding: 0; text-align: left; }
.err { color: var(--red); font-size: 11.5px; }
.warn { color: #d29922; font-size: 11.5px; }
.error { color: var(--red); font-size: 12.5px; margin: 0; }
.more summary { color: var(--text-dim); font-size: 12px; cursor: pointer; }
.more .field { margin-top: 8px; }
.footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
.btn {
  border: 1px solid var(--border); border-radius: 8px; background: transparent;
  color: var(--text-dim); font-size: 13px; padding: 7px 16px; cursor: pointer;
}
.btn:hover:not(:disabled) { color: var(--text); }
.btn.primary { background: #238636; border-color: #2ea043; color: #fff; }
.btn.primary:hover:not(:disabled) { background: #2ea043; }
.btn:disabled { opacity: 0.5; cursor: default; }
.btn.small { padding: 3px 10px; font-size: 11.5px; }
</style>
