import type { ApiRequestProps, ApiResponseType } from '@fastgpt/next/type';
import { NextAPI } from '@/service/middleware/entry';
import { withProFallback } from '@/service/support/proApi/withProFallback';
import { authUserPer } from '@fastgpt/service/support/permission/user/auth';
import {
  ManagePermissionVal,
  PerResourceTypeEnum
} from '@fastgpt/global/support/permission/constant';
import type { CollaboratorIdType } from '@fastgpt/global/support/permission/collaborator';
import { parseApiInput } from '@fastgpt/service/common/zod/requestParseError';
import { deleteCollaboratorPermissions } from '@fastgpt/service/support/permission/resourcePermissionService';
import { getTeamOwnerTmbId } from '@fastgpt/service/support/user/team/multiTeam/controller';
import { UserError } from '@fastgpt/global/common/error/utils';
import { i18nT } from '@fastgpt/global/common/i18n/utils';
import {
  DeleteTeamCollaboratorQuerySchema,
  type DeleteTeamCollaboratorQueryType
} from '@fastgpt/global/openapi/support/user/team/collaborator/api';

/**
 * 删除团队协作者权限。
 * 只删团队级 ACL，不动该成员在具体应用/知识库上的授权。
 */
/**
 * 把三选一的协作者目标收敛成 CollaboratorIdType。
 * 该类型是 RequireOnlyOne，必须恰好提供一个字段且不能为 undefined，
 * 直接展开 { tmbId, groupId, orgId } 会因另外两个为 undefined 而类型不符。
 */
const toCollaboratorId = ({
  tmbId,
  groupId,
  orgId
}: {
  tmbId?: string;
  groupId?: string;
  orgId?: string;
}): CollaboratorIdType => {
  if (tmbId) return { tmbId };
  if (groupId) return { groupId };
  return { orgId: orgId! };
};

async function handler(
  req: ApiRequestProps<any, DeleteTeamCollaboratorQueryType>,
  _res: ApiResponseType
): Promise<void> {
  const { tmbId, groupId, orgId } = parseApiInput({
    req,
    querySchema: DeleteTeamCollaboratorQuerySchema
  }).query;

  const { teamId } = await authUserPer({ req, authToken: true, per: ManagePermissionVal });

  // 移除所有者的团队权限会让团队失去管理入口，直接拦截
  if (tmbId) {
    const ownerTmbId = await getTeamOwnerTmbId(teamId);
    if (ownerTmbId && String(ownerTmbId) === String(tmbId)) {
      return Promise.reject(new UserError(i18nT('account_team:cannot_remove_owner_permission')));
    }
  }

  await deleteCollaboratorPermissions({
    teamId,
    collaborator: toCollaboratorId({ tmbId, groupId, orgId }),
    resourceType: PerResourceTypeEnum.team
  });
}

export default withProFallback(NextAPI(handler));
