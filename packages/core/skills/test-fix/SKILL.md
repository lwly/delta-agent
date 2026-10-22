---
name: test-fix
description: 运行测试并对失败项定位修复
triggers:
  - 跑测试修错
  - fix tests
  - 修测试
tools_allowlist: [read_file, edit_file, glob_search, grep_search, run_command, run_tests]
---
# 测试修复流程

1. **运行测试**：优先用 `run_tests` 工具；无该工具配置时探测 package.json 的 test script（pnpm/npm test）。
2. **分类失败项**：
   - 断言失败：先读被测代码与测试代码，判断是实现 bug 还是测试过期
   - 编译/类型错误：优先修复，通常连带着后续断言失败
   - 超时/环境错误：检查依赖服务、端口、平台差异（Windows 路径分隔符等）
3. **逐项修复**：一次只改一个问题，改完立即重跑该测试文件验证，避免连锁改动。
4. **回归确认**：全部修复后完整跑一遍测试套件，确认无新失败。
5. **汇报**：列出每个失败项的根因、修复方式与验证结果。

原则：不通过删除测试或放宽断言来"修复"测试；确需变更测试时必须说明理由。
