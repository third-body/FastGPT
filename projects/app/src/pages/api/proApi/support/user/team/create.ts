import type { ApiRequestProps, ApiResponseType } from '@fastgpt/next/type';
import { NextAPI } from '@/service/middleware/entry';
import { withProFallback } from '@/service/support/proApi/withProFallback';
import { authSystemAdmin } from '@fastgpt/service/support/permission/user/auth';
import { parseApiInput } from '@fastgpt/service/common/zod/requestParseError';
import { createTeam } from '@fastgpt/service/support/user/team/multiTeam/controller';
import {
  CreateTeamBodySchema,
  type CreateTeamBodyType,
  type CreateTeamResponseType
} from '@fastgpt/global/openapi/support/user/team/api';

/**
 * 创建新团队。
 *
 * 仅限系统管理员（username === 'root'）。
 * 内部部署场景下若放开给所有登录用户，任何成员都能无节制地开团队：
 * 每个团队都会创建默认成员组、根部门和 ACL，其中的知识库还会占用向量库与对象存储，
 * 而开源版没有套餐配额可以约束。
 */
async function handler(
  req: ApiRequestProps<CreateTeamBodyType>,
  _res: ApiResponseType
): Promise<CreateTeamResponseType> {
  const { name, avatar, memberName } = parseApiInput({
    req,
    bodySchema: CreateTeamBodySchema
  }).body;

  const { userId } = await authSystemAdmin({ req });

  return createTeam({ userId, name, avatar, memberName });
}

export default withProFallback(NextAPI(handler));
