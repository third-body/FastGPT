import type { ApiRequestProps, ApiResponseType } from '@fastgpt/next/type';
import { NextAPI } from '@/service/middleware/entry';
import { withProFallback } from '@/service/support/proApi/withProFallback';
import { authCert } from '@fastgpt/service/support/permission/auth/common';
import { leaveTeam } from '@fastgpt/service/support/user/team/member/controller';

/** 当前用户主动退出团队，无需管理权限；owner 会在 service 层被拦截。 */
async function handler(req: ApiRequestProps, _res: ApiResponseType): Promise<void> {
  const { teamId, tmbId } = await authCert({ req, authToken: true });

  await leaveTeam({ teamId, tmbId });
}

export default withProFallback(NextAPI(handler));
