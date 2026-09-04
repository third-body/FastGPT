import { Types } from '../../../../common/mongo';
import { mongoSessionRun } from '../../../../common/mongo/sessionRun';
import { MongoTeam } from '../teamSchema';
import { MongoTeamMember } from '../teamMemberSchema';
import { MongoMemberGroupModel } from '../../../permission/memberGroup/memberGroupSchema';
import { createRootOrg } from '../../../permission/org/controllers';
import { resourcePermissionRepo } from '../../../permission/repository/resourcePermissionRepo';
import { DefaultGroupName } from '@fastgpt/global/support/user/team/group/constant';
import {
  TeamMemberRoleEnum,
  TeamMemberStatusEnum
} from '@fastgpt/global/support/user/team/constant';
import { OwnerRoleVal, PerResourceTypeEnum } from '@fastgpt/global/support/permission/constant';
import type { CollaboratorItemType } from '@fastgpt/global/support/permission/collaborator';
import {
  transferTmbPermissions,
  updateTeamCollaborator
} from '../../../permission/resourcePermissionService';
import { UserError } from '@fastgpt/global/common/error/utils';
import { i18nT } from '@fastgpt/global/common/i18n/utils';
import { getLogger, LogCategories } from '../../../../common/logger';

const logger = getLogger(LogCategories.MODULE.USER.TEAM);

/**
 * 创建一个新团队，创建者成为所有者。
 *
 * 与 createDefaultTeam 的区别：后者带「该用户已有任意成员记录就跳过」的保护，
 * 只用于首次初始化；这里是显式的多团队创建，同一用户可拥有多个团队。
 *
 * 必须同时创建默认成员组和根组织——协作者、成员组、组织相关功能都依赖它们存在，
 * 缺失会导致后续授权与成员管理异常。
 */
export const createTeam = async ({
  userId,
  name,
  avatar = '/icon/logo.svg',
  memberName = 'Owner'
}: {
  userId: string;
  name: string;
  avatar?: string;
  memberName?: string;
}) => {
  return mongoSessionRun(async (session) => {
    const [team] = await MongoTeam.create(
      [{ ownerId: new Types.ObjectId(userId), name, avatar, createTime: new Date() }],
      { session }
    );

    const [tmb] = await MongoTeamMember.create(
      [
        {
          teamId: team._id,
          userId: new Types.ObjectId(userId),
          name: memberName,
          role: TeamMemberRoleEnum.owner,
          status: TeamMemberStatusEnum.active,
          createTime: new Date()
        }
      ],
      { session }
    );

    await MongoMemberGroupModel.create([{ teamId: team._id, name: DefaultGroupName, avatar }], {
      session
    });
    await createRootOrg({ teamId: String(team._id), session });

    // 所有者在团队资源上写入 owner 角色，保证权限计算与既有团队一致
    await updateTeamCollaborator({
      teamId: String(team._id),
      collaborator: { tmbId: String(tmb._id) },
      permission: OwnerRoleVal,
      session
    });

    logger.info('Team created', { userId, teamId: String(team._id) });
    return String(team._id);
  });
};

/**
 * 校验用户确实属于目标团队并返回其成员记录。
 *
 * 切换团队的 teamId 完全由客户端提供，不校验归属就等于允许任意用户进入任意团队，
 * 因此这是切换链路上的强制关卡。
 */
export const assertUserInTeam = async ({ userId, teamId }: { userId: string; teamId: string }) => {
  const team = await MongoTeam.findOne({
    _id: new Types.ObjectId(teamId),
    $or: [{ deleteTime: { $exists: false } }, { deleteTime: null }]
  });
  if (!team) {
    return Promise.reject(new UserError(i18nT('account_team:team_not_exist')));
  }

  const tmb = await MongoTeamMember.findOne({
    userId: new Types.ObjectId(userId),
    teamId: new Types.ObjectId(teamId),
    status: TeamMemberStatusEnum.active
  });
  if (!tmb) {
    return Promise.reject(new UserError(i18nT('account_team:not_team_member')));
  }

  return tmb;
};

/**
 * 转让团队所有权给同团队内的另一个用户。
 *
 * 除了互换 role 字段，还必须把原所有者在各资源上的 ACL 迁移给新所有者，
 * 否则新所有者虽然名义上是 owner，却拿不到原所有者私有资源的管理权。
 */
export const changeTeamOwner = async ({
  teamId,
  currentTmbId,
  newOwnerUserId
}: {
  teamId: string;
  currentTmbId: string;
  newOwnerUserId: string;
}) => {
  return mongoSessionRun(async (session) => {
    const currentOwner = await MongoTeamMember.findOne(
      { _id: new Types.ObjectId(currentTmbId), teamId: new Types.ObjectId(teamId) },
      undefined,
      { session }
    );
    if (!currentOwner || currentOwner.role !== TeamMemberRoleEnum.owner) {
      return Promise.reject(new UserError(i18nT('account_team:only_owner_can_transfer')));
    }

    const newOwner = await MongoTeamMember.findOne(
      {
        userId: new Types.ObjectId(newOwnerUserId),
        teamId: new Types.ObjectId(teamId),
        status: TeamMemberStatusEnum.active
      },
      undefined,
      { session }
    );
    if (!newOwner) {
      return Promise.reject(new UserError(i18nT('account_team:new_owner_not_in_team')));
    }
    if (String(newOwner._id) === String(currentOwner._id)) {
      return Promise.reject(new UserError(i18nT('account_team:cannot_transfer_to_self')));
    }

    await MongoTeam.updateOne(
      { _id: new Types.ObjectId(teamId) },
      { ownerId: new Types.ObjectId(newOwnerUserId) },
      { session }
    );
    await MongoTeamMember.updateOne(
      { _id: newOwner._id },
      { $set: { role: TeamMemberRoleEnum.owner, updateTime: new Date() } },
      { session }
    );
    // 原所有者降级为普通成员：$unset 而非置空，与非 owner 成员的数据形状保持一致
    await MongoTeamMember.updateOne(
      { _id: currentOwner._id },
      { $unset: { role: 1 }, $set: { updateTime: new Date() } },
      { session }
    );

    await transferTmbPermissions({
      teamId,
      oldTmbId: String(currentOwner._id),
      newTmbId: String(newOwner._id),
      session
    });

    await updateTeamCollaborator({
      teamId,
      collaborator: { tmbId: String(newOwner._id) },
      permission: OwnerRoleVal,
      session
    });

    logger.info('Team owner changed', {
      teamId,
      from: String(currentOwner._id),
      to: String(newOwner._id)
    });

    return { newTmbId: String(newOwner._id), oldTmbId: String(currentOwner._id) };
  });
};

/**
 * 读取团队自身的协作者 ACL。
 *
 * 必须用 findByResource（resourceId 传 undefined → 过滤条件为 `resourceId: null`，
 * 可同时匹配显式 null 和字段缺失），**不能用 findByTeam**：
 * 后者带 `$or: [{resourceId: {$exists: true}}, ...]`，是为「团队内各资源的 ACL」设计的；
 * 而团队级 ACL 由 replaceTeam 写入时根本不带 resourceId 字段，会被该条件整体排除。
 */
export const getTeamCollaborators = async (teamId: string): Promise<CollaboratorItemType[]> => {
  const rows = await resourcePermissionRepo.findByResource({
    teamId,
    resourceType: PerResourceTypeEnum.team
  });

  return rows.flatMap((row) => {
    if (!row.tmbId && !row.groupId && !row.orgId) return [];
    return [
      {
        ...(row.tmbId ? { tmbId: String(row.tmbId) } : {}),
        ...(row.groupId ? { groupId: String(row.groupId) } : {}),
        ...(row.orgId ? { orgId: String(row.orgId) } : {}),
        permission: row.permission
      } as CollaboratorItemType
    ];
  });
};

/** 取团队所有者的 tmbId，用于在协作者列表中标记 isOwner。 */
export const getTeamOwnerTmbId = async (teamId: string) => {
  const owner = await MongoTeamMember.findOne({
    teamId: new Types.ObjectId(teamId),
    role: TeamMemberRoleEnum.owner
  });
  return owner ? String(owner._id) : undefined;
};
