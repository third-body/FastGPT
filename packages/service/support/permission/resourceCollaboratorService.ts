import { type ClientSession } from '../../common/mongo';
import { mongoSessionRun } from '../../common/mongo/sessionRun';
import type { PerResourceTypeEnum } from '@fastgpt/global/support/permission/constant';
import type {
  CollaboratorItemType,
  CollaboratorItemDetailType
} from '@fastgpt/global/support/permission/collaborator';
import { resourcePermissionRepo } from './repository/resourcePermissionRepo';
import { getClbsInfo } from './controller';
import { updateResourceCollaborators } from './resourcePermissionService';
import { shouldInheritResourcePermission } from './resourcePermissionPolicy';
import type { SyncChildrenPermissionResourceType } from './inheritPermission';
import type { Model } from 'mongoose';

/** 与 resourcePermissionService 中一致：可同步继承权限的资源模型。 */
type ResourceModel = Model<any>;

/** 把 ACL 行转成协作者结构，丢弃没有明确授权目标的脏数据。 */
const toCollaboratorItems = (
  rows: Array<{
    tmbId?: any;
    groupId?: any;
    orgId?: any;
    permission: number;
  }>
): CollaboratorItemType[] =>
  rows.flatMap((row) => {
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

/** 读取单个资源自身的 ACL（不含继承来的父级权限）。 */
export const getResourceCollaborators = async ({
  teamId,
  resourceType,
  resourceId,
  session
}: {
  teamId: string;
  resourceType: PerResourceTypeEnum;
  resourceId: string;
  session?: ClientSession;
}): Promise<CollaboratorItemType[]> => {
  const rows = await resourcePermissionRepo.findByResourceIds({
    teamId,
    resourceType,
    resourceIds: [resourceId],
    session
  });
  return toCollaboratorItems(rows);
};

/**
 * 组装协作者列表接口的返回值。
 *
 * 前端需要区分「资源自身的协作者」与「从父级继承来的协作者」：后者不可在子资源上直接编辑，
 * 故当资源处于继承状态且有父级时，额外返回 parentClbs 供前端置灰展示。
 *
 * @param ownerTmbId 资源所有者，用于把 owner 标记为 isOwner（前端据此禁止移除所有者）。
 */
export const getResourceCollaboratorList = async ({
  teamId,
  resourceType,
  resource,
  ownerTmbId,
  showUsername
}: {
  teamId: string;
  resourceType: PerResourceTypeEnum;
  resource: { _id: any; parentId?: any; inheritPermission?: boolean };
  ownerTmbId?: string;
  showUsername?: boolean;
}): Promise<{ clbs: CollaboratorItemDetailType[]; parentClbs?: CollaboratorItemDetailType[] }> => {
  const clbs = await getResourceCollaborators({
    teamId,
    resourceType,
    resourceId: String(resource._id)
  });

  const clbsDetail = await getClbsInfo({ clbs, teamId, ownerTmbId, showUsername });

  // 非继承状态或根节点没有可展示的父级权限
  if (!shouldInheritResourcePermission(resource.inheritPermission) || !resource.parentId) {
    return { clbs: clbsDetail };
  }

  const parentClbs = await getResourceCollaborators({
    teamId,
    resourceType,
    resourceId: String(resource.parentId)
  });

  return {
    clbs: clbsDetail,
    parentClbs: await getClbsInfo({ clbs: parentClbs, teamId, ownerTmbId, showUsername })
  };
};

/**
 * 覆盖式更新资源协作者，并把变更同步到继承该资源权限的子树。
 *
 * 必须在写入前先读到 oldCollaborators：updateResourceCollaborators 依赖新旧快照
 * 计算子资源要增删哪些权限，缺少旧快照会导致子树权限残留。
 */
export const updateResourceCollaboratorList = async ({
  teamId,
  resourceType,
  resource,
  resourceModel,
  collaborators
}: {
  teamId: string;
  resourceType: PerResourceTypeEnum;
  resource: SyncChildrenPermissionResourceType & { parentId?: any };
  resourceModel: ResourceModel;
  collaborators: CollaboratorItemType[];
}) => {
  return mongoSessionRun(async (session) => {
    const oldCollaborators = await getResourceCollaborators({
      teamId,
      resourceType,
      resourceId: String(resource._id),
      session
    });

    // 父级快照用于判断本次更新是否与继承权限冲突，冲突时自动断开继承
    const parentCollaborators = resource.parentId
      ? await getResourceCollaborators({
          teamId,
          resourceType,
          resourceId: String(resource.parentId),
          session
        })
      : undefined;

    await updateResourceCollaborators({
      resource,
      resourceModel,
      resourceType,
      oldCollaborators,
      newCollaborators: collaborators,
      parentCollaborators,
      session
    });

    // 审计日志要展示成员/组/组织的名称而非 ID，顺带在同一事务里解析好返回给调用方
    const details = await getClbsInfo({ clbs: collaborators, teamId });
    return {
      tmbList: details.filter((d) => d.tmbId).map((d) => d.name),
      groupList: details.filter((d) => d.groupId).map((d) => d.name),
      orgList: details.filter((d) => d.orgId).map((d) => d.name),
      permission: Array.from(new Set(collaborators.map((c) => String(c.permission)))).join(',')
    };
  });
};
