import type { ApiRequestProps, ApiResponseType } from '@fastgpt/next/type';
import { NextAPI } from '@/service/middleware/entry';
import { withProFallback } from '@/service/support/proApi/withProFallback';
import { authUserPer } from '@fastgpt/service/support/permission/user/auth';
import { ManagePermissionVal } from '@fastgpt/global/support/permission/constant';
import { parseApiInput } from '@fastgpt/service/common/zod/requestParseError';
import { replaceTeamCollaborators } from '@fastgpt/service/support/permission/resourcePermissionService';
import {
  UpdateTeamCollaboratorBodySchema,
  type UpdateTeamCollaboratorBodyType
} from '@fastgpt/global/openapi/support/user/team/collaborator/api';

/**
 * 覆盖式更新团队协作者。
 * 团队级 ACL 不涉及资源树继承，直接整体替换即可。
 */
async function handler(
  req: ApiRequestProps<UpdateTeamCollaboratorBodyType>,
  _res: ApiResponseType
): Promise<void> {
  const { collaborators } = parseApiInput({
    req,
    bodySchema: UpdateTeamCollaboratorBodySchema
  }).body;

  const { teamId } = await authUserPer({ req, authToken: true, per: ManagePermissionVal });

  await replaceTeamCollaborators({ teamId, collaborators });
}

export default withProFallback(NextAPI(handler));
