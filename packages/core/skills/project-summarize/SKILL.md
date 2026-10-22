---
name: project-summarize
description: 扫描项目结构并生成一份项目摘要文档
triggers:
  - 项目摘要
  - summarize project
  - 项目概览
tools_allowlist: [read_file, list_dir, glob_search, grep_search, write_file]
---
# 项目摘要生成流程

1. **收集结构**：`list_dir` 根目录 + 关键子目录；读 `package.json`（或等价清单）获取依赖与脚本。
2. **识别技术栈**：语言、框架、构建工具、测试框架、包管理器。
3. **提取关键信息**：
   - README / docs/ 下的设计文档要点
   - 入口文件与主流程（从 package.json main/bin/scripts 顺藤摸瓜）
   - 目录职责划分（src 下各子目录的用途）
4. **输出摘要**（Markdown）：
   - 一句话定位
   - 技术栈清单
   - 目录结构与职责
   - 常用命令（构建/测试/运行）
   - 值得注意的约定（代码风格、分支策略、部署方式）
5. **落盘**：写入 `PROJECT-SUMMARY.md`（先向用户确认，除非已明确授权）。

限制：摘要不超过 120 行；不确定的内容标注"待确认"，不要编造。
