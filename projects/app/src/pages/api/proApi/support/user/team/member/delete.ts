import type { ApiRequestProps, ApiResponseType } from '@fastgpt/next/type';
import { NextAPI } from '@/service/middleware/entry';
import { withProFallback } from '@/service/support/proApi/withProFallback';
import { authUserPer } from '@fastgpt/service/support/permission/user/auth';
import { ManagePermissionVal } from '@fastgpt/global/support/permission/constant';
import { parseApiInput } from '@fastgpt/service/common/zod/requestParseError';
import { removeTeamMember } from '@fastgpt/service/support/user/team/member/controller';
import { addAuditLog } from '@fastgpt/service/support/user/audit/util';
import { AuditEventEnum } from '@fastgpt/global/support/user/audit/constants';
import {
  DeleteTeamMemberQuerySchema,
  type DeleteTeamMemberQueryType
} from '@fastgpt/global/openapi/support/user/team/member/api';

async function handler(
  req: ApiRequestProps<any, DeleteTeamMemberQueryType>,
  _res: ApiResponseType
): Promise<void> {
  const { query } = parseApiInput({ req, querySchema: DeleteTeamMemberQuerySchema });

  const { teamId, tmbId } = await authUserPer({
    req,
    authToken: true,
    per: ManagePermissionVal
  });

  const { memberName } = await removeTeamMember({
    teamId,
    tmbId: query.tmbId,
    operatorTmbId: tmbId
  });

  addAuditLog({
    tmbId,
    teamId,
    event: AuditEventEnum.KICK_OUT_TEAM,
    params: { memberName }
  });
}

export default withProFallback(NextAPI(handler));
