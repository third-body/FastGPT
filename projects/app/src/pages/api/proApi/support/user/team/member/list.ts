import type { ApiRequestProps, ApiResponseType } from '@fastgpt/next/type';
import { NextAPI } from '@/service/middleware/entry';
import { withProFallback } from '@/service/support/proApi/withProFallback';
import { authUserPer } from '@fastgpt/service/support/permission/user/auth';
import { parseApiInput } from '@fastgpt/service/common/zod/requestParseError';
import { parsePaginationRequest } from '@fastgpt/service/common/api/pagination';
import { listTeamMembers } from '@fastgpt/service/support/user/team/member/controller';
import {
  ListTeamMembersBodySchema,
  type ListTeamMembersBodyType,
  type ListTeamMembersResponseType
} from '@fastgpt/global/openapi/support/user/team/member/api';

async function handler(
  req: ApiRequestProps<ListTeamMembersBodyType>,
  _res: ApiResponseType
): Promise<ListTeamMembersResponseType> {
  const { body } = parseApiInput({ req, bodySchema: ListTeamMembersBodySchema });
  const { offset, pageSize } = parsePaginationRequest(req);

  // 列表对所有团队成员开放，不要求管理权限
  const { teamId, tmbId } = await authUserPer({ req, authToken: true });

  return listTeamMembers({
    teamId,
    currentTmbId: tmbId,
    offset,
    pageSize,
    searchKey: body.searchKey,
    status: body.status,
    tmbIds: body.tmbIds,
    currentFirst: body.currentFirst,
    withPermission: body.withPermission
  });
}

export default withProFallback(NextAPI(handler));
