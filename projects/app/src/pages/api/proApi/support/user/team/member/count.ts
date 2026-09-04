import type { ApiRequestProps, ApiResponseType } from '@fastgpt/next/type';
import { NextAPI } from '@/service/middleware/entry';
import { withProFallback } from '@/service/support/proApi/withProFallback';
import { authUserPer } from '@fastgpt/service/support/permission/user/auth';
import { countTeamMembers } from '@fastgpt/service/support/user/team/member/controller';
import type { GetTeamMemberCountResponseType } from '@fastgpt/global/openapi/support/user/team/member/api';

async function handler(
  req: ApiRequestProps,
  _res: ApiResponseType
): Promise<GetTeamMemberCountResponseType> {
  const { teamId } = await authUserPer({ req, authToken: true });

  return { count: await countTeamMembers(teamId) };
}

export default withProFallback(NextAPI(handler));
