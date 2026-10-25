/**
 * 工具名 → 中文标签映射（消息流工具卡 / 运行状态条共用）。
 * 未知工具回落原名（诚实展示，不猜译名）。
 */
const TOOL_LABELS: Record<string, string> = {
  run_command: '运行命令',
  write_file: '写入文件',
  edit_file: '编辑文件',
  read_file: '读取文件',
  grep_search: '搜索内容',
  glob_search: '查找文件',
  list_dir: '浏览目录',
  web_fetch: '网页抓取',
  run_tests: '运行测试',
  save_memory: '保存记忆',
  recall_memory: '召回记忆',
  load_skill: '加载技能',
  unload_skill: '卸载技能',
  todo_write: '更新待办',
  ask_user: '询问用户',
  task: '派发子任务',
};

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}
