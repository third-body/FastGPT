import type { ApiRequestProps, ApiResponseType } from '@fastgpt/next/type';
import { NextAPI } from '@/service/middleware/entry';
import { withProFallback } from '@/service/support/proApi/withProFallback';
import { authUserPer } from '@fastgpt/service/support/permission/user/auth';
import { ManagePermissionVal } from '@fastgpt/global/support/permission/constant';
import { parseApiInput } from '@fastgpt/service/common/zod/requestParseError';
import { updateTeamMemberName } from '@fastgpt/service/support/user/team/member/controller';
import { addAuditLog } from '@fastgpt/service/support/user/audit/util';
import { AuditEventEnum } from '@fastgpt/global/support/user/audit/constants';
import {
  UpdateTeamMemberNameByManagerBodySchema,
  type UpdateTeamMemberNameByManagerBodyType
} from '@fastgpt/global/openapi/support/user/team/member/api';

async function handler(
  req: ApiRequestProps<UpdateTeamMemberNameByManagerBodyType>,
  _res: ApiResponseType
): Promise<void> {
  const { body } = parseApiInput({ req, bodySchema: UpdateTeamMemberNameByManagerBodySchema });

  const { teamId, tmbId } = await authUserPer({
    req,
    authToken: true,
    per: ManagePermissionVal
  });

  const { memberName } = await updateTeamMemberName({
    teamId,
    tmbId: body.tmbId,
    name: body.name
  });

  addAuditLog({
    tmbId,
    teamId,
    event: AuditEventEnum.CHANGE_MEMBER_NAME,
    params: { memberName, newName: body.name }
  });
}

export default withProFallback(NextAPI(handler));
