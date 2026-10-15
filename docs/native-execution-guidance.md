# 0.1.8 原生执行边界回归

## 现场事实

计数器原树已完成。用户仅说“继续”，Agent 把 recorded warning 扩展为补功能/删临时文件的新请求；用户要求改一行浏览器标题时，又声称 Harness 必须先确认任务归属。

只读日志显示该标题请求的 Profile 是 conversation、没有活动 Workflow、路由为 routing_disabled/native_fallback，也没有该请求对应的 Hook 写入拒绝。归属询问由 Agent 主动创建。因此本次修复不是关闭真实门禁，而是消除“树完成等于项目禁写”的提示歧义。

## 实现边界

- Runtime Snapshot 新增 availableActionsScope=task_tree_workflow 和 nativeAgentGuidance，说明工作流动作不是全部原生工具权限。Snapshot 是项目级而非会话级，requiresRequestProfileCheck=true 要求先检查当前请求 Profile：直接执行提示仅适用于未暂停的 conversation/direct_coding 请求，不能覆盖 pause 或 structured_coding 门禁。
- 已注册项目没有活动 Workflow，且当前请求未进入 structured_coding 时，UserPromptSubmit（含幂等重送）提供精简原生引导：小的自包含修改不必先登记归属；裸“继续”没有未完成授权任务时说明已完成并结束；recorded warning 不是待办，也不是新增/删除授权。
- 用户已要求先讨论或审批仍须遵守。新显式结构化请求以及已有结构化执行的审批/Attempt 门禁没有改动。Snapshot 引导不授予权限，原生工具权限和用户范围仍生效。
- pause 的当前请求提示明确要求停止。下一条新用户请求重新进行正常路由，不把暂停扩大成整个项目永久禁写。
- 新目录的普通对话仍保持静默，不因为提示而创建项目标记或 Task Tree。
- JEV 开关未变，没有增加基于标题关键词的隐藏意图分类器；没有修改计数器源码，也不自动清除现场待归属记录。

## 验证与复测

新增集成用例覆盖完成/归档树的 Snapshot、裸继续、暂停后标题修改、当前暂停、结构化审批保留，以及发布格式 Hook 的 JSON 输出。这些测试验证 Runtime 及 Hook 边界，不代表真实 Claude 模型的对话行为已经通过验收。

全量检查使用 npm run check。真实 Agent 复测：

1. 对旧标题询问选择“暂停”，等待决定落库，避免遗留 pending affiliation 干扰新的请求；不要选择新建树。
2. 安装 0.1.8 后完全退出并重启 Claude Code。可执行 /clear 清除旧会话中“项目禁止写入”的错误理解；数据库中的原树、报告和历史事实不删除。
3. 在原计数器目录输入“继续”。预期说明没有待办并正常结束，不主动提出补功能/清理文件或归属询问。
4. 输入“把浏览器标签页标题改成「计数器回归测试」。”。预期直接修改并验证，无 Harness 归属选择、新树或强制 Plan 审批；原生权限提示不属于 Harness 回归失败。
5. 若仍询问归属或声称被拦截，保留完整工具输出和最新 Runtime Profile/拒绝 Trace。不要通过重建树或额外提示词绕过验收。

## 本次检查结果（2026-10-12）

- 最初 7 个新增用例中，6 个因缺少引导而失败；保留结构化审批的用例通过。实现后转绿。
- 独立审查指出 Snapshot 不能推断会话 Profile 的边界问题；补充断言先复现失败，再增加请求 Profile 限定。复审无未解决问题。
- 最终 npm run check 退出码 0：511 个测试 / 72 个文件、类型检查、构建、官方插件与 marketplace 校验，以及单独的 12 个插件测试全部通过。
- 独立审查运行 67 个相关测试通过；不将这些结果等同于真实 Claude 模型遵循提示的验收结果。
- 用户级插件已由 0.1.7 更新为 0.1.8；需要完全重启 Claude Code 才加载新的 MCP/Hook 进程。
- 最后只读查询显示原计数器树及 Final Report 仍为 completed，revision 未改变，pendingAffiliationCount 为 0；计数器标题仍为“简易计数器”。本轮未操作现场归属决定或项目代码，未提交/推送 Git。
