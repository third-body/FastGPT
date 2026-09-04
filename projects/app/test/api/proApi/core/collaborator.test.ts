import { describe, it, expect, beforeEach } from 'vitest';
import appClbListApi from '@/pages/api/proApi/core/app/collaborator/list';
import appClbUpdateApi from '@/pages/api/proApi/core/app/collaborator/update';
import { MongoUser } from '@fastgpt/service/support/user/schema';
import { MongoTeam } from '@fastgpt/service/support/user/team/teamSchema';
import { MongoTeamMember } from '@fastgpt/service/support/user/team/teamMemberSchema';
import { MongoApp } from '@fastgpt/service/core/app/schema';
import { MongoResourcePermission } from '@fastgpt/service/support/permission/schema';
import { UserStatusEnum } from '@fastgpt/global/support/user/constant';
import {
  TeamMemberRoleEnum,
  TeamMemberStatusEnum
} from '@fastgpt/global/support/user/team/constant';
import {
  PerResourceTypeEnum,
  ReadPermissionVal,
  WritePermissionVal
} from '@fastgpt/global/support/permission/constant';
import { AppTypeEnum } from '@fastgpt/global/core/app/constants';
import { Call } from '@test/utils/request';

describe('开源版资源协作者 API', () => {
  let owner: any, team: any, ownerTmb: any, memberTmb: any, app: any;

  const rootAuth = (tmb: any, user: any) => ({
    userId: String(user._id),
    teamId: String(tmb.teamId),
    tmbId: String(tmb._id),
    isRoot: true,
    sessionId: 'test-session'
  });

  beforeEach(async () => {
    owner = await MongoUser.create({
      username: 'clb-owner',
      password: 'psw',
      status: UserStatusEnum.active
    });
    team = await MongoTeam.create({ name: 'Clb Team', ownerId: owner._id });
    ownerTmb = await MongoTeamMember.create({
      teamId: team._id,
      userId: owner._id,
      name: 'Owner',
      status: TeamMemberStatusEnum.active,
      role: TeamMemberRoleEnum.owner
    });

    const member = await MongoUser.create({
      username: 'clb-member',
      password: 'psw',
      status: UserStatusEnum.active
    });
    memberTmb = await MongoTeamMember.create({
      teamId: team._id,
      userId: member._id,
      name: '协作成员',
      status: TeamMemberStatusEnum.active
    });

    app = await MongoApp.create({
      name: '测试应用',
      type: AppTypeEnum.simple,
      teamId: team._id,
      tmbId: ownerTmb._id
    });
  });

  it('初始状态下应用没有额外协作者', async () => {
    const res = await Call(appClbListApi, {
      query: { appId: String(app._id) },
      auth: rootAuth(ownerTmb, owner) as any
    });

    expect(res.code).toBe(200);
    expect(res.data.clbs).toEqual([]);
  });

  it('把应用共享给成员后，ACL 中应出现该成员且权限正确', async () => {
    const res = await Call(appClbUpdateApi, {
      body: {
        appId: String(app._id),
        collaborators: [{ tmbId: String(memberTmb._id), permission: ReadPermissionVal }]
      },
      auth: rootAuth(ownerTmb, owner) as any
    });

    expect(res.code).toBe(200);

    const row = await MongoResourcePermission.findOne({
      teamId: team._id,
      resourceType: PerResourceTypeEnum.app,
      resourceId: app._id,
      tmbId: memberTmb._id
    });
    expect(row).toBeTruthy();
    expect(row?.permission).toBe(ReadPermissionVal);
  });

  it('列表接口应返回协作者的成员名称', async () => {
    await Call(appClbUpdateApi, {
      body: {
        appId: String(app._id),
        collaborators: [{ tmbId: String(memberTmb._id), permission: WritePermissionVal }]
      },
      auth: rootAuth(ownerTmb, owner) as any
    });

    const res = await Call(appClbListApi, {
      query: { appId: String(app._id) },
      auth: rootAuth(ownerTmb, owner) as any
    });

    expect(res.code).toBe(200);
    expect(res.data.clbs).toHaveLength(1);
    expect(res.data.clbs[0].name).toBe('协作成员');
    expect(res.data.clbs[0].tmbId).toBe(String(memberTmb._id));
  });

  it('更新是覆盖式的：移出的协作者其 ACL 应被删除', async () => {
    await Call(appClbUpdateApi, {
      body: {
        appId: String(app._id),
        collaborators: [{ tmbId: String(memberTmb._id), permission: ReadPermissionVal }]
      },
      auth: rootAuth(ownerTmb, owner) as any
    });

    // 用另一个协作者覆盖，原成员应被移除
    const otherUser = await MongoUser.create({
      username: 'clb-other',
      password: 'psw',
      status: UserStatusEnum.active
    });
    const otherTmb = await MongoTeamMember.create({
      teamId: team._id,
      userId: otherUser._id,
      name: '另一成员',
      status: TeamMemberStatusEnum.active
    });

    await Call(appClbUpdateApi, {
      body: {
        appId: String(app._id),
        collaborators: [{ tmbId: String(otherTmb._id), permission: ReadPermissionVal }]
      },
      auth: rootAuth(ownerTmb, owner) as any
    });

    const removed = await MongoResourcePermission.findOne({
      resourceId: app._id,
      tmbId: memberTmb._id
    });
    const kept = await MongoResourcePermission.findOne({
      resourceId: app._id,
      tmbId: otherTmb._id
    });
    expect(removed).toBeNull();
    expect(kept).toBeTruthy();
  });

  it('无管理权限的成员不能修改协作者（越权防护）', async () => {
    const res = await Call(appClbUpdateApi, {
      body: {
        appId: String(app._id),
        collaborators: [{ tmbId: String(memberTmb._id), permission: ReadPermissionVal }]
      },
      // 非 root，且该成员对应用无任何权限
      auth: {
        userId: String(memberTmb.userId),
        teamId: String(team._id),
        tmbId: String(memberTmb._id),
        isRoot: false,
        sessionId: 's'
      } as any
    });

    expect(res.code).toBe(500);
  });
});
