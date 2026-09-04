import { describe, it, expect, beforeEach } from 'vitest';
import createApi from '@/pages/api/proApi/support/user/team/member/create';
import deleteApi from '@/pages/api/proApi/support/user/team/member/delete';
import leaveApi from '@/pages/api/proApi/support/user/team/member/leave';
import listApi from '@/pages/api/proApi/support/user/team/member/list';
import resetPasswordApi from '@/pages/api/proApi/support/user/team/member/resetPassword';
import { MongoUser } from '@fastgpt/service/support/user/schema';
import { MongoTeam } from '@fastgpt/service/support/user/team/teamSchema';
import { MongoTeamMember } from '@fastgpt/service/support/user/team/teamMemberSchema';
import { UserStatusEnum } from '@fastgpt/global/support/user/constant';
import {
  TeamMemberRoleEnum,
  TeamMemberStatusEnum
} from '@fastgpt/global/support/user/team/constant';
import { Call } from '@test/utils/request';
import { MongoResourcePermission } from '@fastgpt/service/support/permission/schema';
import { PerResourceTypeEnum, CommonPerList } from '@fastgpt/global/support/permission/constant';
import {
  TeamAppCreateRoleVal,
  TeamDatasetCreateRoleVal,
  TeamReadRoleVal
} from '@fastgpt/global/support/permission/user/constant';

describe('开源版团队成员管理 API', () => {
  let ownerUser: any;
  let team: any;
  let ownerTmb: any;

  /** 构造一个 root 身份的鉴权上下文，绕过权限位校验，专注验证业务规则本身。 */
  const rootAuth = (tmb: any, user: any) => ({
    userId: String(user._id),
    teamId: String(tmb.teamId),
    tmbId: String(tmb._id),
    isRoot: true,
    sessionId: 'test-session'
  });

  beforeEach(async () => {
    ownerUser = await MongoUser.create({
      username: 'owner',
      password: 'ownerpsw',
      status: UserStatusEnum.active
    });
    team = await MongoTeam.create({ name: 'Test Team', ownerId: ownerUser._id });
    ownerTmb = await MongoTeamMember.create({
      teamId: team._id,
      userId: ownerUser._id,
      name: 'Owner',
      status: TeamMemberStatusEnum.active,
      role: TeamMemberRoleEnum.owner
    });
  });

  describe('create', () => {
    it('新建成员应加入当前团队，而不是另建一个团队', async () => {
      const teamCountBefore = await MongoTeam.countDocuments();

      const res = await Call(createApi, {
        body: { username: 'alice', password: 'hashed-psw', memberName: '爱丽丝' },
        auth: rootAuth(ownerTmb, ownerUser) as any
      });

      expect(res.code).toBe(200);

      // 核心设计约束：不得为新用户创建独立团队，否则成员之间彼此隔离、无法协作
      expect(await MongoTeam.countDocuments()).toBe(teamCountBefore);

      const tmb = await MongoTeamMember.findById(res.data.tmbId);
      expect(String(tmb?.teamId)).toBe(String(team._id));
      expect(tmb?.name).toBe('爱丽丝');
      expect(tmb?.status).toBe(TeamMemberStatusEnum.active);
      expect(tmb?.role).not.toBe(TeamMemberRoleEnum.owner);
    });

    it('未传成员名时应回退为用户名', async () => {
      const res = await Call(createApi, {
        body: { username: 'bob', password: 'hashed-psw' },
        auth: rootAuth(ownerTmb, ownerUser) as any
      });

      expect(res.code).toBe(200);
      const tmb = await MongoTeamMember.findById(res.data.tmbId);
      expect(tmb?.name).toBe('bob');
    });

    it('新成员的团队角色必须含 read 位，否则其看不到任何资源', async () => {
      const res = await Call(createApi, {
        body: { username: 'frank', password: 'hashed-psw' },
        auth: rootAuth(ownerTmb, ownerUser) as any
      });
      expect(res.code).toBe(200);

      const row = await MongoResourcePermission.findOne({
        teamId: team._id,
        resourceType: PerResourceTypeEnum.team,
        tmbId: res.data.tmbId
      });

      expect(row).toBeTruthy();
      const role = row!.permission;

      // 回归防护：曾误用 TeamWritePermissionVal(单独 write 位，不含 read)，
      // 导致成员连团队都读不了、应用与知识库列表全为空。
      expect(role & CommonPerList.read).toBe(CommonPerList.read);
      expect(role & TeamAppCreateRoleVal).toBe(TeamAppCreateRoleVal);
      expect(role & TeamDatasetCreateRoleVal).toBe(TeamDatasetCreateRoleVal);
      expect(role).toBe(TeamReadRoleVal | TeamAppCreateRoleVal | TeamDatasetCreateRoleVal);
    });

    it('用户名重复时应拒绝，且不产生残留的成员记录', async () => {
      const memberCountBefore = await MongoTeamMember.countDocuments();

      const res = await Call(createApi, {
        body: { username: 'owner', password: 'hashed-psw' },
        auth: rootAuth(ownerTmb, ownerUser) as any
      });

      expect(res.code).toBe(500);
      expect(await MongoTeamMember.countDocuments()).toBe(memberCountBefore);
    });
  });

  describe('delete', () => {
    it('不能移除团队所有者', async () => {
      const res = await Call(deleteApi, {
        query: { tmbId: String(ownerTmb._id) },
        auth: rootAuth(ownerTmb, ownerUser) as any
      });

      expect(res.code).toBe(500);
      const tmb = await MongoTeamMember.findById(ownerTmb._id);
      expect(tmb?.status).toBe(TeamMemberStatusEnum.active);
    });

    it('不能移除自己', async () => {
      const memberUser = await MongoUser.create({
        username: 'carol',
        password: 'psw',
        status: UserStatusEnum.active
      });
      const memberTmb = await MongoTeamMember.create({
        teamId: team._id,
        userId: memberUser._id,
        name: 'Carol',
        status: TeamMemberStatusEnum.active
      });

      const res = await Call(deleteApi, {
        query: { tmbId: String(memberTmb._id) },
        auth: rootAuth(memberTmb, memberUser) as any
      });

      expect(res.code).toBe(500);
      expect((await MongoTeamMember.findById(memberTmb._id))?.status).toBe(
        TeamMemberStatusEnum.active
      );
    });

    it('普通成员应可被移除并置为 leave', async () => {
      const memberUser = await MongoUser.create({
        username: 'dave',
        password: 'psw',
        status: UserStatusEnum.active
      });
      const memberTmb = await MongoTeamMember.create({
        teamId: team._id,
        userId: memberUser._id,
        name: 'Dave',
        status: TeamMemberStatusEnum.active
      });

      const res = await Call(deleteApi, {
        query: { tmbId: String(memberTmb._id) },
        auth: rootAuth(ownerTmb, ownerUser) as any
      });

      expect(res.code).toBe(200);
      expect((await MongoTeamMember.findById(memberTmb._id))?.status).toBe(
        TeamMemberStatusEnum.leave
      );
    });

    it('不能操作其他团队的成员（跨团队越权）', async () => {
      const otherUser = await MongoUser.create({
        username: 'outsider',
        password: 'psw',
        status: UserStatusEnum.active
      });
      const otherTeam = await MongoTeam.create({ name: 'Other Team', ownerId: otherUser._id });
      const otherTmb = await MongoTeamMember.create({
        teamId: otherTeam._id,
        userId: otherUser._id,
        name: 'Outsider',
        status: TeamMemberStatusEnum.active
      });

      const res = await Call(deleteApi, {
        query: { tmbId: String(otherTmb._id) },
        auth: rootAuth(ownerTmb, ownerUser) as any
      });

      expect(res.code).toBe(500);
      expect((await MongoTeamMember.findById(otherTmb._id))?.status).toBe(
        TeamMemberStatusEnum.active
      );
    });
  });

  describe('leave', () => {
    it('团队所有者不能主动离开团队', async () => {
      const res = await Call(leaveApi, {
        auth: rootAuth(ownerTmb, ownerUser) as any
      });

      expect(res.code).toBe(500);
      expect((await MongoTeamMember.findById(ownerTmb._id))?.status).toBe(
        TeamMemberStatusEnum.active
      );
    });
  });

  describe('resetPassword', () => {
    it('应更新目标成员的密码并记录更新时间', async () => {
      const memberUser = await MongoUser.create({
        username: 'erin',
        password: 'old-psw',
        status: UserStatusEnum.active
      });
      const memberTmb = await MongoTeamMember.create({
        teamId: team._id,
        userId: memberUser._id,
        name: 'Erin',
        status: TeamMemberStatusEnum.active
      });

      const before = await MongoUser.findById(memberUser._id).select('+password');

      const res = await Call(resetPasswordApi, {
        body: { tmbId: String(memberTmb._id), password: 'new-hashed-psw' },
        auth: rootAuth(ownerTmb, ownerUser) as any
      });

      expect(res.code).toBe(200);

      const after = await MongoUser.findById(memberUser._id).select('+password');
      expect(after?.password).not.toBe(before?.password);
      expect(after?.passwordUpdateTime).toBeDefined();
    });
  });

  describe('list', () => {
    it('只返回当前团队的成员', async () => {
      const otherUser = await MongoUser.create({
        username: 'stranger',
        password: 'psw',
        status: UserStatusEnum.active
      });
      const otherTeam = await MongoTeam.create({ name: 'Other Team', ownerId: otherUser._id });
      await MongoTeamMember.create({
        teamId: otherTeam._id,
        userId: otherUser._id,
        name: 'Stranger',
        status: TeamMemberStatusEnum.active
      });

      const res = await Call(listApi, {
        body: { pageSize: 20, pageNum: 1 },
        auth: rootAuth(ownerTmb, ownerUser) as any
      });

      expect(res.code).toBe(200);
      expect(res.data.list.every((item: any) => item.teamId === String(team._id))).toBe(true);
      expect(res.data.list.some((item: any) => item.memberName === 'Stranger')).toBe(false);
    });
  });
});
