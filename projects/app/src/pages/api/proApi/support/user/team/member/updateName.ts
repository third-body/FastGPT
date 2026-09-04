import type { ApiRequestProps, ApiResponseType } from '@fastgpt/next/type';
import { NextAPI } from '@/service/middleware/entry';
import { withProFallback } from '@/service/support/proApi/withProFallback';
import { authCert } from '@fastgpt/service/support/permission/auth/common';
import { parseApiInput } from '@fastgpt/service/common/zod/requestParseError';
import { updateTeamMemberName } from '@fastgpt/service/support/user/team/member/controller';
import {
  UpdateTeamMemberNameBodySchema,
  type UpdateTeamMemberNameBodyType
} from '@fastgpt/global/openapi/support/user/team/member/api';

/** 当前用户修改自己在团队中的显示名，无需团队管理权限。 */
async function handler(
  req: ApiRequestProps<UpdateTeamMemberNameBodyType>,
  _res: ApiResponseType
): Promise<void> {
  const { body } = parseApiInput({ req, bodySchema: UpdateTeamMemberNameBodySchema });

  const { teamId, tmbId } = await authCert({ req, authToken: true });

  await updateTeamMemberName({ teamId, tmbId, name: body.name });
}

export default withProFallback(NextAPI(handler));
