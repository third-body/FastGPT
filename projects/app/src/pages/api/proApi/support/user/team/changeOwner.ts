import type { ApiRequestProps, ApiResponseType } from '@fastgpt/next/type';
import { NextAPI } from '@/service/middleware/entry';
import { withProFallback } from '@/service/support/proApi/withProFallback';
import { authUserPer } from '@fastgpt/service/support/permission/user/auth';
import { ManagePermissionVal } from '@fastgpt/global/support/permission/constant';
import { parseApiInput } from '@fastgpt/service/common/zod/requestParseError';
import { changeTeamOwner } from '@fastgpt/service/support/user/team/multiTeam/controller';
import {
  TeamChangeOwnerBodySchema,
  type TeamChangeOwnerBodyType
} from '@fastgpt/global/openapi/support/user/team/api';

/** 转让团队所有权。仅当前所有者可执行，service 层会再校验一次 owner 身份。 */
async function handler(
  req: ApiRequestProps<TeamChangeOwnerBodyType>,
  _res: ApiResponseType
): Promise<void> {
  const { userId: newOwnerUserId } = parseApiInput({
    req,
    bodySchema: TeamChangeOwnerBodySchema
  }).body;

  const { teamId, tmbId } = await authUserPer({
    req,
    authToken: true,
    per: ManagePermissionVal
  });

  // 现有审计事件中没有「团队所有权转让」这一项，硬套 ADMIN_UPDATE_TEAM
  // 会要求 teamName/newBalance 等无关字段并写出误导性日志，
  // 故此处不落审计，由 service 层的 logger 记录转让前后的 tmbId。
  await changeTeamOwner({ teamId, currentTmbId: tmbId, newOwnerUserId });
}

export default withProFallback(NextAPI(handler));
