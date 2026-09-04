# 开源版多用户单团队方案设计

- 状态：已实现（待端到端人工验收）
- 创建时间：2026-09-04
- 范围：开源版 FastGPT 支持「多个用户账号登录，共处同一个团队协作」
- 参考：https://cloud.tencent.com/developer/article/2457036（思路参考，实现不采用其裸插数据库的做法，原因见「与参考文章的差异」）

## 1. 需求

### 1.1 目标

当前开源版启动时只通过 `initRootUser` 创建 `root` 一个账号，其余账号相关能力全部转发到闭源商业版服务。本方案要在**不引入商业版服务**的前提下，让开源版支持：

1. 存在多个用户账号，每个账号可用「用户名 + 密码」独立登录。
2. 所有账号同处 `root` 所在的同一个团队，共享并协作应用、知识库等资源。
3. 管理员（团队 owner / 具备团队管理权限的成员）可在「账号 - 团队」页完成成员的增删改查。

### 1.2 明确不做（本期范围外）

| 项 | 说明 |
|---|---|
| 多团队 | 不做团队创建、列表、切换、转让。全系统只有 root 初始化出的那一个团队 |
| 邀请链接自助注册 | 账号一律由管理员后台创建，不做 `invitationLink` 系列接口和注册页 |
| 权限管理 tab | `PermissionManage` 保持走 proApi（未配置则不可用） |
| 成员组 / 组织架构 tab | `GroupManage`、`OrgManage` 同上 |
| 三方登录 | OAuth、企微、公众号扫码等一律不做 |
| 计费与套餐 | `getTeamPlanStatus` 等维持现状 |

### 1.3 使用约束

FastGPT 采用 Apache 2.0 + 附加条款，附加条款**禁止将其用于商业化多租户 SaaS 售卖**。本方案定位为组织内部自建部署自用，不对外提供多租户服务。

## 2. 现状分析

结论先行：**多用户单团队所需的数据模型、权限体系、API 契约、前端 UI 全部已在开源仓库内，唯一缺失的是 API handler 实现文件。**

### 2.1 已具备的能力

| 层 | 位置 | 状态 |
|---|---|---|
| 用户表 | `packages/service/support/user/schema.ts` | ✅ |
| 团队表 / 成员表 | `packages/service/support/user/team/{teamSchema,teamMemberSchema}.ts` | ✅ |
| 成员组 / 组织表 | `packages/service/support/permission/{memberGroup,org}/` | ✅ |
| 资源权限体系 | `packages/service/support/permission/resourcePermissionService.ts`、`inheritPermission.ts`、`TeamPermission` | ✅ |
| 权限校验入口 | `authUserPer({ req, authToken: true, per: ManagePermissionVal })` | ✅ |
| 登录会话 | `loginByPassword.ts` + `createUserSession`（`userId/teamId/tmbId` 三元组） | ✅ |
| API 契约（Zod 出入参 + 路由声明） | `packages/global/openapi/support/user/team/member/{api,index}.ts` | ✅ 完整，含 8 个成员接口 |
| 前端成员管理 UI | `projects/app/src/pageComponents/account/team/MemberTable.tsx` 等 | ✅ |
| 审计日志 | `addAuditLog` + `AuditEventEnum` | ✅ |

### 2.2 缺失的部分

前端 `projects/app/src/web/support/user/team/api.ts` 中成员相关请求全部指向 `/proApi/support/user/team/member/*`，由 `projects/app/src/pages/api/proApi/[...path].ts` 转发至 `FastGPTProUrl`。未配置 `PRO_URL` 时该代理直接抛错「未配置商业版链接」。

即：**缺的只是这些路由在开源侧的 handler 实现。**

### 2.3 登录链路无需改动（重要）

`loginByPassword.ts` 并未硬编码 root：

- 通过 `passwordVerificationService` 校验任意用户的用户名密码；
- 调用 `getUserDetail({ tmbId: user.lastLoginTmbId, userId })` 解析所属团队；
- 新用户没有 `lastLoginTmbId`，会回退到 `getUserDefaultTeam` → 按 `userId + status: active` 查 `team_members`，命中我们创建的成员记录；
- `isRoot` 仅由 `username === 'root'` 判定，普通用户自然为 false。

**结论：只要 `users` 和 `team_members` 里有正确的记录，多用户登录立即可用，登录代码一行都不用改。**

## 3. 方案设计

### 3.1 核心思路：利用 Next.js 路由优先级做零侵入接管

Next.js Pages Router 中，**静态路由优先级高于 catch-all 路由**。因此在 `projects/app/src/pages/api/proApi/support/user/team/member/` 下创建具体的 handler 文件，即可自动接管对应请求，而 `[...path].ts` 代理仍负责其余未实现的 proApi 路由。

带来的好处：

- 前端 `web/support/user/team/api.ts` 的请求路径**无需修改**；
- `[...path].ts` 代理层**无需修改**；
- 契约、类型、UI 全部复用。

### 3.2 向后兼容：`withProFallback` 包装器

上述接管会带来一个副作用：**已配置 `PRO_URL` 的商业版用户，这些路由会被开源实现劫持**。

为此新增包装器 `projects/app/src/service/support/user/team/withProFallback.ts`：

```ts
/**
 * 用于 proApi 下的开源版兜底实现。
 * 已配置商业版地址时，把请求原样转发给商业版，保持原有行为不变；
 * 未配置时，走开源版本地 handler。
 */
export const withProFallback = (handler: NextApiHandler): NextApiHandler =>
  async (req, res) => {
    if (FastGPTProUrl) return proxyToPro(req, res);
    return handler(req, res);
  };
```

`proxyToPro` 从 `[...path].ts` 中抽出为共用函数，避免转发逻辑出现两份。

### 3.3 接口清单

#### A. 复用既有契约，直接补实现

| # | 路由 | 方法 | 权限 | 说明 |
|---|---|---|---|---|
| A1 | `/proApi/support/user/team/member/list` | POST | 团队成员 | 分页查成员，支持 `searchKey`、`status`、`tmbIds`、`currentFirst`。本期 `withOrgs`/`groupId`/`orgId` 入参接受但不生效（无组织/组功能） |
| A2 | `/proApi/support/user/team/member/count` | GET | 团队成员 | 统计 `status: active` 成员数 |
| A3 | `/proApi/support/user/team/member/delete` | DELETE | `ManagePermissionVal` | 移出成员；禁止移除 owner 与自己 |
| A4 | `/proApi/support/user/team/member/updateNameByManager` | PUT | `ManagePermissionVal` | 管理员改成员名 |
| A5 | `/proApi/support/user/team/member/updateName` | PUT | 本人 | 改自己的成员名 |
| A6 | `/proApi/support/user/team/member/restore` | POST | `ManagePermissionVal` | 把 `leave`/`forbidden` 恢复为 `active` |
| A7 | `/proApi/support/user/team/member/leave` | DELETE | 本人 | 主动离开；owner 不可离开 |
| A8 | `/proApi/support/user/team/list` | GET | 登录态 | 返回当前用户所在团队（单团队场景下恒为 1 条），供页头 `TeamSelector` 正常渲染 |

#### B. 需新增契约 + 实现

「root 后台建号」在商业版走的是邀请链接，开源侧无对应契约，需新增：

| # | 路由 | 方法 | 权限 | 说明 |
|---|---|---|---|---|
| B1 | `/proApi/support/user/team/member/create` | POST | `ManagePermissionVal` | 入参 `{ username, password, memberName? }`。事务内创建 `MongoUser` 并插入 `team_members`（status=active），加入当前团队 |
| B2 | `/proApi/support/user/team/member/resetPassword` | PUT | `ManagePermissionVal` | 入参 `{ tmbId, password }`。管理员重置成员密码，用于用户忘记密码 |

契约新增到 `packages/global/openapi/support/user/team/member/api.ts` 与 `index.ts`，与既有风格保持一致（Zod schema + `Route:` 注释块 + `OpenAPIPath` 注册）。

#### B1 关键实现要点

```
mongoSessionRun:
  1. 校验 username 未被占用（大小写与前后空格归一化后比较）
  2. MongoUser.create({ username, password: hashStr(password) })
  3. MongoTeamMember.create({
       teamId,            // 当前操作者所在团队，不新建团队
       userId,
       name: memberName || username,
       role: 不设 owner,
       status: TeamMemberStatusEnum.active
     })
  4. addAuditLog
```

**刻意不调用 `createDefaultTeam`** —— 那会给新用户单独建团队，导致「每人一个孤岛团队」，与本方案目标相反。

### 3.4 前端改动

改动集中在 `MemberTable.tsx`：

1. 「邀请成员」按钮当前打开 `Invite/InviteModal`（走 invitationLink）。未配置 `PRO_URL` 时改为打开新增的 `AddMemberModal`（用户名 + 初始密码 + 成员名）。
2. 成员行操作菜单新增「重置密码」（对应 B2），仅管理员可见。
3. 「同步成员」(`postSyncMembers`)、「导出成员」(`ExportMembers`) 在开源模式下隐藏。

新增组件：`projects/app/src/pageComponents/account/team/AddMemberModal.tsx`、`ResetPasswordModal.tsx`。

配套补充 i18n 文案：`packages/web/i18n/{zh-CN,en,zh-Hant,ko-KR}/account_team.json`（仓库实际有 4 种语言，含 ko-KR）。

### 3.5 与参考文章的差异

参考文章的做法是往 `users`/`teams`/`team_members` 三个集合裸插记录，并**给每个新用户单独建一个团队**。本方案有两处关键不同：

1. **文章是「多租户隔离」，不是「多人协作」**。每人一个团队意味着彼此看不到对方的应用和知识库，与本需求目标相反。本方案让所有成员共用同一个 `teamId`。
2. **文章会遗漏必要的初始化步骤**。当前版本 `createDefaultTeam()` 除建团队外还必须创建默认成员组（`MongoMemberGroupModel`）和根组织（`createRootOrg`），裸插记录会跳过这两步，导致协作者与权限相关功能异常。本方案不新建团队，直接复用 root 团队既有的组与组织，规避该问题。

文章可借鉴的部分仅为「加一个管理员专属的成员管理入口」这一形态。

## 4. 风险与注意事项

| 风险 | 处理 |
|---|---|
| 商业版用户被开源实现劫持路由 | `withProFallback` 包装，配置了 `PRO_URL` 时原样转发 |
| 明文密码经接口传输 | 沿用现有登录链路的处理方式；要求部署侧启用 HTTPS。初始密码由管理员设置并线下告知 |
| 越权操作 | 所有管理类接口一律 `authUserPer({ per: ManagePermissionVal })`；删除/改名前校验目标成员 `teamId` 与操作者一致，防止跨团队越权 |
| owner 被误删或误离队 | A3/A7 显式拦截 `role === owner` |
| 用户名冲突 | `users.username` 已有唯一索引，B1 捕获 duplicate key 错误转友好提示 |
| 索引维护 | 若涉及 Schema/索引变更，须按 AGENTS.md 用 `defineIndex` 声明，并同步登记废弃索引 |
| 升级冲突 | 新增文件为主，对既有文件的改动集中在 `MemberTable.tsx` 与 openapi 契约，冲突面可控 |

## 5. 待确认问题

1. ~~`users.username` 是否已有唯一索引？~~ **已确认**：`packages/service/support/user/schema.ts:68` 通过 `defineIndex` 声明了 `{ username: 1 }` 唯一索引。B1 只需捕获 duplicate key 错误并转为友好提示，无需额外并发保护。
2. ~~新建成员的默认团队权限？~~ **已定**：给**写权限**（`TeamWritePermissionVal`）。本期不做权限管理 tab，若默认只读则新人无处提权、会卡死。
3. ~~重置密码后是否踢下线？~~ **已定**：**踢下线**，调用 `delUserAllSession(userId)`。

## 6. TODO

### 阶段一：后端基础设施
- [x] T1 从 `pages/api/proApi/[...path].ts` 抽出 `proxyToPro` 共用函数
- [x] T2 新增 `service/support/user/team/withProFallback.ts`
- [x] T3 在 `packages/global/openapi/.../member/api.ts` 新增 B1、B2 契约
- [x] T4 在 `.../member/index.ts` 注册 B1、B2 的 `OpenAPIPath`

### 阶段二：成员查询接口
- [x] T5 实现 A1 `member/list`
- [x] T6 实现 A2 `member/count`
- [x] T7 实现 A8 `team/list`

### 阶段三：成员管理接口
- [x] T8 实现 B1 `member/create`（含用户名唯一性 + 事务）
- [x] T9 实现 A3 `member/delete`（拦截 owner / 自己）
- [x] T10 实现 A4 `member/updateNameByManager`、A5 `member/updateName`
- [x] T11 实现 A6 `member/restore`、A7 `member/leave`
- [x] T12 实现 B2 `member/resetPassword`（含会话清理）

### 阶段四：前端
- [x] T13 新增 `AddMemberModal.tsx`
- [x] T14 新增 `ResetPasswordModal.tsx`
- [x] T15 改造 `MemberTable.tsx`：按是否配置 PRO_URL 切换入口、隐藏同步/导出
- [x] T16 补 i18n 文案（zh-CN / en / zh-Hant）

### 阶段五：测试与验收
- [x] T17 补充接口单测（权限校验、owner 保护、用户名冲突、跨团队越权）
- [x] T18 运行改动范围内的局部测试
- [ ] T19 端到端手工验收：建号 → 新账号登录 → 看到同一团队资源 → 改名 → 重置密码 → 移除
      （需启动 MongoDB / Redis 及应用，尚未执行）


## 7. 实施记录

### 7.1 与设计的偏差

| 项 | 设计 | 实际 | 原因 |
|---|---|---|---|
| i18n 语言数 | 3 种 | 4 种（增加 ko-KR） | 仓库实际维护 4 种语言 |
| 建号审计事件 | 未指定 | `AdminAuditEventEnum.ADMIN_ADD_USER` | `AuditEventEnum.JOIN_TEAM` 的参数强制要求 `link`，文案为「通过邀请链接【X】加入团队」，与管理员建号语义不符；`ADMIN_ADD_USER` 文案「创建了一个名为【X】的用户」才贴合 |
| 重置密码审计事件 | 未指定 | `AdminAuditEventEnum.ADMIN_UPDATE_USER` | `AuditEventEnum.CHANGE_PASSWORD` 语义是「本人改密」，且参数不含成员名 |
| 重置密码图标 | 未指定 | `key` | 原计划的 `common/confirm/unlock` 图标在仓库中不存在 |
| 「离开团队」按钮 | 未提及 | 开源模式下隐藏 | 单团队下退出后无其它团队可切换，且切换团队接口未实现，成员会被锁在系统外。API 仍按契约实现，仅隐藏入口 |

### 7.2 实现中发现的关键约束

**密码哈希只能发生一次，且在客户端。** `MongoUser` 的 `password` 字段带 `set: (val) => hashStr(val)` 的 Mongoose setter，写入时自动哈希；登录查询 `MongoUser.findOne({ username, password })` 的过滤条件同样会跑 setter。前端 `web/support/user/api.ts` 在提交前已调用 `hashStr`。

因此服务端在建号和重置密码时**必须原样透传客户端传来的值，不得再调用 `hashStr`**，否则会多哈希一层，导致新建账号永远登录不上。该约定已写入 `createTeamMemberAccount` 与 `resetTeamMemberPassword` 的函数注释。

### 7.3 变更文件清单

**新增**
- `packages/service/support/user/team/member/controller.ts` — 成员管理业务逻辑
- `projects/app/src/service/support/proApi/proxy.ts` — 抽出的商业版转发逻辑
- `projects/app/src/service/support/proApi/withProFallback.ts` — 开源兜底分流包装器
- `projects/app/src/pages/api/proApi/support/user/team/list.ts`
- `projects/app/src/pages/api/proApi/support/user/team/member/{list,count,create,delete,restore,leave,updateName,updateNameByManager,resetPassword}.ts`
- `projects/app/src/pageComponents/account/team/{AddMemberModal,ResetPasswordModal}.tsx`
- `projects/app/test/api/support/user/team/member/manage.test.ts`

**修改**
- `packages/global/openapi/support/user/team/member/{api,index}.ts` — 新增 create / resetPassword 契约
- `packages/web/i18n/{zh-CN,en,zh-Hant,ko-KR}/account_team.json` — 各新增 18 条文案
- `projects/app/src/pages/api/proApi/[...path].ts` — 改用抽出的 `proxyToPro`
- `projects/app/src/web/support/user/team/api.ts` — 新增 `postCreateMember` / `putResetMemberPassword`
- `projects/app/src/pageComponents/account/team/MemberTable.tsx` — 开源模式入口切换、重置密码入口、隐藏离开团队

### 7.4 验证结果

| 项 | 结果 |
|---|---|
| `pnpm typecheck`（projects/app，覆盖被引用的 service/global 代码） | 通过 |
| `eslint` 改动文件 | 通过 |
| 新增测试 `manage.test.ts` | 10/10 通过 |
| 受影响既有测试（登录、改密、tokenLogin、web api） | 60/60 通过 |
| 端到端人工验收 | **未执行**，需实际启动服务 |

新增测试覆盖：建号加入同一团队而非另建团队、成员名回退、用户名重复拒绝且无残留、禁止移除 owner、禁止移除自己、正常移除置为 leave、跨团队越权拒绝、owner 不可离开、重置密码生效、列表只返回本团队成员。


## 8. 补充：资源共享（第二轮）

### 8.1 为什么必须补

第一轮范围只做了「成员管理」，验证环境实测发现：新成员登录后**看不到 root 已有的应用和知识库，且 root 也无法共享给他**——因为资源协作者接口同样是闭源的。

这不是 bug，是 FastGPT 的资源权限模型：每个资源有独立 ACL，加入团队只获得团队级权限（可创建自己的资源），不自动获得他人已有资源的访问权。但共享入口缺失，导致「多人协作」实际不成立。

### 8.2 缺口全貌

以下协作者接口在开源版全部走 proApi：

```
/proApi/core/app/collaborator/{list,update}        ← 本轮实现
/proApi/core/dataset/collaborator/{list,update}    ← 本轮实现
/proApi/support/user/team/collaborator/*           团队级权限（PermissionManage tab）
/proApi/core/ai/skill/collaborator/*               技能共享
/proApi/system/model/collaborator/*                模型权限
```

### 8.3 实现

新增 `packages/service/support/permission/resourceCollaboratorService.ts`，app 与 dataset 共用：

| 函数 | 职责 |
|---|---|
| `getResourceCollaborators` | 读取单个资源自身的 ACL 行并转成协作者结构 |
| `getResourceCollaboratorList` | 组装列表返回值；资源处于继承状态且有父级时附带 `parentClbs` 供前端置灰 |
| `updateResourceCollaboratorList` | 覆盖式更新，事务内先读旧快照再写，并同步继承子树 |

**关键点：必须先读 `oldCollaborators` 再写。** `updateResourceCollaborators` 依赖新旧快照差分计算子资源要增删哪些权限，缺少旧快照会导致继承子树权限残留。

Handler 复用既有契约（`GetAppCollaboratorListQuerySchema` 等已在开源仓库内），一律 `authApp` / `authDataset` + `ManagePermissionVal`。

### 8.4 与设计的偏差

| 项 | 实际 | 原因 |
|---|---|---|
| `shouldInheritResourcePermission` 导入路径 | `service/.../resourcePermissionPolicy` | 不在 global 包，最初猜错 |
| `ResourceModel` 类型 | 本文件内定义 `Model<any>` | `resourcePermissionService.ts` 中是未导出的局部类型 |
| 审计参数 | 由 service 返回名称列表 | `UPDATE_APP_COLLABORATOR` 要求 `tmbList`/`groupList`/`orgList`/`permission`，需解析 ID 为名称 |

### 8.5 测试

`projects/app/test/api/proApi/core/collaborator.test.ts` 5 个用例全部通过：

- 初始无额外协作者
- 共享后 ACL 出现该成员且权限值正确
- 列表返回协作者成员名称
- 覆盖式更新会删除被移出者的 ACL
- 无管理权限成员不能修改协作者（越权防护）

合计相关测试 35/35 通过。


## 9. 第三轮：多团队模式（①基础 + ②团队权限管理）

### 9.1 范围

| 做 | 不做（仍走 proApi） |
|---|---|
| 团队 创建 / 切换 / 转让所有权 | 邀请链接（无 Schema 无 controller，需新建数据表） |
| 团队协作者 list / update / updateOne / delete | 成员组（服务层只有读函数） |
| 放开 PermissionManage tab | 组织架构（同上，且树结构写入逻辑全新） |
| | 审计日志查询、成员搜索 |

### 9.2 新增接口

| 路由 | 方法 | 权限 |
|---|---|---|
| `/proApi/support/user/team/create` | POST | 登录态 |
| `/proApi/support/user/team/switch` | PUT | 登录态 + 归属校验 |
| `/proApi/support/user/team/changeOwner` | PUT | `ManagePermissionVal` + owner 二次校验 |
| `/proApi/support/user/team/collaborator/list` | GET | `ManagePermissionVal` |
| `/proApi/support/user/team/collaborator/update` | POST | `ManagePermissionVal` |
| `/proApi/support/user/team/collaborator/updateOne` | PUT | `ManagePermissionVal` |
| `/proApi/support/user/team/collaborator/delete` | DELETE | `ManagePermissionVal` |

服务层：`packages/service/support/user/team/multiTeam/controller.ts`。
契约：`create` 为新增（`CreateTeamBodySchema`），其余复用既有定义。

### 9.3 三个关键设计点

**切换团队必须签发新会话。** `teamId/tmbId` 在登录时固化进 session，无法就地修改，故 `switch` 走 `createUserSession` + `setCookie`，并更新 `lastLoginTmbId`。目标 teamId 完全来自客户端，`assertUserInTeam` 是防止越权进入他人团队的强制关卡。

**转让所有权要迁移 ACL。** 只改 `role` 字段的话，新所有者拿不到原所有者私有资源的管理权。实现里调用 `transferTmbPermissions` 迁移资源级 ACL，并给新所有者写入团队级 owner 角色。

**创建团队必须同时建默认成员组和根组织。** 与 `createDefaultTeam` 一致——缺失会导致协作者、成员组、组织相关功能异常。测试里对默认组做了断言。

### 9.4 实现中踩的坑

**`findByTeam` 读不到团队级 ACL。** 该函数带 `$or: [{resourceId: {$exists: true}}, {resourceName: {$exists: true}}]`，是为「团队内各资源的 ACL」设计的；而团队级 ACL 由 `replaceTeam` 写入时**根本不带 `resourceId` 字段**，会被整体排除。必须改用 `findByResource`（`resourceId` 传 undefined → 过滤条件 `resourceId: null`，同时匹配 null 与字段缺失）。测试「更新团队协作者后列表应返回其名称」正是靠这条断言抓出来的。

**`CollaboratorIdType` 是 RequireOnlyOne。** 不能直接展开 `{tmbId, groupId, orgId}`（另外两个为 undefined 会类型不符），需用 `toCollaboratorId` 收敛成恰好一个字段。

**没有「团队所有权转让」的审计事件。** 硬套 `ADMIN_UPDATE_TEAM` 会要求 `teamName`/`newBalance` 等无关字段并写出误导性日志，故该接口不落审计，改由 service 层 logger 记录转让前后的 tmbId。

### 9.5 前端

`pages/account/team/index.tsx` 放开「权限管理」tab（`PermissionManage` 539 行 UI 已存在）；组织架构、成员组、审计日志仍按 `isPlus` 隐藏。
`TeamSelector`、`EditInfoModal`、`TransferOwnershipModal` 均为既有组件，无需改动。

### 9.6 测试

`projects/app/test/api/support/user/team/multiTeam.test.ts` 8 个用例全部通过：

- 创建团队后成员记录 / 默认成员组 / owner ACL 齐备
- 同一用户可拥有多个团队
- 切换到自己所属团队签发新会话并更新 `lastLoginTmbId`
- **不能切换到自己不属于的团队（越权防护）**
- 转让后角色互换，且资源级 ACL 迁移到新所有者
- 不能转让给不在本团队的用户
- 更新团队协作者后列表返回其名称
- 不能删除团队所有者的权限

合计相关测试 44/44 通过。


## 10. 第四轮：补齐 UI 依赖 + 审计日志

### 10.1 起因：两次「接口通但界面不可用」

第三轮上线后用户反馈两个问题，都是同一类失误——**只用 curl 验证接口，没在浏览器里走一遍**：

| 现象 | 根因 |
|---|---|
| 看不到「创建团队」 | 开源版 UI 里**根本没有这个按钮**。`setEditTeamData` 只在编辑现有团队时用（传 `{id}`），商业版把创建入口放在 TeamSelector 下拉里 |
| 「管理协作者」弹窗三连报错 | `MemberManager` 打开即拉 `group/list`、`org/list`，搜索框打 `searchMembersOrgsGroups`，三个都没实现 |

**教训：接口通 ≠ 界面能用。** 放开任何 UI 前，必须先列清该组件依赖的全部接口。

### 10.2 本轮新增接口

| 路由 | 说明 |
|---|---|
| `/proApi/support/user/team/group/list` | 成员组列表（只读） |
| `/proApi/support/user/team/org/list` | 部门列表（只读），无根部门时返回空数组而非报错 |
| `/proApi/support/user/team/searchMembersOrgsGroups` | 聚合搜索；成员搜索同时覆盖成员名与登录名 |
| `/proApi/support/user/team/audit/list` | 团队操作日志，需 `ManagePermissionVal` |

### 10.3 前端改动

- 团队页头部新增「+」创建团队入口，复用 `EditInfoModal`（按 `defaultData.id` 区分创建/编辑，不传 id 即创建）
- 放开「审计日志」tab（仅管理员可见）；组织架构、成员组仍按 `isPlus` 隐藏（增删改未实现）
- 套餐限制判断 `planContent && !planContent.auditLogStoreDuration` 在开源版不会拦截：`subPlans` 为空 → `planContent` 为 undefined → 条件为假

### 10.4 踩坑

**`getTeamDefaultGroup` 会自动补建默认组。** 权限解析链路（`getGroupsByTmbId`）在默认组缺失时会创建一个名为 `DEFAULT_GROUP` 的组，所以 `group/list` 返回数会比手工创建的多。测试断言据此改为「包含自建的组 + 不含其它团队的组」，而非断言总数。

### 10.5 依赖关系备查（放开 UI 前先看这张表）

| UI | 依赖接口 | 状态 |
|---|---|---|
| 成员管理 tab | `member/{list,count,create,delete,restore,updateName,updateNameByManager,resetPassword,leave}` | ✅ |
| 权限管理 tab | `team/collaborator/{list,update,updateOne,delete}` + `group/list` + `org/list` + `searchMembersOrgsGroups` | ✅ |
| 审计日志 tab | `audit/list` + `member/list`（TeamMemberFilter） | ✅ |
| 团队选择器 / 创建 / 切换 | `team/{list,create,switch,changeOwner}` | ✅ |
| 应用 / 知识库协作者 | `core/{app,dataset}/collaborator/{list,update}` + 上述三个选择器接口 | ✅ |
| 组织架构 tab | `org/{create,update,delete,move,updateMembers,deleteMember}` | ❌ 未实现，入口已隐藏 |
| 成员组 tab | `group/{create,update,delete,changeOwner}` | ❌ 未实现，入口已隐藏 |
| 邀请链接 | `invitationLink/*` | ❌ 无 Schema 无 controller，入口未启用 |

### 10.6 测试

`multiTeam.test.ts` 扩充至 18 个用例，本轮新增 9 个：

- `group/list` 返回本团队成员组 / 不返回其它团队的（越权防护）
- `org/list` 无根部门时返回空数组
- 搜索按成员名匹配 / 空关键词返回空结果 / 不跨团队
- 审计日志返回本团队记录并补全操作者 / 按事件筛选 / 不跨团队 / 空数组筛选返回空

相关测试合计 **54/54** 通过。
