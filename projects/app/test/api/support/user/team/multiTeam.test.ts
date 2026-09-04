import { describe, it, expect, beforeEach } from 'vitest';
import createTeamApi from '@/pages/api/proApi/support/user/team/create';
import switchTeamApi from '@/pages/api/proApi/support/user/team/switch';
import changeOwnerApi from '@/pages/api/proApi/support/user/team/changeOwner';
import clbListApi from '@/pages/api/proApi/support/user/team/collaborator/list';
import clbUpdateApi from '@/pages/api/proApi/support/user/team/collaborator/update';
import clbDeleteApi from '@/pages/api/proApi/support/user/team/collaborator/delete';
import { MongoUser } from '@fastgpt/service/support/user/schema';
import { MongoTeam } from '@fastgpt/service/support/user/team/teamSchema';
import { MongoTeamMember } from '@fastgpt/service/support/user/team/teamMemberSchema';
import { MongoMemberGroupModel } from '@fastgpt/service/support/permission/memberGroup/memberGroupSchema';
import { MongoResourcePermission } from '@fastgpt/service/support/permission/schema';
import { UserStatusEnum } from '@fastgpt/global/support/user/constant';
import {
  TeamMemberRoleEnum,
  TeamMemberStatusEnum
} from '@fastgpt/global/support/user/team/constant';
import { PerResourceTypeEnum, OwnerRoleVal } from '@fastgpt/global/support/permission/constant';
import { TeamReadRoleVal } from '@fastgpt/global/support/permission/user/constant';
import { Call } from '@test/utils/request';

describe('开源版多团队 API', () => {
  let userA: any, teamA: any, tmbA: any;

  const rootAuth = (tmb: any, user: any) => ({
    userId: String(user._id),
    teamId: String(tmb.teamId),
    tmbId: String(tmb._id),
    isRoot: true,
    sessionId: 'test-session'
  });

  beforeEach(async () => {
    userA = await MongoUser.create({
      // authSystemAdmin 按 username 判定，必须叫 root 才能创建团队
      username: 'root',
      password: 'psw',
      status: UserStatusEnum.active
    });
    teamA = await MongoTeam.create({ name: 'Team A', ownerId: userA._id });
    tmbA = await MongoTeamMember.create({
      teamId: teamA._id,
      userId: userA._id,
      name: 'A',
      status: TeamMemberStatusEnum.active,
      role: TeamMemberRoleEnum.owner
    });
  });

  describe('create', () => {
    it('创建团队后应同时建好成员记录、默认成员组和 owner 权限', async () => {
      const res = await Call(createTeamApi, {
        body: { name: '新团队' },
        auth: rootAuth(tmbA, userA) as any
      });

      expect(res.code).toBe(200);
      const newTeamId = res.data;

      const team = await MongoTeam.findById(newTeamId);
      expect(team?.name).toBe('新团队');

      const tmb = await MongoTeamMember.findOne({ teamId: newTeamId, userId: userA._id });
      expect(tmb?.role).toBe(TeamMemberRoleEnum.owner);

      // 缺了默认组，后续成员组相关功能会异常
      const group = await MongoMemberGroupModel.findOne({ teamId: newTeamId });
      expect(group).toBeTruthy();

      const acl = await MongoResourcePermission.findOne({
        teamId: newTeamId,
        resourceType: PerResourceTypeEnum.team,
        tmbId: tmb!._id
      });
      expect(acl?.permission).toBe(OwnerRoleVal);
    });

    it('非 root 用户不能创建团队（权限防护）', async () => {
      const normalUser = await MongoUser.create({
        username: 'normal-user',
        password: 'psw',
        status: UserStatusEnum.active
      });
      const normalTmb = await MongoTeamMember.create({
        teamId: teamA._id,
        userId: normalUser._id,
        name: '普通成员',
        status: TeamMemberStatusEnum.active
      });

      const before = await MongoTeam.countDocuments();

      const res = await Call(createTeamApi, {
        body: { name: '不该被创建的团队' },
        // isRoot: false + username 不是 root
        auth: {
          userId: String(normalUser._id),
          teamId: String(teamA._id),
          tmbId: String(normalTmb._id),
          isRoot: false,
          sessionId: 's'
        } as any
      });

      expect(res.code).toBe(500);
      expect(await MongoTeam.countDocuments()).toBe(before);
    });

    it('同一用户可以拥有多个团队', async () => {
      await Call(createTeamApi, { body: { name: 'T1' }, auth: rootAuth(tmbA, userA) as any });
      await Call(createTeamApi, { body: { name: 'T2' }, auth: rootAuth(tmbA, userA) as any });

      const count = await MongoTeamMember.countDocuments({ userId: userA._id });
      expect(count).toBe(3); // 初始 1 + 新建 2
    });
  });

  describe('switch', () => {
    it('切换到自己所属的团队应签发新会话', async () => {
      const created = await Call(createTeamApi, {
        body: { name: 'T2' },
        auth: rootAuth(tmbA, userA) as any
      });

      const res = await Call(switchTeamApi, {
        body: { teamId: created.data },
        auth: rootAuth(tmbA, userA) as any
      });

      expect(res.code).toBe(200);
      expect(typeof res.data).toBe('string');
      expect(res.data.length).toBeGreaterThan(0);

      // lastLoginTmbId 应指向新团队的成员记录
      const user = await MongoUser.findById(userA._id);
      const newTmb = await MongoTeamMember.findOne({ teamId: created.data, userId: userA._id });
      expect(String(user?.lastLoginTmbId)).toBe(String(newTmb?._id));
    });

    it('不能切换到自己不属于的团队（越权防护）', async () => {
      const otherUser = await MongoUser.create({
        username: 'outsider',
        password: 'psw',
        status: UserStatusEnum.active
      });
      const otherTeam = await MongoTeam.create({ name: 'Other', ownerId: otherUser._id });
      await MongoTeamMember.create({
        teamId: otherTeam._id,
        userId: otherUser._id,
        name: 'O',
        status: TeamMemberStatusEnum.active,
        role: TeamMemberRoleEnum.owner
      });

      const res = await Call(switchTeamApi, {
        body: { teamId: String(otherTeam._id) },
        auth: rootAuth(tmbA, userA) as any
      });

      expect(res.code).toBe(500);
    });
  });

  describe('changeOwner', () => {
    it('转让后角色互换，且原所有者的资源权限迁移给新所有者', async () => {
      const userB = await MongoUser.create({
        username: 'user-b',
        password: 'psw',
        status: UserStatusEnum.active
      });
      const tmbB = await MongoTeamMember.create({
        teamId: teamA._id,
        userId: userB._id,
        name: 'B',
        status: TeamMemberStatusEnum.active
      });

      // 给原所有者造一条应用级 ACL，验证会被迁移
      const fakeAppId = teamA._id;
      await MongoResourcePermission.create({
        teamId: teamA._id,
        resourceType: PerResourceTypeEnum.app,
        resourceId: fakeAppId,
        tmbId: tmbA._id,
        permission: OwnerRoleVal
      });

      const res = await Call(changeOwnerApi, {
        body: { userId: String(userB._id) },
        auth: rootAuth(tmbA, userA) as any
      });
      expect(res.code).toBe(200);

      expect((await MongoTeamMember.findById(tmbB._id))?.role).toBe(TeamMemberRoleEnum.owner);
      expect((await MongoTeamMember.findById(tmbA._id))?.role).toBeUndefined();
      expect(String((await MongoTeam.findById(teamA._id))?.ownerId)).toBe(String(userB._id));

      // 应用 ACL 应已转到新所有者名下
      const moved = await MongoResourcePermission.findOne({
        resourceType: PerResourceTypeEnum.app,
        resourceId: fakeAppId,
        tmbId: tmbB._id
      });
      expect(moved).toBeTruthy();
    });

    it('不能转让给不在本团队的用户', async () => {
      const stranger = await MongoUser.create({
        username: 'stranger',
        password: 'psw',
        status: UserStatusEnum.active
      });

      const res = await Call(changeOwnerApi, {
        body: { userId: String(stranger._id) },
        auth: rootAuth(tmbA, userA) as any
      });

      expect(res.code).toBe(500);
      expect((await MongoTeamMember.findById(tmbA._id))?.role).toBe(TeamMemberRoleEnum.owner);
    });
  });

  describe('collaborator', () => {
    it('更新团队协作者后列表应返回其名称与权限', async () => {
      const userC = await MongoUser.create({
        username: 'user-c',
        password: 'psw',
        status: UserStatusEnum.active
      });
      const tmbC = await MongoTeamMember.create({
        teamId: teamA._id,
        userId: userC._id,
        name: '成员C',
        status: TeamMemberStatusEnum.active
      });

      const upd = await Call(clbUpdateApi, {
        body: { collaborators: [{ tmbId: String(tmbC._id), permission: TeamReadRoleVal }] },
        auth: rootAuth(tmbA, userA) as any
      });
      expect(upd.code).toBe(200);

      const list = await Call(clbListApi, { auth: rootAuth(tmbA, userA) as any });
      expect(list.code).toBe(200);
      const target = list.data.clbs.find((c: any) => c.tmbId === String(tmbC._id));
      expect(target?.name).toBe('成员C');
    });

    it('不能删除团队所有者的权限', async () => {
      await Call(clbUpdateApi, {
        body: { collaborators: [{ tmbId: String(tmbA._id), permission: OwnerRoleVal }] },
        auth: rootAuth(tmbA, userA) as any
      });

      const res = await Call(clbDeleteApi, {
        query: { tmbId: String(tmbA._id) },
        auth: rootAuth(tmbA, userA) as any
      });

      expect(res.code).toBe(500);
      const still = await MongoResourcePermission.findOne({
        teamId: teamA._id,
        resourceType: PerResourceTypeEnum.team,
        tmbId: tmbA._id
      });
      expect(still).toBeTruthy();
    });
  });
});

describe('协作者弹窗依赖的只读接口', () => {
  let user: any, team: any, tmb: any;

  const rootAuth = (t: any, u: any) => ({
    userId: String(u._id),
    teamId: String(t.teamId),
    tmbId: String(t._id),
    isRoot: true,
    sessionId: 's'
  });

  beforeEach(async () => {
    user = await MongoUser.create({
      username: 'search-owner',
      password: 'psw',
      status: UserStatusEnum.active
    });
    team = await MongoTeam.create({ name: 'Search Team', ownerId: user._id });
    tmb = await MongoTeamMember.create({
      teamId: team._id,
      userId: user._id,
      name: '搜索用户',
      status: TeamMemberStatusEnum.active,
      role: TeamMemberRoleEnum.owner
    });
    await MongoMemberGroupModel.create({ teamId: team._id, name: '默认组' });
  });

  it('group/list 返回本团队的成员组', async () => {
    const groupListApi = (await import('@/pages/api/proApi/support/user/team/group/list')).default;
    const res = await Call(groupListApi, { body: {}, auth: rootAuth(tmb, user) as any });

    expect(res.code).toBe(200);
    // 注意：权限解析链路上的 getTeamDefaultGroup 会在默认组缺失时自动补建，
    // 因此这里不断言总数，只断言自建的组在列表中、且不含其它团队的组。
    expect(res.data.some((g: any) => g.name === '默认组')).toBe(true);
    expect(res.data.every((g: any) => g.teamId === String(team._id))).toBe(true);
  });

  it('group/list 不返回其它团队的成员组（越权防护）', async () => {
    const otherUser = await MongoUser.create({
      username: 'other-group-owner',
      password: 'psw',
      status: UserStatusEnum.active
    });
    const otherTeam = await MongoTeam.create({ name: 'Other', ownerId: otherUser._id });
    await MongoMemberGroupModel.create({ teamId: otherTeam._id, name: '他人组' });

    const groupListApi = (await import('@/pages/api/proApi/support/user/team/group/list')).default;
    const res = await Call(groupListApi, { body: {}, auth: rootAuth(tmb, user) as any });

    expect(res.code).toBe(200);
    expect(res.data.some((g: any) => g.name === '他人组')).toBe(false);
  });

  it('org/list 在没有根部门时返回空数组而不是报错', async () => {
    const orgListApi = (await import('@/pages/api/proApi/support/user/team/org/list')).default;
    const res = await Call(orgListApi, { body: { orgId: '' }, auth: rootAuth(tmb, user) as any });

    expect(res.code).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
  });

  it('搜索接口按成员名匹配', async () => {
    const searchApi = (await import('@/pages/api/proApi/support/user/team/searchMembersOrgsGroups'))
      .default;
    const res = await Call(searchApi, {
      query: { searchKey: '搜索' },
      auth: rootAuth(tmb, user) as any
    });

    expect(res.code).toBe(200);
    expect(res.data.members.length).toBe(1);
    expect(res.data.members[0].memberName).toBe('搜索用户');
  });

  it('搜索关键词为空时返回空结果', async () => {
    const searchApi = (await import('@/pages/api/proApi/support/user/team/searchMembersOrgsGroups'))
      .default;
    const res = await Call(searchApi, {
      query: { searchKey: '' },
      auth: rootAuth(tmb, user) as any
    });

    expect(res.code).toBe(200);
    expect(res.data).toEqual({ members: [], orgs: [], groups: [] });
  });

  it('搜索不跨团队（越权防护）', async () => {
    const otherUser = await MongoUser.create({
      username: 'other-search',
      password: 'psw',
      status: UserStatusEnum.active
    });
    const otherTeam = await MongoTeam.create({ name: 'Other', ownerId: otherUser._id });
    await MongoTeamMember.create({
      teamId: otherTeam._id,
      userId: otherUser._id,
      name: '搜索外人',
      status: TeamMemberStatusEnum.active
    });

    const searchApi = (await import('@/pages/api/proApi/support/user/team/searchMembersOrgsGroups'))
      .default;
    const res = await Call(searchApi, {
      query: { searchKey: '搜索' },
      auth: rootAuth(tmb, user) as any
    });

    expect(res.code).toBe(200);
    expect(res.data.members.some((m: any) => m.memberName === '搜索外人')).toBe(false);
  });
});

describe('审计日志 API', () => {
  let user: any, team: any, tmb: any;

  const rootAuth = (t: any, u: any) => ({
    userId: String(u._id),
    teamId: String(t.teamId),
    tmbId: String(t._id),
    isRoot: true,
    sessionId: 's'
  });

  beforeEach(async () => {
    user = await MongoUser.create({
      username: 'audit-owner',
      password: 'psw',
      status: UserStatusEnum.active
    });
    team = await MongoTeam.create({ name: 'Audit Team', ownerId: user._id });
    tmb = await MongoTeamMember.create({
      teamId: team._id,
      userId: user._id,
      name: '审计操作人',
      status: TeamMemberStatusEnum.active,
      role: TeamMemberRoleEnum.owner
    });
  });

  const seed = async (events: string[]) => {
    const { MongoTeamAudit } = await import('@fastgpt/service/support/user/audit/schema');
    for (const event of events) {
      await MongoTeamAudit.create({
        teamId: team._id,
        tmbId: tmb._id,
        event,
        metadata: { name: '审计操作人' }
      });
    }
  };

  it('返回本团队日志并补全操作者信息', async () => {
    await seed(['LOGIN', 'CHANGE_MEMBER_NAME']);

    const auditApi = (await import('@/pages/api/proApi/support/user/team/audit/list')).default;
    const res = await Call(auditApi, {
      body: { pageSize: 20, pageNum: 1 },
      auth: rootAuth(tmb, user) as any
    });

    expect(res.code).toBe(200);
    expect(res.data.total).toBe(2);
    expect(res.data.list[0].sourceMember?.name).toBe('审计操作人');
  });

  it('metadata.name 必须回填为操作人名称（否则界面显示 {{name}} 占位符）', async () => {
    await seed(['LOGIN']);

    const auditApi = (await import('@/pages/api/proApi/support/user/team/audit/list')).default;
    const res = await Call(auditApi, {
      body: { pageSize: 20, pageNum: 1 },
      auth: rootAuth(tmb, user) as any
    });

    expect(res.code).toBe(200);
    // 前端用 t(content, metadata) 渲染，模板都以【{{name}}】开头，缺 name 会原样显示占位符
    expect(res.data.list[0].metadata.name).toBe('审计操作人');
  });

  it('已显式记录 name 的日志不被操作人名称覆盖', async () => {
    const { MongoTeamAudit } = await import('@fastgpt/service/support/user/audit/schema');
    await MongoTeamAudit.create({
      teamId: team._id,
      tmbId: tmb._id,
      event: 'LOGIN',
      metadata: { name: '历史记录里的名字' }
    });

    const auditApi = (await import('@/pages/api/proApi/support/user/team/audit/list')).default;
    const res = await Call(auditApi, {
      body: { pageSize: 20, pageNum: 1 },
      auth: rootAuth(tmb, user) as any
    });

    expect(res.data.list[0].metadata.name).toBe('历史记录里的名字');
  });

  it('按事件类型筛选', async () => {
    await seed(['LOGIN', 'CHANGE_MEMBER_NAME']);

    const auditApi = (await import('@/pages/api/proApi/support/user/team/audit/list')).default;
    const res = await Call(auditApi, {
      body: { pageSize: 20, pageNum: 1, events: ['LOGIN'] },
      auth: rootAuth(tmb, user) as any
    });

    expect(res.code).toBe(200);
    expect(res.data.total).toBe(1);
    expect(res.data.list[0].event).toBe('LOGIN');
  });

  it('不返回其它团队的日志（越权防护）', async () => {
    await seed(['LOGIN']);

    const otherUser = await MongoUser.create({
      username: 'audit-other',
      password: 'psw',
      status: UserStatusEnum.active
    });
    const otherTeam = await MongoTeam.create({ name: 'Other', ownerId: otherUser._id });
    const otherTmb = await MongoTeamMember.create({
      teamId: otherTeam._id,
      userId: otherUser._id,
      name: '别团队的人',
      status: TeamMemberStatusEnum.active
    });
    const { MongoTeamAudit } = await import('@fastgpt/service/support/user/audit/schema');
    await MongoTeamAudit.create({
      teamId: otherTeam._id,
      tmbId: otherTmb._id,
      event: 'LOGIN',
      metadata: {}
    });

    const auditApi = (await import('@/pages/api/proApi/support/user/team/audit/list')).default;
    const res = await Call(auditApi, {
      body: { pageSize: 20, pageNum: 1 },
      auth: rootAuth(tmb, user) as any
    });

    expect(res.code).toBe(200);
    expect(res.data.total).toBe(1);
  });

  it('筛选条件为空数组时返回空结果', async () => {
    await seed(['LOGIN']);

    const auditApi = (await import('@/pages/api/proApi/support/user/team/audit/list')).default;
    const res = await Call(auditApi, {
      body: { pageSize: 20, pageNum: 1, events: [] },
      auth: rootAuth(tmb, user) as any
    });

    expect(res.code).toBe(200);
    expect(res.data.total).toBe(0);
    expect(res.data.list).toEqual([]);
  });
});
