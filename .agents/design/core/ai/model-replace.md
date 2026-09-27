# 一键替换模型 需求设计

> 状态：已实现，待验收
> 关联：[模型引用统一为 modelId 设计](./model-id-reference-migration.md)

## 1. 背景

模型引用统一为 `modelId`（即 `ai_models._id`）后，知识库、工作流、评测等资源只保存模型 ID。
一旦某个模型不可用（停用、删除、上游渠道下线），所有引用它的资源都会在运行或编辑时报
“模型不存在”，管理员只能逐个打开知识库、逐个工作流节点手动修改。

实际案例：AI Proxy 中 `openai/gpt-5.6-*`、`openrouter-gpt-4o`、`text-embedding-3-small`
渠道全部禁用，FastGPT 中对应模型停用后，多个知识库的索引模型 / 图片理解模型、多个工作流的
AI 节点全部失效。

现状调研结论：

- 删除模型是物理删除（`api/admin/settings/model/delete.ts`），停用是改 `isActive`，两者都不检查引用。
- 删除后同名重建会得到新 `_id`，旧引用无法自动恢复。
- 运行期（训练、检索、工作流调度）引用失效时直接抛 `ModelErrEnum.unExist`，不回退默认模型。
- 系统中不存在“查询模型被哪些资源引用”或“批量替换模型”的能力。
- `projects/app/src/migration/tasks/4163_model_references/` 已有按集合增量扫描、CAS 写入的
  引用改写机制，可复用其遍历与 transform 思路。

## 2. 目标

管理员在「模型配置」中，对任意模型（含已停用）执行“替换为另一个同类型模型”：

1. 预览：列出该模型在各类资源中的引用数量（可展开明细）。
2. 执行：把引用统一改写为目标模型 ID。
3. 索引模型（embedding）替换无法直接改 ID（向量不兼容），改为对每个受影响知识库触发“重建索引”。
4. 输出结果：成功 / 跳过 / 失败数量及原因。

## 3. 非目标

- 不做运行时自动回退默认模型（静默换模型会改变结果，且 embedding 无法回退）。
- 不做删除保护、软删除复用旧 ID（本期不做，可作为后续）。
- 不改写历史 Usage 记录。

## 4. 引用位置清单（替换范围）

| 数据位置 | 字段 | 模型类型 | 处理方式 |
|---|---|---|---|
| `datasets` | `agentModelId` | llm | 直接改 ID |
| `datasets` | `vlmModelId` | llm（需 vision） | 直接改 ID |
| `datasets` | `vectorModelId` | embedding | 触发重建索引 |
| `apps.modules` | `aiModelId`、`datasetSearchRerankModelId`、`datasetSearchExtensionModelId`、`datasetDeepSearchModelId` | llm / rerank | 直接改 ID |
| `apps.modules` Agent 节点 `datasetParams` | `rerankModelId`、`datasetSearchExtensionModelId` | rerank / llm | 直接改 ID |
| `app_versions.nodes` | 同 `apps.modules` | 同上 | 直接改 ID（见问题 Q2） |
| `apps.chatConfig` | `questionGuide.modelId`、`ttsConfig.modelId` | llm / tts | 直接改 ID |
| `app_versions.chatConfig` | 同上 | 同上 | 同 Q2 |
| `eval` | `evalModelId` | llm | 直接改 ID |
| `ai_default_models` | 各默认槽位 | 各类型 | 直接改 ID |
| 模型权限 `resource_permissions`（resourceType=model） | `resourceId` | - | 见问题 Q5 |

同时遗留的 legacy 字段（`agentModel`、`aiModel` 等）若仍存在且指向源模型，一并按新 ID 改写并移除 legacy 值，
避免 `*ModelId` 缺失时回退到旧字符串。

## 5. 约束

- 仅 root / 系统管理员可操作，跨所有团队生效。
- 源、目标模型类型必须一致；目标必须处于启用状态；替换 VLM 时目标必须 `config.vision = true`。
- 改写使用 CAS（按读取时的旧值条件更新），避免覆盖并发编辑。
- 索引模型重建：
  - 复用 `rebuildEmbedding` 的逻辑（抽取为 service 函数），按知识库逐个触发。
  - 知识库正在训练或重建中的，跳过并在结果中标注，可稍后再次执行。
  - 重建会产生向量计费，预览阶段提示受影响的数据条数。
- 执行过程可能较长（大量工作流版本），需异步执行并可查询进度。

## 6. 交互草案

1. 「模型配置」每行增加“替换”操作（已停用模型也可见，需取消“只看已启用”）。
2. 弹窗：选择目标模型（仅列同类型、已启用）→ 点击“预览”显示各类引用计数。
3. 确认后执行，显示进度与结果；结果中可查看跳过/失败明细。
4. 可选勾选：替换完成后停用源模型。

## 7. 已确认决策

| 问题 | 结论 |
|---|---|
| 入口与权限 | 「模型配置」行操作，仅系统管理员（`authSystemAdmin`） |
| 工作流版本范围 | 草稿 `apps` + 全部历史版本 `app_versions`（含 `app_templates`） |
| 索引模型 | 自动为所有受影响知识库触发重建；训练/重建中的跳过并报告 |
| 执行方式 | 同步执行，接口直接返回结果 |
| 模型权限 | 不复制；预览时提示目标模型是否设置了成员限制 |
| VLM 目标无视觉能力 | 清空该知识库的 `vlmModelId`（及 legacy `vlmModel`） |
| 已删除模型 | 本期不支持，源模型必须仍存在于模型配置中（可为停用状态） |

## 8. 开发设计

### 8.1 接口

均放在 `projects/app/src/pages/api/admin/settings/model/`，合约定义在
`packages/global/openapi/admin/core/ai/model/api.ts`，入参用 `parseApiInput`。

| 接口 | 方法 | 入参 | 出参 |
|---|---|---|---|
| `replace/preview` | POST | `sourceModelId`、`targetModelId` | 各引用位置计数、受影响知识库数据条数、警告列表 |
| `replace` | POST | 同上 | 各位置 `{ matched, updated, skipped, failed }` 及跳过/失败明细 |

前置校验（两个接口共用）：

- `sourceModelId !== targetModelId`；
- 目标模型存在、启用；
- 源模型必须存在（允许已停用），类型必须与目标一致；
- embedding 与非 embedding 不可互换。

### 8.2 服务层

新增 `packages/service/core/ai/replace/`：

- `utils.ts`：纯函数，入参为记录 + `{ sourceModelId, targetModelId, sourceModel?, targetModel }`，
  返回 `{ set, unset, changed }`，便于单测。
  - `replaceFlatFields(record, fields)`：`record[field] === sourceModelId` 时改为目标 ID；
    对应 legacy 字段（如 `agentModel`）若等于源模型的 `model` 字符串且 ID 字段缺失，同样写入目标 ID。
  - `replaceWorkflowNodes(nodes)`：遍历 `workflowModelKeyMappings` 中的 ID 输入，值等于源 ID 且不是
    reference/动态引用（`{{...}}`）时改写；仅有 legacy 输入且值等于源 `model` 时追加 ID 输入；
    Agent 节点 `datasetParams.rerankModelId / datasetSearchExtensionModelId` 同理。
  - `replaceChatConfig(chatConfig)`：`questionGuide.modelId`、`ttsConfig.modelId`。
- `service.ts`：`replaceSystemModel({ dryRun })`，预览与执行共用一套扫描逻辑，按集合游标扫描：
  - 查询条件用 `$in: [sourceModelId, ObjectId(sourceModelId)]` 兼容历史 ObjectId 存储；
    知识库/评测先用原生 collection 取候选 `_id`（Mongoose 会把 String 字段的查询值强转为字符串），
    ID 字段缺失或为 null 时按 legacy model 标识匹配；
    工作流集合无法按嵌套值精确索引，按 `teamId` 无关的全表游标扫描 + 内存 transform。
  - 工作流集合使用原生 collection 读写，避免 Mongoose 按 Schema 改写历史节点结构；
    未做 CAS：管理员同步操作窗口很短，与在线编辑冲突时以后写入者为准。
- 知识库 `vectorModelId`：抽取 `rebuildEmbedding.ts` 主体为
  `packages/service/core/dataset/training/service.ts#rebuildDatasetEmbedding`，
  API 与替换共用；替换时以 `dataset.tmbId` 计费（归属知识库所有者团队）。
  文本理解模型只用于账单归类，已失效时退回系统默认文本模型；失效的图片理解模型按未配置处理。
- 知识库 `vlmModelId`：目标不支持视觉时，改为清空 `vlmModelId`（VLM 为可选配置，见 Q6）。
- 系统默认模型 `ai_default_models`：槽位等于源 ID 时改为目标 ID；`datasetImageLLM` 目标无视觉时跳过并警告。
- 执行结束调用 `updatedReloadSystemModel()` 刷新默认模型缓存。

### 8.3 前端

- `projects/app/src/pageComponents/account/model/ModelConfigTable.tsx` 行操作增加“替换”图标。
- 新增 `ReplaceModelModal.tsx`：目标选择（同类型、已启用，排除自身）→ 预览计数 → 二次确认 → 结果表。
  embedding 场景额外展示“将重建 N 个知识库、共 M 条数据，会产生向量计费”。
- `projects/app/src/web/core/ai/config.ts` 增加两个请求方法；i18n 补齐 zh-CN / en / zh-Hant / ko-KR 文案。

### 8.4 测试

- `transforms` 单测：各字段命中/不命中、reference 与动态引用不改、legacy 字段、Agent datasetParams、chatConfig。
- 接口测试（`projects/app/test/api/admin/settings/model/replace.test.ts`）：
  preview 计数正确；execute 改写 dataset/app/app_version/eval/默认模型；
  embedding 替换触发重建（生成 training 记录）；训练中知识库被跳过；类型不一致被拒绝。

## 9. 已知限制

- 同步执行：应用/版本集合无法按嵌套值走索引，数据量很大时预览与执行耗时较长；索引模型替换会串行
  触发每个知识库的重建初始化。前端超时 600s，需与反向代理 `proxy_read_timeout` 匹配；超时后服务端仍会
  继续执行，重复执行是幂等的（已替换的引用不再命中）。
- 仅有 legacy model 标识（无 ID）的历史引用按 model 字符串匹配；若存在多个同 model 字符串的模型，
  可能误判，概率很低。

## 10. TODO

- [x] T1 openapi 合约：preview / execute 入参出参 Schema
- [x] T2 抽取 `rebuildDatasetEmbedding` service，原 `rebuildEmbedding` API 改为调用它（回归现有测试）
- [x] T3 `replace/utils.ts` + 单测
- [x] T4 `replace/service.ts`（preview / execute 共用）
- [x] T5 API 路由 `replace/preview.ts`、`replace/index.ts`；服务层集成测试 `projects/app/test/service/core/ai/replaceModel.test.ts`
- [x] T6 前端 `ReplaceModelModal` + 行操作入口 + 请求方法
- [x] T7 i18n（zh-CN / en / zh-Hant / ko-KR）
- [x] T8 类型检查 + 局部测试（本功能相关测试文件）
