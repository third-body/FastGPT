import type { ApiRequestProps, ApiResponseType } from '@fastgpt/next/type';
import { NextAPI } from '@/service/middleware/entry';
import { withProFallback } from '@/service/support/proApi/withProFallback';
import { authUserPer } from '@fastgpt/service/support/permission/user/auth';
import { ManagePermissionVal } from '@fastgpt/global/support/permission/constant';
import { parseApiInput } from '@fastgpt/service/common/zod/requestParseError';
import { resetTeamMemberPassword } from '@fastgpt/service/support/user/team/member/controller';
import { addAuditLog } from '@fastgpt/service/support/user/audit/util';
import { AdminAuditEventEnum } from '@fastgpt/global/support/user/audit/constants';
import {
  ResetTeamMemberPasswordBodySchema,
  type ResetTeamMemberPasswordBodyType
} from '@fastgpt/global/openapi/support/user/team/member/api';

async function handler(
  req: ApiRequestProps<ResetTeamMemberPasswordBodyType>,
  _res: ApiResponseType
): Promise<void> {
  const { body } = parseApiInput({ req, bodySchema: ResetTeamMemberPasswordBodySchema });

  const { teamId, tmbId } = await authUserPer({
    req,
    authToken: true,
    per: ManagePermissionVal
  });

  const { memberName } = await resetTeamMemberPassword({
    teamId,
    tmbId: body.tmbId,
    password: body.password
  });

  addAuditLog({
    tmbId,
    teamId,
    event: AdminAuditEventEnum.ADMIN_UPDATE_USER,
    params: { userName: memberName }
  });
}

export default withProFallback(NextAPI(handler));
