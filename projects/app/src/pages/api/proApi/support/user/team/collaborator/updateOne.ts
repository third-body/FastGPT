import type { ApiRequestProps, ApiResponseType } from '@fastgpt/next/type';
import { NextAPI } from '@/service/middleware/entry';
import { withProFallback } from '@/service/support/proApi/withProFallback';
import { authUserPer } from '@fastgpt/service/support/permission/user/auth';
import { ManagePermissionVal } from '@fastgpt/global/support/permission/constant';
import type { CollaboratorIdType } from '@fastgpt/global/support/permission/collaborator';
import { parseApiInput } from '@fastgpt/service/common/zod/requestParseError';
import { updateTeamCollaborator } from '@fastgpt/service/support/permission/resourcePermissionService';
import {
  UpdateTeamCollaboratorOneBodySchema,
  type UpdateTeamCollaboratorOneBodyType
} from '@fastgpt/global/openapi/support/user/team/collaborator/api';

/** 更新单个团队协作者的权限，不影响其他协作者。 */
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
  req: ApiRequestProps<UpdateTeamCollaboratorOneBodyType>,
  _res: ApiResponseType
): Promise<void> {
  const { tmbId, groupId, orgId, permission } = parseApiInput({
    req,
    bodySchema: UpdateTeamCollaboratorOneBodySchema
  }).body;

  const { teamId } = await authUserPer({ req, authToken: true, per: ManagePermissionVal });

  await updateTeamCollaborator({
    teamId,
    collaborator: toCollaboratorId({ tmbId, groupId, orgId }),
    permission
  });
}

export default withProFallback(NextAPI(handler));
