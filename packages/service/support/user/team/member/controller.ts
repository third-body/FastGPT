import { Types, type ClientSession } from '../../../../common/mongo';
import { mongoSessionRun } from '../../../../common/mongo/sessionRun';
import { MongoUser } from '../../schema';
import { MongoTeamMember } from '../teamMemberSchema';
import { MongoTeam } from '../teamSchema';
import {
  TeamMemberRoleEnum,
  TeamMemberStatusEnum
} from '@fastgpt/global/support/user/team/constant';
import {
  TeamAppCreateRoleVal,
  TeamDatasetCreateRoleVal,
  TeamReadRoleVal
} from '@fastgpt/global/support/permission/user/constant';
import { PerResourceTypeEnum } from '@fastgpt/global/support/permission/constant';
import {
  deleteCollaboratorPermissions,
  updateTeamCollaborator
} from '../../../permission/resourcePermissionService';
import { getTmbPermission } from '../../../permission/controller';
import { delUserAllSession } from '../../session';
import { UserError } from '@fastgpt/global/common/error/utils';
import { i18nT } from '@fastgpt/global/common/i18n/utils';
import { getLogger, LogCategories } from '../../../../common/logger';
import type { TeamMemberListItemSchema } from '@fastgpt/global/openapi/support/user/team/member/api';
import type z from 'zod';

const logger = getLogger(LogCategories.MODULE.USER.TEAM);

type TeamMemberListItem = z.infer<typeof TeamMemberListItemSchema>;

/**
 * 新成员的默认团队角色：普通成员 + 可建应用 + 可建知识库。
 *
 * 注意 resource_permissions.permission 存的是**角色值(Role)**而非原始权限位(PermissionVal)，
 * 两者是不同的常量体系：TeamWritePermissionVal 是单独的 write 位(0b010)，
 * 在 TeamRoleList 中被标记为 hidden 且**不含 read 位**，单独授予会导致成员连团队都读不了、
 * 看不到任何资源。因此这里必须按角色值组合，且必须包含 TeamReadRoleVal。
 *
 * 本期不做权限管理页面，成员若只有只读角色将无处提权，故默认带上两个创建类角色。
 */
const defaultMemberRoleVal = TeamReadRoleVal | TeamAppCreateRoleVal | TeamDatasetCreateRoleVal;

/** MongoDB 唯一索引冲突的错误码，用于识别用户名重复。 */
const MONGO_DUPLICATE_KEY_CODE = 11000;

/**
 * 断言目标成员属于指定团队，返回该成员记录。
 *
 * 所有针对单个成员的管理操作都必须先过这道校验：请求里的 tmbId 完全由客户端提供，
 * 若不校验归属，具备本团队管理权限的人就能操作到其它团队的成员记录（跨团队越权）。
 */
const assertMemberInTeam = async ({
  teamId,
  tmbId,
  session
}: {
  teamId: string;
  tmbId: string;
  session?: ClientSession;
}) => {
  const query = MongoTeamMember.findOne({
    _id: new Types.ObjectId(tmbId),
    teamId: new Types.ObjectId(teamId)
  });
  if (session) query.session(session);

  const member = await query;
  if (!member) {
    return Promise.reject(new UserError(i18nT('account_team:member_not_exist')));
  }
  return member;
};

/**
 * 分页查询团队成员。
 *
 * 开源版单团队场景下不支持按组织/成员组筛选（这些能力属于商业版），
 * 调用方传入 orgId / groupId 时不会报错，仅不参与过滤，以便前端组件复用。
 *
 * @param currentFirst 把当前登录成员排到首位。用 $expr 排序字段实现，避免额外查询。
 */
export const listTeamMembers = async ({
  teamId,
  currentTmbId,
  offset,
  pageSize,
  searchKey,
  status,
  tmbIds,
  currentFirst,
  withPermission
}: {
  teamId: string;
  currentTmbId: string;
  offset: number;
  pageSize: number;
  searchKey?: string;
  status?: TeamMemberStatusEnum;
  tmbIds?: string[];
  currentFirst?: boolean;
  withPermission?: boolean;
}): Promise<{ total: number; list: TeamMemberListItem[] }> => {
  // tmbIds 传空数组语义是「精确筛选出空集」，不能当作未传处理
  if (tmbIds && tmbIds.length === 0) {
    return { total: 0, list: [] };
  }

  const match: Record<string, any> = {
    teamId: new Types.ObjectId(teamId),
    ...(status ? { status } : {}),
    ...(tmbIds ? { _id: { $in: tmbIds.map((id) => new Types.ObjectId(id)) } } : {})
  };

  // 搜索需要同时覆盖成员名和用户账号，后者在 users 表，先按用户名捞出 userId 再合并条件
  if (searchKey) {
    const escaped = searchKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const keywordRegex = new RegExp(escaped, 'i');
    const matchedUsers = await MongoUser.find(
      { $or: [{ username: keywordRegex }, { contact: keywordRegex }] },
      { _id: 1 }
    ).lean();

    match.$or = [
      { name: keywordRegex },
      ...(matchedUsers.length ? [{ userId: { $in: matchedUsers.map((user) => user._id) } }] : [])
    ];
  }

  const [total, members] = await Promise.all([
    MongoTeamMember.countDocuments(match),
    MongoTeamMember.find(match)
      .populate<{ user: { username: string; contact?: string } }>('user', 'username contact')
      // owner 恒排首位，其次可选置顶当前成员，最后按加入时间
      .sort({
        ...(currentFirst ? { _id: 1 } : {}),
        role: -1,
        createTime: 1
      })
      .skip(offset)
      .limit(pageSize)
      .lean()
  ]);

  const list: TeamMemberListItem[] = await Promise.all(
    members.map(async (member) => {
      const permission = withPermission
        ? await getTmbPermission({
            resourceType: PerResourceTypeEnum.team,
            teamId,
            tmbId: String(member._id)
          })
        : undefined;

      return {
        userId: String(member.userId),
        tmbId: String(member._id),
        teamId: String(member.teamId),
        memberName: member.name,
        avatar: member.avatar,
        role: member.role,
        status: member.status as TeamMemberStatusEnum,
        contact: member.user?.contact ?? member.user?.username,
        createTime: member.createTime,
        updateTime: member.updateTime,
        ...(permission !== undefined ? { permission: permission as any } : {})
      };
    })
  );

  // currentFirst 无法完全靠 mongo sort 表达（需按具体 _id 置顶），在内存里做最后一次提升
  if (currentFirst) {
    const currentIndex = list.findIndex((item) => item.tmbId === String(currentTmbId));
    if (currentIndex > 0) {
      const [current] = list.splice(currentIndex, 1);
      list.unshift(current);
    }
  }

  return { total, list };
};

/** 统计团队内处于 active 状态的成员数量。 */
export const countTeamMembers = async (teamId: string) =>
  MongoTeamMember.countDocuments({
    teamId: new Types.ObjectId(teamId),
    status: TeamMemberStatusEnum.active
  });

/**
 * 创建一个用户账号并直接加入指定团队（开源版「管理员建号」流程）。
 *
 * 关键点：**刻意不调用 createDefaultTeam**。那会给新用户单独建一个团队，
 * 导致每人一个互相隔离的孤岛团队，与「多人共处同一团队协作」的目标相反。
 * 这里复用调用方所在团队既有的默认成员组和根组织。
 *
 * @param password 客户端已用 hashStr 处理过的密码。MongoUser 的 password 字段带
 *   `set: hashStr` setter，会在写入时再哈希一次；登录查询同样会对入参跑 setter，
 *   两侧一致。故此处必须原样透传，**不能**在服务端再手动 hashStr，否则登录必然失败。
 */
export const createTeamMemberAccount = async ({
  teamId,
  username,
  password,
  memberName
}: {
  teamId: string;
  username: string;
  password: string;
  memberName?: string;
}) => {
  return mongoSessionRun(async (session) => {
    const [user] = await MongoUser.create(
      [
        {
          username,
          password
        }
      ],
      { session, ordered: true }
    ).catch((error: any) => {
      // users.username 上有唯一索引，冲突时转成可读的业务错误而非 500
      if (error?.code === MONGO_DUPLICATE_KEY_CODE) {
        return Promise.reject(new UserError(i18nT('account_team:username_already_exists')));
      }
      return Promise.reject(error);
    });

    const [member] = await MongoTeamMember.create(
      [
        {
          teamId: new Types.ObjectId(teamId),
          userId: user._id,
          name: memberName || username,
          status: TeamMemberStatusEnum.active
        }
      ],
      { session, ordered: true }
    );

    // 默认角色见 defaultMemberRoleVal：普通成员 + 建应用 + 建知识库
    await updateTeamCollaborator({
      teamId,
      collaborator: { tmbId: String(member._id) },
      permission: defaultMemberRoleVal,
      session
    });

    logger.info('Team member account created', {
      teamId,
      userId: String(user._id),
      tmbId: String(member._id)
    });

    return { userId: String(user._id), tmbId: String(member._id) };
  });
};

/**
 * 把成员移出团队。
 *
 * owner 不可被移除（否则团队失去归属人）；操作者也不能移除自己，
 * 自愿退出应走 leaveTeam，两者的语义和审计事件不同。
 */
export const removeTeamMember = async ({
  teamId,
  tmbId,
  operatorTmbId
}: {
  teamId: string;
  tmbId: string;
  operatorTmbId: string;
}) => {
  if (String(tmbId) === String(operatorTmbId)) {
    return Promise.reject(new UserError(i18nT('account_team:cannot_remove_self')));
  }

  return mongoSessionRun(async (session) => {
    const member = await assertMemberInTeam({ teamId, tmbId, session });

    if (member.role === TeamMemberRoleEnum.owner) {
      return Promise.reject(new UserError(i18nT('account_team:cannot_remove_owner')));
    }

    await MongoTeamMember.updateOne(
      { _id: member._id },
      { status: TeamMemberStatusEnum.leave, updateTime: new Date() },
      { session }
    );

    // 同步清掉该成员的全部资源 ACL，避免其被恢复或复用 tmbId 时残留越权
    await deleteCollaboratorPermissions({
      teamId,
      collaborator: { tmbId: String(member._id) },
      session
    });

    // 踢下线，防止已登录会话在被移出后继续访问团队资源
    await delUserAllSession(String(member.userId));

    logger.info('Team member removed', { teamId, tmbId, operatorTmbId });

    return { memberName: member.name };
  });
};

/** 当前成员主动离开团队。owner 不可离开，需先转让所有权。 */
export const leaveTeam = async ({ teamId, tmbId }: { teamId: string; tmbId: string }) => {
  return mongoSessionRun(async (session) => {
    const member = await assertMemberInTeam({ teamId, tmbId, session });

    if (member.role === TeamMemberRoleEnum.owner) {
      return Promise.reject(new UserError(i18nT('account_team:owner_cannot_leave')));
    }

    await MongoTeamMember.updateOne(
      { _id: member._id },
      { status: TeamMemberStatusEnum.leave, updateTime: new Date() },
      { session }
    );

    await deleteCollaboratorPermissions({
      teamId,
      collaborator: { tmbId: String(member._id) },
      session
    });

    logger.info('Team member left', { teamId, tmbId });
  });
};

/** 把 leave / forbidden 状态的成员恢复为 active，并重新授予团队写权限。 */
export const restoreTeamMember = async ({ teamId, tmbId }: { teamId: string; tmbId: string }) => {
  return mongoSessionRun(async (session) => {
    const member = await assertMemberInTeam({ teamId, tmbId, session });

    await MongoTeamMember.updateOne(
      { _id: member._id },
      { status: TeamMemberStatusEnum.active, updateTime: new Date() },
      { session }
    );

    // 移出时清空过 ACL，恢复时需按同一套默认角色重新授权，否则成员回来后寸步难行
    await updateTeamCollaborator({
      teamId,
      collaborator: { tmbId: String(member._id) },
      permission: defaultMemberRoleVal,
      session
    });

    logger.info('Team member restored', { teamId, tmbId });

    return { memberName: member.name };
  });
};

/** 更新成员在团队中的显示名称。 */
export const updateTeamMemberName = async ({
  teamId,
  tmbId,
  name
}: {
  teamId: string;
  tmbId: string;
  name: string;
}) => {
  const member = await assertMemberInTeam({ teamId, tmbId });
  await MongoTeamMember.updateOne(
    { _id: new Types.ObjectId(tmbId) },
    { name, updateTime: new Date() }
  );

  // 返回改名前的旧名，供审计日志记录变更前后
  return { memberName: member.name };
};

/**
 * 管理员重置成员登录密码。
 *
 * 重置后强制该用户全部会话下线：账号被盗或人员离场等场景下，
 * 若保留既有会话，改密码起不到收回访问权的作用。
 *
 * @param password 同 createTeamMemberAccount，客户端已 hashStr 处理，原样透传。
 */
export const resetTeamMemberPassword = async ({
  teamId,
  tmbId,
  password
}: {
  teamId: string;
  tmbId: string;
  password: string;
}) => {
  const member = await assertMemberInTeam({ teamId, tmbId });

  await MongoUser.findByIdAndUpdate(member.userId, {
    password,
    passwordUpdateTime: new Date()
  });

  await delUserAllSession(String(member.userId));

  logger.info('Team member password reset', { teamId, tmbId });

  return { memberName: member.name };
};

/** 查询用户所属的团队列表。开源版单团队场景下通常只有一条。 */
export const listUserTeams = async (userId: string) => {
  const members = await MongoTeamMember.find({
    userId: new Types.ObjectId(userId),
    status: TeamMemberStatusEnum.active
  }).lean();

  if (members.length === 0) return [];

  const teams = await MongoTeam.find({
    _id: { $in: members.map((member) => member.teamId) },
    $or: [{ deleteTime: { $exists: false } }, { deleteTime: null }]
  }).lean();
  const teamMap = new Map(teams.map((team) => [String(team._id), team]));

  return members.flatMap((member) => {
    const team = teamMap.get(String(member.teamId));
    if (!team) return [];

    return [
      {
        userId: String(member.userId),
        teamId: String(team._id),
        teamName: team.name,
        teamAvatar: team.avatar,
        memberName: member.name,
        avatar: member.avatar,
        balance: team.balance,
        tmbId: String(member._id),
        role: member.role,
        status: member.status,
        defaultTeam: true,
        notificationAccount: team.notificationAccount
      }
    ];
  });
};
