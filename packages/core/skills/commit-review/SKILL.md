---
name: commit-review
description: 审查当前未提交变更并生成规范 commit message
triggers:
  - 审查提交
  - review commit
  - 提交审查
tools_allowlist: [read_file, glob_search, grep_search, run_command]
---
# Commit 审查流程

按以下步骤审查当前仓库的未提交变更，并产出提交建议：

1. **收集变更**：运行 `git status --porcelain` 与 `git diff`（含 `git diff --cached`）获取全量变更。
2. **逐文件审查**，重点关注：
   - 是否有硬编码密钥、token、密码（发现即标记为阻塞项）
   - 是否引入明显的安全问题（注入、越权路径、未转义输出）
   - 命名/风格是否与项目既有代码一致
   - 是否有遗漏的测试或明显的逻辑错误
3. **生成 commit message**，格式：
   ```
   <type>(<scope>): <一句话摘要>

   - 变更点 1
   - 变更点 2
   ```
   type 取值：feat / fix / refactor / test / docs / chore。
4. **输出报告**：按文件列出问题（严重级别：阻塞/建议/提示），最后给出建议的 commit message 全文。

注意：只读审查，不主动修改文件；用户确认后才可代为执行 `git commit`。
