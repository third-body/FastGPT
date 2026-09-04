import type { ApiRequestProps, ApiResponseType } from '@fastgpt/next/type';
import { NextAPI } from '@/service/middleware/entry';
import { withProFallback } from '@/service/support/proApi/withProFallback';
import { authUserPer } from '@fastgpt/service/support/permission/user/auth';
import { ManagePermissionVal } from '@fastgpt/global/support/permission/constant';
import { getClbsInfo } from '@fastgpt/service/support/permission/controller';
import {
  getTeamCollaborators,
  getTeamOwnerTmbId
} from '@fastgpt/service/support/user/team/multiTeam/controller';
import type { GetTeamCollaboratorListResponseType } from '@fastgpt/global/openapi/support/user/team/collaborator/api';

/** 团队协作者列表。团队是根资源，没有父级，故不返回 parentClbs。 */
async function handler(
  req: ApiRequestProps,
  _res: ApiResponseType
): Promise<GetTeamCollaboratorListResponseType> {
  const { teamId } = await authUserPer({ req, authToken: true, per: ManagePermissionVal });

  const [clbs, ownerTmbId] = await Promise.all([
    getTeamCollaborators(teamId),
    getTeamOwnerTmbId(teamId)
  ]);

  return {
    clbs: await getClbsInfo({ clbs, teamId, ownerTmbId, showUsername: true })
  } as GetTeamCollaboratorListResponseType;
}

export default withProFallback(NextAPI(handler));
