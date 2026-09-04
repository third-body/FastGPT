import type { ApiRequestProps, ApiResponseType } from '@fastgpt/next/type';
import { NextAPI } from '@/service/middleware/entry';
import { withProFallback } from '@/service/support/proApi/withProFallback';
import { authCert, setCookie } from '@fastgpt/service/support/permission/auth/common';
import { parseApiInput } from '@fastgpt/service/common/zod/requestParseError';
import { assertUserInTeam } from '@fastgpt/service/support/user/team/multiTeam/controller';
import { createUserSession } from '@fastgpt/service/support/user/session';
import { MongoUser } from '@fastgpt/service/support/user/schema';
import { getClientIpFromRequest } from '@fastgpt/service/common/security/clientIp';
import {
  SwitchTeamBodySchema,
  type SwitchTeamBodyType,
  type SwitchTeamResponseType
} from '@fastgpt/global/openapi/support/user/team/api';

/**
 * 切换当前登录团队。
 *
 * 会话里的 teamId/tmbId 是在登录时固化进 session 的，无法就地修改，
 * 因此切换团队必须**签发一条新会话**并覆写 Cookie；旧会话继续有效直至过期，
 * 这与商业版行为一致（同一账号可在多个标签页停留在不同团队）。
 *
 * 目标 teamId 完全来自客户端，assertUserInTeam 是防止越权进入他人团队的关键校验。
 */
async function handler(
  req: ApiRequestProps<SwitchTeamBodyType>,
  res: ApiResponseType
): Promise<SwitchTeamResponseType> {
  const { teamId } = parseApiInput({ req, bodySchema: SwitchTeamBodySchema }).body;

  const { userId, isRoot } = await authCert({ req, authToken: true });

  const tmb = await assertUserInTeam({ userId, teamId });

  const token = await createUserSession({
    userId,
    teamId,
    tmbId: String(tmb._id),
    isRoot,
    ip: getClientIpFromRequest(req)
  });

  // 记住最后使用的团队，下次登录直接进入该团队
  await MongoUser.findByIdAndUpdate(userId, { lastLoginTmbId: tmb._id });

  setCookie(res, token);

  return token;
}

export default withProFallback(NextAPI(handler));
