import type { ApiRequestProps, ApiResponseType } from '@fastgpt/next/type';
import { NextAPI } from '@/service/middleware/entry';
import { withProFallback } from '@/service/support/proApi/withProFallback';
import { authCert } from '@fastgpt/service/support/permission/auth/common';
import { listUserTeams } from '@fastgpt/service/support/user/team/member/controller';

/**
 * 返回当前用户所属团队列表。
 * 开源版不支持多团队，结果恒为一条，仅用于让页头的 TeamSelector 正常渲染。
 */
async function handler(req: ApiRequestProps, _res: ApiResponseType) {
  const { userId } = await authCert({ req, authToken: true });

  return listUserTeams(userId);
}

export default withProFallback(NextAPI(handler));
