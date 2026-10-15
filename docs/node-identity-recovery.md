# 0.1.7 节点身份隔离与旧根节点恢复

## 根因与修复

节点 ID 原先是全局主键；不同任务树都声明 `root` 时，第二棵树的规划修订会引用第一棵树的节点，保存时还可能覆盖第一棵树的标题或状态。项目隔离查询因此找不到第二棵树的根节点。这不是缺少规划内容或审批。

新保存路径在比较、精炼预览和持久化之前处理外部归属冲突：例如转换为 `node:<treeId>:root`。返回文档中的父子、依赖、关系、产物关联、契约提供方/消费方和骨架分支引用一起映射。相同树再次提交原逻辑名称时映射保持稳定；SQL 还会独立拒绝外部归属覆盖。Agent 应使用查询返回的真实 nodeId，不能猜测 `root`。

## 旧数据恢复边界

Schema 26 只新增审计、身份投影和读视图，不自动恢复任何节点：

- 原始 `task_tree_revisions.document_json`、`task_node_revisions.body_json` 及 revision ID 保持原样。
- `runtime_task_tree_revisions`、`runtime_task_node_revisions` 为运行时提供一致的修复身份；无投影时返回原事实。
- 原生审批哈希、Trace、Attempt、Evaluation、失败 Gate、验证失效和最终报告不回写。新的根节点仍必须真正执行验收并生成新证据，不能直接标成成功。
- 显式恢复仅支持当前已确认、停在 root_verification、尚无执行/副作用/产物或契约归属历史的冲突根节点。历史修订中该名称曾用于非根或骨架分支时拒绝；非根冲突不猜测修复。
- 活动 Attempt、跨项目请求、过期 revision、占用的规范 ID 或不安全历史会拒绝恢复。事务失败完全回滚；同一修订的恢复审计幂等且不可变。

## 操作方式

先停止目标项目后续操作，保留原树，不改规划、不重建树、不归档。建议先对数据库副本做回放。

只读预览（硬只读连接，不更新 schema、不创建项目标记）：

```bash
node plugin/runtime/cli.mjs tree repair-identities <treeId> --cwd <项目目录> --json
```

查看 `treeRevisionId`、`conflicts`、`blockers` 和 `canApply`。必须先取得用户对真实数据恢复的明确授权。

执行时必须使用刚检查过的 revision 和一个尚不存在的绝对备份文件路径：

```bash
node plugin/runtime/cli.mjs tree repair-identities <treeId> \
  --cwd <项目目录> --apply --expected-revision <revisionId> \
  --backup /absolute/path/runtime-before-identity-repair.db --json
```

CLI 会用 SQLite 快照备份提交的 WAL 内容，拒绝覆盖已有文件，然后在事务中重新检查并应用。普通 Runtime 打开会安装新增 schema；备份在身份恢复前创建，保留原始规划和执行事实。恢复与规划审批不是同一动作，不要求再批准一次实现规划。

更新插件后完全重启 Claude Code，再发：`继续计数器，完成根验收和最终报告。` 查询应看到原 treeId / revision、原四个 verified 分支，新的隔离根节点可执行。Agent 必须实际验证后提交根阶段门与 Final Report；不能把隔离回放的模拟证据当成真实验收。

## 验证

`npm run check` 覆盖同项目/跨项目重名、稳定身份与引用映射、原树状态保护、只读 v25 预览、备份、旧根恢复、历史安全拒绝、事务回滚、幂等重启、根验证与 Final Report。JEV 的开关和配置未变更。
