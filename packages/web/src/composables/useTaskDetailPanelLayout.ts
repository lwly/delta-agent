/**
 * 委派任务详情面板布局：三档展开、左缘拖拽、localStorage、主区让位 CSS 变量。
 */
import { computed, onMounted, onUnmounted, ref, watch, type Ref } from 'vue';
import {
  TDP_DEFAULT_WIDTH,
  TDP_TRANSITION_MS,
  clampTaskDetailDragWidth,
  isTaskDetailNarrowViewport,
  nextTaskDetailTier,
  readTaskDetailTier,
  snapTaskDetailWidthToTier,
  taskDetailTierWidth,
  writeTaskDetailTier,
  type TaskDetailPanelTier,
} from '../utils/taskDetailPanelSize';

const RESERVE_VAR = '--delta-tdp-reserve';
const HTML_OPEN_CLASS = 'tdp-panel-open';

function getStorage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

function syncDocumentReserve(px: number, open: boolean, overlay: boolean): void {
  const root = document.documentElement;
  if (!open) {
    root.style.removeProperty(RESERVE_VAR);
    root.classList.remove(HTML_OPEN_CLASS);
    root.dataset.tdpOverlay = '';
    return;
  }
  root.classList.add(HTML_OPEN_CLASS);
  if (overlay) {
    root.style.setProperty(RESERVE_VAR, '0px');
    root.dataset.tdpOverlay = '1';
  } else {
    root.style.setProperty(RESERVE_VAR, `${px}px`);
    root.dataset.tdpOverlay = '';
  }
}

export function useTaskDetailPanelLayout(panelOpen: Ref<boolean>) {
  const viewportW = ref(typeof window !== 'undefined' ? window.innerWidth : 1440);
  const tier = ref<TaskDetailPanelTier>(readTaskDetailTier(getStorage()));
  const resizing = ref(false);
  /** 拖拽过程中的临时宽度；null = 使用档位预设 */
  const dragPx = ref<number | null>(null);

  const isNarrow = computed(() => isTaskDetailNarrowViewport(viewportW.value));
  const expandEnabled = computed(() => panelOpen.value && !isNarrow.value);

  const widthPx = computed(() => {
    if (!panelOpen.value) return 0;
    if (isNarrow.value) {
      return Math.max(320, viewportW.value - 48);
    }
    if (dragPx.value != null) return clampTaskDetailDragWidth(dragPx.value, viewportW.value);
    return taskDetailTierWidth(tier.value, viewportW.value);
  });

  const isExpanded = computed(
    () => !isNarrow.value && (tier.value > 0 || (dragPx.value != null && dragPx.value > TDP_DEFAULT_WIDTH)),
  );

  const handleLabel = computed(() => (isExpanded.value ? '还原面板' : '展开面板'));
  const handleIcon = computed(() => (isExpanded.value ? '»' : '«'));

  function persistTier(t: TaskDetailPanelTier): void {
    writeTaskDetailTier(getStorage(), t);
  }

  function cycleTier(): void {
    if (!expandEnabled.value) return;
    dragPx.value = null;
    tier.value = nextTaskDetailTier(tier.value);
    persistTier(tier.value);
  }

  function collapseToDefault(): void {
    if (tier.value === 0 && dragPx.value == null) return;
    tier.value = 0;
    dragPx.value = null;
    persistTier(0);
  }

  function onResize(): void {
    viewportW.value = window.innerWidth;
    if (dragPx.value != null) {
      dragPx.value = clampTaskDetailDragWidth(dragPx.value, viewportW.value);
    }
  }

  function onKeydown(ev: KeyboardEvent): void {
    if (!panelOpen.value || ev.key !== 'Escape' || !isExpanded.value) return;
    ev.preventDefault();
    collapseToDefault();
  }

  let stopDrag: (() => void) | null = null;

  function startDrag(ev: PointerEvent): void {
    if (!expandEnabled.value) return;
    ev.preventDefault();
    const startX = ev.clientX;
    const startW = widthPx.value;
    resizing.value = true;
    document.body.style.userSelect = 'none';
    const onMove = (e: PointerEvent) => {
      dragPx.value = clampTaskDetailDragWidth(startW + (startX - e.clientX), viewportW.value);
    };
    const onUp = () => {
      resizing.value = false;
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      stopDrag = null;
      if (dragPx.value != null) {
        tier.value = snapTaskDetailWidthToTier(dragPx.value, viewportW.value);
        dragPx.value = null;
        persistTier(tier.value);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    stopDrag = onUp;
  }

  watch(
    [widthPx, panelOpen, isNarrow],
    ([px, open, narrow]) => {
      syncDocumentReserve(px, open, narrow && open);
    },
    { immediate: true },
  );

  onMounted(() => {
    window.addEventListener('resize', onResize);
    window.addEventListener('keydown', onKeydown);
  });

  onUnmounted(() => {
    window.removeEventListener('resize', onResize);
    window.removeEventListener('keydown', onKeydown);
    stopDrag?.();
    document.body.style.userSelect = '';
    syncDocumentReserve(0, false, false);
  });

  return {
    widthPx,
    expandEnabled,
    isNarrow,
    isExpanded,
    resizing,
    handleLabel,
    handleIcon,
    transitionMs: TDP_TRANSITION_MS,
    cycleTier,
    collapseToDefault,
    startDrag,
  };
}
