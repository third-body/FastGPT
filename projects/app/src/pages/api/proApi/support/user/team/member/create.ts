import type { ApiRequestProps, ApiResponseType } from '@fastgpt/next/type';
import { NextAPI } from '@/service/middleware/entry';
import { withProFallback } from '@/service/support/proApi/withProFallback';
import { authUserPer } from '@fastgpt/service/support/permission/user/auth';
import { ManagePermissionVal } from '@fastgpt/global/support/permission/constant';
import { parseApiInput } from '@fastgpt/service/common/zod/requestParseError';
import { createTeamMemberAccount } from '@fastgpt/service/support/user/team/member/controller';
import { addAuditLog } from '@fastgpt/service/support/user/audit/util';
import { AdminAuditEventEnum } from '@fastgpt/global/support/user/audit/constants';
import {
  CreateTeamMemberBodySchema,
  type CreateTeamMemberBodyType,
  type CreateTeamMemberResponseType
} from '@fastgpt/global/openapi/support/user/team/member/api';

async function handler(
  req: ApiRequestProps<CreateTeamMemberBodyType>,
  _res: ApiResponseType
): Promise<CreateTeamMemberResponseType> {
  const { username, password, memberName } = parseApiInput({
    req,
    bodySchema: CreateTeamMemberBodySchema
  }).body;

  const { teamId, tmbId } = await authUserPer({
    req,
    authToken: true,
    per: ManagePermissionVal
  });

  const result = await createTeamMemberAccount({ teamId, username, password, memberName });

  addAuditLog({
    tmbId,
    teamId,
    event: AdminAuditEventEnum.ADMIN_ADD_USER,
    params: { userName: username }
  });

  return result;
}

export default withProFallback(NextAPI(handler));
