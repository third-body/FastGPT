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

**使用 `.github/workflows/build-fastgpt-fork.yml`，不要用官方的 `build-fastgpt.yml`。**
官方那份会推阿里云和 Docker Hub，用的是上游仓库的 secrets，fork 不会继承，
且 `Login to Ali Hub` 步骤没有 `if` 保护，在 fork 中必然失败。

fork 专用版只推 GHCR、只构建 `fastgpt` 一个镜像、默认单 amd64 架构。

```bash
git push origin feat/opensource-multi-user-team
git tag v4.17.0-multiuser && git push origin v4.17.0-multiuser
```

产物：

```
ghcr.io/<账号或组织名>/fastgpt:v4.17.0-multiuser
ghcr.io/<账号或组织名>/fastgpt:latest
```

也可在 Actions 页面手动触发（workflow_dispatch），自行填标签、按需切换到
`linux/amd64,linux/arm64` 双架构。

#### 首次推送后必做

GHCR 的包**默认是 private**，即使仓库是公开的。服务器直接 `docker pull` 会 401。
二选一：

- 在 `https://github.com/orgs/<组织名>/packages`（个人账号则是 `/users/<用户名>/packages`）
  找到 `fastgpt` 包 → Package settings → Change visibility → **Public**，之后服务器免登录拉取
- 或保持 private，服务器用具备 `read:packages` 权限的 PAT 登录：
  `docker login ghcr.io -u <用户名> -p <PAT>`

#### 仓库在组织下时的额外检查

组织比个人账号多两层限制，**打 tag 前先确认，否则会白跑一次**：

- Settings → Actions → General → **Actions permissions** 需允许第三方 action
  （本 workflow 用到 `actions/checkout`、`docker/login-action`、`docker/build-push-action`）
- 组织若限制 Actions 创建包，首次推送会 403；workflow 已声明 `permissions: packages: write`

费用：公开仓库的 Actions 免费不限量；私有仓库走**组织**的额度（Free 计划 2000 分钟/月）。

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

## 8. nginx 反向代理

模板见 `nginx-fastgpt.conf`。

已验证：
- 语法在 nginx **1.20 / 1.22 / 1.24 / 1.29** 上均通过（`http2 on;` 是 1.25.1+ 才有的
  指令，模板改用 `listen 443 ssl http2;` 兼容写法，Ubuntu 22.04、Debian 12 自带版本可直接用）
- 起真实 nginx + 模拟 SSE 源端做流量测试：五条消息按 292/300/327/264ms 间隔逐条到达，
  确认 `proxy_buffering off` 生效；`x-real-ip`、`x-forwarded-for`、`x-forwarded-proto`
  均正确透传

**前置要求**：模板用到 `$connection_upgrade`，必须在 `nginx.conf` 的 http 块中定义，
否则启动报 `unknown variable connection_upgrade`：

```nginx
http {
    map $http_upgrade $connection_upgrade {
        default upgrade;
        ''      close;
    }
    include /etc/nginx/conf.d/*.conf;
}
```

**必改三处**：`server_name`、`ssl_certificate*`、`upstream fastgpt` 的地址。

**改完必须同步 `FE_DOMAIN`**，填用户浏览器实际访问的地址（含协议）：

```yaml
FE_DOMAIN: https://fastgpt.example.com   # 不是容器内部地址，不是 ip:port
```

`FE_DOMAIN` 是运行时读取的，改完只需重启 app，无需重新构建镜像：

```bash
docker compose -p fastgpt -f <compose> up -d fastgpt-app
```

### 针对 FastGPT 的几处关键配置

| 配置 | 原因 |
|---|---|
| `proxy_buffering off` | 对话走 SSE 流式返回。开启缓冲会让响应被攒在 nginx 内存里一次性吐出，前端表现为「长时间无响应后突然全部出现」 |
| `client_max_body_size 1024m` | 知识库上传上限由 `UPLOAD_FILE_MAX_SIZE` 控制（默认 1000MB），nginx 侧不放开会被 413 拦下 |
| `proxy_read_timeout 600s` | 知识库训练、长对话可能持续数分钟 |
| `X-Real-IP` / `X-Forwarded-For` | FastGPT 优先按 `x-real-ip` 解析客户端 IP，用于登录会话与审计日志。缺失会把所有人记录成 nginx 的内网地址 |

模板末尾的 `/d/{signedAlias}` 段是**可选**的，仅在配置了
`FILE_DOWNLOAD_PUBLIC_URL_PREFIX` 时才需要；未配置请整段删除。

## 9. 已知历史数据问题：chatConfig 中的 null

**症状**：打开某些应用（尤其是 v4.15 及更早创建的）时报

```
Invalid input: expected object, received null   path: ["chatConfig","questionGuide"]
```

**原因**：v4.15 及更早版本会把未配置的 `chatConfig` 子项显式存为 `null`，
而 4.17 的 Zod schema 用 `z.optional()`——它只接受 `undefined`，不接受 `null`。
与权限、协作者功能无关，只是升级后才暴露的历史数据不兼容。

受影响的不止 `questionGuide`，`chatConfig` 下 11 个子项都可能中招。

**修复**：用 `fix-null-chatconfig.js` 把这些 null 字段 `$unset` 掉。

```bash
# 0. 先备份
./fastgpt-upgrade.sh backup

# 1. 拷进容器（旧版 mongo shell 从 stdin 读会按行解析，块注释会失败）
docker cp fix-null-chatconfig.js <mongo容器>:/tmp/

# 2. 预演，只统计不修改
docker exec <mongo容器> mongo -u <user> -p <psw> \
  --authenticationDatabase admin fastgpt /tmp/fix-null-chatconfig.js

# 3. 确认无误后把脚本里的 DRY_RUN 改为 false，重复步骤 1-2
```

脚本幂等，重复执行安全。4.17 的写入路径不会再产生 null，只需执行一次。

**为什么不改 schema**：`.nullish()` 会把 `null` 引入推导类型，实测导致 11 个文件
共 20+ 处下游报错；`z.preprocess` 归一化则会让字段类型退化为 `unknown` 并失去
可选性。两种方案都试过并回退，清理数据的改动面最小。

## 10. 本次新增功能一览

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
