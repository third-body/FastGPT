import type { ApiRequestProps, ApiResponseType } from '@fastgpt/next/type';
import { NextAPI } from '@/service/middleware/entry';
import { withProFallback } from '@/service/support/proApi/withProFallback';
import { authUserPer } from '@fastgpt/service/support/permission/user/auth';
import { parseApiInput } from '@fastgpt/service/common/zod/requestParseError';
import { MongoOrgModel } from '@fastgpt/service/support/permission/org/orgSchema';
import { replaceRegChars } from '@fastgpt/global/common/string/tools';
import {
  ListOrgBodySchema,
  type ListOrgBodyType
} from '@fastgpt/global/openapi/support/user/team/org/api';

/**
 * 部门列表（只读）。
 *
 * 与成员组同理：协作者选择弹窗会拉取本接口，缺失即报错。
 * 开源版只创建了根部门（createRootOrg），没有部门增删改，
 * 因此这里按 path 层级返回，实际通常只有根部门一条。
 */
async function handler(req: ApiRequestProps<ListOrgBodyType>, _res: ApiResponseType) {
  const { orgId, searchKey } = parseApiInput({ req, bodySchema: ListOrgBodySchema }).body;

  const { teamId } = await authUserPer({ req, authToken: true });

  // 搜索时忽略层级，直接按名称匹配整个团队的部门
  if (searchKey) {
    const orgs = await MongoOrgModel.find({
      teamId,
      name: { $regex: new RegExp(replaceRegChars(searchKey), 'i') }
    }).lean();
    return orgs.map(formatOrg);
  }

  // 未指定 orgId 时从根部门开始；根部门的 path 为空字符串
  const parent = orgId
    ? await MongoOrgModel.findOne({ _id: orgId, teamId }).lean()
    : await MongoOrgModel.findOne({ teamId, path: '' }).lean();

  if (!parent) return [];

  const children = await MongoOrgModel.find({
    teamId,
    path: `${parent.path}/${parent.pathId}`
  }).lean();

  return [parent, ...children].map(formatOrg);
}

/** 统一成契约要求的部门结构。 */
const formatOrg = (org: any) => ({
  _id: String(org._id),
  teamId: String(org.teamId),
  pathId: org.pathId,
  path: org.path,
  name: org.name,
  avatar: org.avatar ?? '',
  updateTime: org.updateTime
});

export default withProFallback(NextAPI(handler));
