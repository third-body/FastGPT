import type { ApiRequestProps, ApiResponseType } from '@fastgpt/next/type';
import { NextAPI } from '@/service/middleware/entry';
import { withProFallback } from '@/service/support/proApi/withProFallback';
import { authUserPer } from '@fastgpt/service/support/permission/user/auth';
import { ManagePermissionVal } from '@fastgpt/global/support/permission/constant';
import { parseApiInput } from '@fastgpt/service/common/zod/requestParseError';
import { restoreTeamMember } from '@fastgpt/service/support/user/team/member/controller';
import { addAuditLog } from '@fastgpt/service/support/user/audit/util';
import { AuditEventEnum } from '@fastgpt/global/support/user/audit/constants';
import {
  RestoreTeamMemberBodySchema,
  type RestoreTeamMemberBodyType
} from '@fastgpt/global/openapi/support/user/team/member/api';

async function handler(
  req: ApiRequestProps<RestoreTeamMemberBodyType>,
  _res: ApiResponseType
): Promise<void> {
  const { body } = parseApiInput({ req, bodySchema: RestoreTeamMemberBodySchema });

  const { teamId, tmbId } = await authUserPer({
    req,
    authToken: true,
    per: ManagePermissionVal
  });

  const { memberName } = await restoreTeamMember({ teamId, tmbId: body.tmbId });

  addAuditLog({
    tmbId,
    teamId,
    event: AuditEventEnum.RECOVER_TEAM_MEMBER,
    params: { memberName }
  });
}

export default withProFallback(NextAPI(handler));
