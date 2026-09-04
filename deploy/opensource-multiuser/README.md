# 开源版多用户/多团队 —— 服务器部署与升级

本目录提供在自有服务器上部署本分支（开源版多用户能力）所需的工具与步骤。

## 0. 先决条件

| 项 | 要求 |
|---|---|
| Docker | 带 compose v2（`docker compose`）或 v1（`docker-compose`），脚本自适应 |
| 内存 | **仅在服务器上现构建镜像时**需要 ≥12GB；拉取现成镜像无此要求 |
| MongoDB | 容器内必须有 `mongodump`/`mongorestore`。mongo 6+ 已移除，需另装 mongodb-database-tools |
| 现有部署 | 需要一份可用的 docker-compose 文件 |

## 1. 镜像从哪来

**本分支的代码不会自动变成镜像。** 两条路：

### 方式 A：走 CI 出镜像（推荐）

仓库自带 `.github/workflows/build-fastgpt.yml`，打 `v*` tag 即触发，产出
**amd64 + arm64** 双架构镜像并推送到：

```
ghcr.io/<你的 GitHub 账号>/fastgpt:<tag>
```

运维直接 `docker pull`，与拉官方镜像无异。省去服务器构建的内存与耗时。

```bash
git push origin feat/opensource-multi-user-team
git tag v4.17.0-multiuser && git push origin v4.17.0-multiuser
```

### 方式 B：服务器上现构建

```bash
./fastgpt-upgrade.sh build ghcr.io/you/fastgpt:v4.17.0-multiuser
```

注意：
- Docker 可用内存需 ≥12GB。Next.js 构建会按 CPU 数拉起并行 worker，内存不足会被内核
  SIGKILL，报 `ResourceExhausted: cannot allocate memory`。
- **不能把其它架构构建的镜像直接搬过来**（如 Mac 的 arm64 → 服务器 amd64）。

## 2. 配置

复制 `fastgpt-upgrade.conf` 并按实际环境修改。脚本本身无需改动。

```bash
COMPOSE_FILE="/opt/fastgpt/docker-compose.yml"   # 你的 compose 路径
COMPOSE_PROJECT="fastgpt"                        # compose 项目名
BACKUP_ROOT="/data/fastgpt-backup"               # 备份目录，注意磁盘余量
APP_HEALTH_URL="https://fastgpt.example.com/api/common/system/getInitData"

SVC_APP="fastgpt-app"                            # compose 里的服务名，不是容器名
SVC_MONGO="fastgpt-mongo"
SVC_VECTOR="fastgpt-vector"
SVC_MINIO="fastgpt-minio"
SVC_AIPROXY_PG="fastgpt-aiproxy-pg"

MONGO_USER="..."                                 # 须与 compose 中一致
MONGO_PSW="..."
MONGO_DBS="fastgpt fastgpt-plugin"
PGV_USER="..."
PGA_USER="postgres"
```

> 容器名不用填。脚本通过 `docker compose ps -q <service>` 让 compose 自己解析容器，
> 数据卷通过 `docker inspect` 从挂载点反查——服务名与容器名不一致（例如服务
> `fastgpt-vector` 对应容器 `fastgpt-pg`）也能正确工作。

## 3. compose 必改项

**`FE_DOMAIN` 必须配置且为合法 URL。**

4.17 起该变量为必填（v4.15 允许留空）。留空会导致应用启动时环境变量校验失败并
**陷入重启循环**。

```yaml
  fastgpt-app:
    environment:
      FE_DOMAIN: https://fastgpt.example.com   # 填真实对外地址
```

`doctor` 会检查这一项。

## 4. 升级步骤

```bash
# ① 自检：docker/compose/FE_DOMAIN/内存/mongodump
./fastgpt-upgrade.sh doctor

# ② 升级：自动先备份 → 改 compose 镜像 → 重启 app（迁移在启动时自动执行）
./fastgpt-upgrade.sh promote ghcr.io/you/fastgpt:v4.17.0-multiuser

# ③ 验证：健康检查 + 6 个迁移是否全部 succeeded + 近期错误日志
./fastgpt-upgrade.sh verify
```

`promote` 会打印回滚点路径，请记录。

## 5. 回滚

```bash
./fastgpt-upgrade.sh rollback /data/fastgpt-backup/20260905-005218
```

会停应用 → 把 compose 的 app 镜像改回升级前的值 → 恢复全部数据 → 重启。

## 6. 备份说明

`backup` 产出：

| 文件 | 内容 |
|---|---|
| `mongo-<库名>.archive.gz` | 各业务库（默认 fastgpt、fastgpt-plugin） |
| `pg-vector.sql.gz` | 向量库 |
| `pg-aiproxy.sql.gz` | aiproxy 渠道与日志 |
| `minio-data.tar.gz` | 对象存储 |
| `PREVIOUS_APP_IMAGE` | 升级前的镜像标签，回滚用 |
| `compose.yml.snapshot` | 当时的 compose 副本 |

全程无需停机：mongodump/pg_dumpall 在运行中导出安全，MinIO 以**只读**方式打包。

**只导业务库，绝不含 admin/config/local。** `admin.system.keys` 是副本集的集群时间
签名密钥，恢复到另一套副本集会覆盖其自身密钥，导致全站
`No keys found for HMAC that is valid for time` 而接口 500。

Redis 不备份——只存会话与缓存，重建即可（代价是所有人需重新登录）。

## 7. 升级前务必知道的

**4.17 带 6 个会改写数据的迁移任务**，在应用启动时自动执行：

```
20260903_migrate_legacy_system_models          迁移历史系统模型
20260903_backfill_model_permissions            回填模型权限
20260903_backfill_dataset_model_references     回填知识库模型引用
20260903_backfill_evaluation_model_references  回填评测模型引用
20260903_backfill_app_model_references         回填应用模型引用
4170/20260903_backfill_app_create_time         回填应用创建时间
```

- 阻塞式迁移未完成时，应用**故意不进入 ready**（源码注释明确写了"失败时此 await
  按设计不返回"）。若长时间卡住，重启 app 容器可让迁移重新接管。
- 建议先在与生产数据一致的预演环境跑一遍。用 `backup` 导出生产数据、在另一套
  compose（**独立的项目名与网络**）恢复后升级验证。

**并行预演环境必须同时隔离数据卷和网络。** 若 compose 的 networks 段用了固定
`name:`，`-p <项目名>` 只会隔离卷、不隔离网络，两套 stack 会共用同一网络导致服务名
冲突、预演环境连到生产库。启动前务必验证：

```bash
docker run --rm --network <预演网络> alpine getent hosts <mongo服务名>   # 应解析到预演容器
docker run --rm --network <生产网络> alpine getent hosts <mongo服务名>   # 应解析到生产容器
```

## 8. 本次新增功能一览

| 功能 | 状态 |
|---|---|
| 管理员建号、成员改名/移除/恢复/重置密码 | 可用 |
| 多团队：创建（限 root）、切换、转让所有权 | 可用 |
| 团队权限管理（成员默认能力配置） | 可用 |
| 应用 / 知识库共享给成员 | 可用 |
| 审计日志 | 可用 |
| 组织架构、成员组的增删改 | **未实现**，入口已隐藏 |
| 邀请链接自助注册 | **未实现** |

设计与踩坑记录见 `.agents/design/support/multi-user-single-team/`。
