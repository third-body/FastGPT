# 本地部署升级方案（v4.15.2 → 4.17.0 + 多用户）

- 状态：**已上线**。正式环境已切换至 4.17.0 + 多用户，2026-09-04 22:49 完成
- 创建时间：2026-09-04
- 关联：[多用户单团队设计](./design.md)

## 1. 升级前的现状

| 项 | 值 |
|---|---|
| 运行版本 | `ghcr.io/labring/fastgpt:v4.15.2` |
| 目标版本 | 源码 4.17.0（未发布，无官方镜像，需本地构建） |
| 版本差距 | 214 个提交 / 3326 文件 / +212688 −84932 |
| compose | `~/Dev/github/m3/docker/docker-compose.fastgpt.yml`（m3 仓库） |
| compose 项目名 | `fastgpt` |
| 宿主架构 | arm64（Apple Silicon） |
| 对外端口 | 仅 `3000:3000`（app），MinIO 不映射 |

### 数据卷（全部数据的实际所在）

```
fastgpt_fastgpt-mongo        业务主库 + fastgpt-plugin 库
fastgpt_fastgpt-pg           向量库（pgvector）
fastgpt_fastgpt-aiproxy_pg   aiproxy 渠道/日志库
fastgpt_fastgpt-minio        文件对象存储
fastgpt_fastgpt-redis        会话/缓存（可重建）
```

## 2. 为什么不能直接装多用户功能

多用户实现依赖的模块在 v4.15.2 中**不存在**：

```
packages/service/support/permission/resourcePermissionService.ts   ❌
packages/global/openapi/support/user/team/member/api.ts            ❌
packages/service/support/user/team/fallback.ts                     ❌
```

v4.15 使用另一套权限实现。因此「装功能」必然伴随「升版本」，两者无法拆开。

## 3. 升级策略：并行验证后切换

不直接改动正式环境，而是先用**同一份数据**起一套隔离的验证环境，确认迁移与功能都正常，再决定切换。

```
正式环境 fastgpt (:3000)          验证环境 fgnext (:3001)
├─ fastgpt-app  v4.15.2           ├─ fgnext-app  4.17.0-multiuser
├─ fastgpt-mongo                  ├─ fgnext-mongo
└─ 卷 fastgpt_*      ──逻辑备份──> └─ 卷 fgnext_*
   （全程不受影响）                   （数据同源，独立卷）
```

### 隔离手段

| 维度 | 手段 |
|---|---|
| 数据卷 | compose 项目名 `fgnext`，卷自动前缀为 `fgnext_*`，与 `fastgpt_*` 物理隔离 |
| 网络 | 同上，项目级隔离 |
| 容器名 | `container_name` 是全局唯一的，统一改前缀 `fastgpt-` → `fgnext-` |
| 端口 | app 映射改为 `3001:3000` |
| 服务名 | **保持不变**，故所有连接串（`fastgpt-mongo` 等）无需修改，容器内 DNS 按服务名解析 |

## 4. 数据安全设计

### 4.1 备份方式：逻辑备份，不停机

| 组件 | 方式 | 理由 |
|---|---|---|
| MongoDB | `mongodump --archive --gzip` | 官方备份工具，运行中导出安全；单文件含全部库 |
| pgvector | `pg_dumpall` | MVCC 快照，导出完全一致 |
| aiproxy-pg | `pg_dumpall` | 同上 |
| MinIO | 卷级 `tar`（**只读**挂载） | 对象写入后不可变，只读打包不影响运行中的服务 |
| Redis | 不备份 | 仅存会话与缓存，重建即可（代价是需重新登录） |

选择逻辑备份而非停机拷卷的原因：正式环境全程无需停止，且导出的文件本身就是一份可随时恢复的备份。

### 4.2 恢复的幂等性

- `mongorestore --drop`：恢复前删除同名集合，重复执行不残留旧数据
- MinIO 恢复前清空目标卷，避免新旧对象混杂

### 4.3 回滚路径

`promote` 切换正式环境前会自动再备份一次，并记录切换前的镜像标签到 `PREVIOUS_APP_IMAGE`。回滚时：

1. 停 app（避免恢复期间有写入）
2. compose 镜像改回旧标签
3. 恢复该备份点的全部数据
4. 重启 app

## 5. 一键工具

`~/Dev/github/m3/docker/fastgpt-upgrade.sh`

| 命令 | 作用 |
|---|---|
| `backup` | 仅备份正式环境 |
| `build` | 从源码构建 `fastgpt-local:4.17.0-multiuser` |
| `stage` | 备份 + 构建 + 起验证环境(3001) + 恢复数据（**一条命令完成验证环境搭建**） |
| `verify` | 检查验证环境健康、迁移日志、接口连通性 |
| `promote` | 备份 + 把正式环境(3000)切到新镜像 |
| `rollback [备份目录]` | 用备份恢复正式环境并回退镜像 |
| `destroy-stage` | 销毁验证环境及其卷 |

备份根目录：`~/fastgpt-backup/<时间戳>/`，`LATEST` 文件记录最近一次备份路径。

## 6. 迁移风险

4.17 带 6 个会**改写数据**的迁移任务，由 `instrumentation-node.ts` 在应用启动时自动执行，阻塞式迁移会等待完成：

```
20260903_migrate_legacy_system_models          迁移历史系统模型
20260903_backfill_model_permissions            回填模型权限
20260903_backfill_dataset_model_references     回填知识库模型引用
20260903_backfill_evaluation_model_references  回填评测模型引用
20260903_backfill_app_model_references         回填应用模型引用
4170/20260903_backfill_app_create_time         回填应用创建时间
```

**未经验证的风险点**：官方是否支持 4.15.2 直接跳到 4.17，是否需要中间版本过渡，我没有找到证据。这正是要先在验证环境跑一遍的原因——如果迁移在验证环境失败，正式环境完全不受影响。

## 7. 构建环境要求（踩坑记录）

### 7.1 Docker 内存必须 ≥ 12GB

首次构建在 `RUN pnpm --filter=app build` 阶段被内核 SIGKILL：

```
Command failed with signal "SIGKILL"
ERROR: ResourceExhausted: cannot allocate memory
```

原因：Docker Desktop 默认只给 VM 分配 7.8GB，而 Next.js 会按 CPU 核数（本机配置 6 核）拉起并行 worker，叠加 Dockerfile 中的 `NODE_OPTIONS=--max-old-space-size=4096`，峰值超出 VM 上限。

处理：把 `~/Library/Group Containers/group.com.docker/settings-store.json` 的 `MemoryMiB` 调到 `12288`、`SwapMiB` 调到 `2048`，重启 Docker Desktop 生效（VM 实测 11.7GB）。原配置文件已备份为 `settings-store.json.bak-<时间戳>`。

### 7.2 重启 Docker 的副作用

fastgpt stack 全部服务带 `restart: always`，重启后 9/9 自动恢复健康。
但 **m3 stack 的 6 个容器没有该策略，不会自动回来**，需手动 `docker start`：

```
m3-coturn-1  m3-meilisearch-1  m3-minio-1  m3-postgres-1  m3-scylla-1  m3-redis-1
```

后续若再需重启 Docker，记得一并拉起这 6 个。

### 7.3 为什么不能在宿主机构建后打包

看似可以用宿主机 24GB 内存跑 `pnpm build` 再把产物拷进镜像，但 `node_modules` 含平台相关的原生二进制（macOS arm64），塞进 Alpine Linux 容器会在运行时崩溃。必须在容器内构建。

## 8. 事故记录：并行环境串扰到正式库（重要）

### 8.1 现象

验证环境（fgnext）的 4.17 应用连到了**正式环境的 MongoDB**，在正式库里创建了 4.17 的迁移产物。

表面症状极具迷惑性，排查中一度误判了三次：
- 登录间歇性失败（`account_psw_error`）→ 误以为是登录限流
- 应用列表时有时无 → 误以为是 cookie 过期
- 迁移反复丢 lease → 误以为是 4.17 的迁移管理器缺陷
- 日志中 `No keys found for HMAC` → 误以为是备份包含 `admin.system.keys` 所致

真正的根因只有一个：两套 stack 共用同一 Docker 网络，`fastgpt-mongo` 这个 DNS 名同时对应两个容器，请求被随机路由到任意一边。

### 8.2 根因

原 compose 的网络段用 **固定 `name:`** 声明：

```yaml
networks:
  data:
    name: fastgpt_data     # ← 固定名，不受 -p 项目名影响
```

因此 `docker compose -p fgnext` **只隔离了数据卷（`fgnext_*`），没有隔离网络**。
两套 stack 都挂在 `fastgpt_data` 上后：
- 正式容器名 `fastgpt-mongo` 与验证环境的**服务名** `fastgpt-mongo` 在同一网络内冲突；
- Docker DNS 把 `fastgpt-mongo` 解析到任意一个（实测验证环境应用解析到了正式库 172.22.0.4）。

**教训：并行环境隔离必须同时验证卷和网络。我当时只查了卷。**

### 8.3 修复

验证环境 compose 的网络改为独立命名：

```yaml
networks:
  data:
    name: fgnext_data
  app:
    name: fgnext_app
  codesandbox:
    name: fgnext_codesandbox
  aiproxy:
    name: fgnext_aiproxy
```

**启动应用前必须先验证隔离**（这一步不能省）：

```bash
docker run --rm --network fgnext_data  alpine getent hosts fastgpt-mongo   # 应为 fgnext-mongo 的 IP
docker run --rm --network fastgpt_data alpine getent hosts fastgpt-mongo   # 应为 fastgpt-mongo 的 IP
```

### 8.4 对正式环境的实际影响与处置

**业务数据零损失**，因为 5 个回填类迁移全部停在 `pending`、1 个卡在 `running`，**没有一个 `succeeded`**，改写业务数据的逻辑根本没执行。

被写入的只有 9 个 4.17 新集合：

| 集合 | 条数 |
|---|---|
| `ai_models` | 288 |
| `system_migration_states` | 6 |
| 其余 7 个（account_cancellation、agent_sandbox_instances_v2、ai_default_models、full_text_migration_faileds、full_text_migration_logs、system_migration_failed_records、tmp_datas） | 均为 0 |

处置：先做安全备份（`~/fastgpt-backup/pre-cleanup-*`），再外科式删除这 9 个集合。删除后集合数由 71 回到 **62**，与升级前完全一致；`users/teams/apps/datasets/app_versions` 计数不变，`chats/chatitems/usages` 因期间正常使用而略增。正式环境重启后 HTTP 200。

### 8.5 隔离修复后的复验结果

在真正隔离的环境重跑，此前所有"诡异现象"全部消失：

| 项 | 修复前 | 修复后 |
|---|---|---|
| 6 个迁移 | 反复丢 lease，需重启才完成 | **一次性全部 succeeded** |
| `No keys found for HMAC` | 27+ 次 | **0 次** |
| 登录 | 间歇失败 | 稳定 |
| 应用列表 | 0/1 跳变 | 稳定 |

结论：4.17 的迁移管理器本身没有问题，`No keys found for HMAC` 也不是备份缺陷导致——都是网络串扰的伴生现象。
（注：8.2 之前认定的"备份包含 admin.system.keys"仍是真实缺陷，已修复，只是并非本次现象的主因。）

## 9. 端到端验收结果（隔离修复后）

环境：`http://localhost:3005`，镜像 `fastgpt-local:4.17.0-multiuser`，数据来自正式环境备份。

### 9.1 升级本身

| 检查项 | 结果 |
|---|---|
| 6 个数据迁移 | ✅ 一次性全部 succeeded，无需重启 |
| `system_migration_failed_records` | ✅ 0 |
| `No keys found for HMAC` | ✅ 0 次 |
| 迁移前后集合文档数 | ✅ 无任何减少，仅新增（`ai_models` +288 为迁移产物） |
| 向量库 / aiproxy / MinIO | ✅ 393 行 / 3 渠道 2455 日志 / 89 对象，与正式环境一致 |
| 正式环境全程 | ✅ HTTP 200 未受影响 |

### 9.2 多用户功能

| # | 场景 | 结果 |
|---|---|---|
| ① | 管理员建号 `wangwu` | ✅ 200 |
| ② | 团队角色值 | ✅ 28 = read(4)\|appCreate(8)\|datasetCreate(16) |
| ② | teams 总数 | ✅ 仍为 1，未产生孤岛团队 |
| ③ | 新账号登录 | ✅ 成功，进入同一 My Team |
| ④ | 新成员自建应用 | ✅ 200 |
| ⑤ | 共享前可见资源 | 仅自己的应用 |
| ⑥ | root 共享「小李」 | ✅ 200 |
| ⑦ | 共享后可见资源 | ✅ 自己的 + 小李 |
| ⑦ | 未共享的其余 4 个应用 | ✅ 仍不可见，权限隔离正确 |
| ⑧ | 管理员重置密码 | ✅ 200 |
| ⑨ | 旧密码 | ✅ 已失效（会话被强制下线） |
| ⑨ | 新密码 | ✅ 可登录 |

### 9.3 已知约束

- **`FE_DOMAIN` 必须配置**：4.17 起为必填且需合法 URL。切换正式环境前必须先给 `docker-compose.fastgpt.yml` 的 app 服务加上 `FE_DOMAIN: http://localhost:3000`，否则应用启动即崩溃重启。
- **协作者更新是覆盖式的**：`collaborator/update` 会替换该资源的全部 ACL 行，只传新成员会清掉所有者的 ACL 行。所有者仍可通过 `app.tmbId` 保有 owner 身份，故不影响访问；但前端调用时应传完整列表。
- 验证环境的 `PASSWORD_LOGIN_MINUTE_LIMIT_COUNT: 500` 仅为压制自动化脚本限流，**不要带到正式环境**。

## 10. 待办

- [x] 备份正式环境数据
- [x] 生成隔离的验证环境 compose
- [x] 编写一键升级/回滚脚本
- [x] 构建 4.17 镜像
- [x] 起验证环境并恢复数据
- [x] 确认 6 个迁移任务全部成功
- [x] 验证多用户功能（建号 → 新账号登录 → 自建应用 → 共享 → 重置密码）
- [x] 确认原有数据完整（应用、知识库、对话记录）
- [x] 修复并复验并行环境的网络隔离
- [x] 清理正式环境被写入的 9 个集合，复原为 62 集合
- [x] 补 `FE_DOMAIN` 并 promote 到正式环境


## 11. 正式环境上线记录（2026-09-04 22:49）

### 11.1 变更内容

1. `docker-compose.fastgpt.yml` 补 `FE_DOMAIN: http://localhost:3000`（改动仅 1 处，原文件备份为 `.bak-pre-promote-*`）
2. `./fastgpt-upgrade.sh promote` 切换 app 镜像：
   `ghcr.io/labring/fastgpt:v4.15.2` → `fastgpt-local:4.17.0-multiuser`

### 11.2 结果

| 检查项 | 结果 |
|---|---|
| 6 个数据迁移 | ✅ 全部 succeeded，一次通过无需重启 |
| `system_migration_failed_records` | ✅ 0 |
| 应用健康 | ✅ HTTP 200，9/9 容器健康，日志 0 错误 |
| 业务数据 | ✅ users/teams/apps/datasets/dataset_datas/chats/chatitems/app_versions **全部一字不差** |
| 向量库 | ✅ modeldata 393 行 |
| aiproxy | ✅ 3 渠道 / 2487 日志 |

### 11.3 上线后功能实测

建号 → 团队数仍为 1、角色值 28 → 新账号登录 → 共享前可见 0 个 → root 共享「小李」→ 可见 1 个。全部通过。
测试账号 `testuser` 及其 ACL 已彻底清除，最终 `users=1 team_members=1 teams=1`。

### 11.4 回滚方式

```bash
cd ~/Dev/github/m3/docker
./fastgpt-upgrade.sh rollback /Users/joe/fastgpt-backup/20260904-224954
```

该备份于 promote 前自动生成，含切换前的镜像标签（`PREVIOUS_APP_IMAGE`）。回滚会停应用、还原数据、把 compose 镜像改回 v4.15.2。

### 11.5 备份清单

| 目录 | 说明 |
|---|---|
| `20260904-202840` | 最初的完整备份（含 admin 库，**勿用于恢复**，仅留档） |
| `20260904-220336` | 修正脚本后的第一份干净备份 |
| `pre-cleanup-20260904-223849` | 清理正式库 9 个集合前的安全备份 |
| `20260904-224954` | **promote 前的回滚点（推荐）** |

### 11.6 后续注意

- 再次升级时先跑 `./fastgpt-upgrade.sh stage` 在 3005 验证，**启动应用前务必执行 §8.3 的网络隔离检查**
- 验证环境的 `PASSWORD_LOGIN_MINUTE_LIMIT_COUNT: 500` 是压制自动化脚本限流用的，**不要带进正式环境**（当前正式 compose 未包含）
- 若日后对外提供访问，`FE_DOMAIN` 需改为实际域名
