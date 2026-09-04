import type { ApiRequestProps, ApiResponseType } from '@fastgpt/next/type';
import { NextAPI } from '@/service/middleware/entry';
import { withProFallback } from '@/service/support/proApi/withProFallback';
import { authUserPer } from '@fastgpt/service/support/permission/user/auth';
import { parseApiInput } from '@fastgpt/service/common/zod/requestParseError';
import { MongoMemberGroupModel } from '@fastgpt/service/support/permission/memberGroup/memberGroupSchema';
import { replaceRegChars } from '@fastgpt/global/common/string/tools';
import {
  ListGroupBodySchema,
  type ListGroupBodyType
} from '@fastgpt/global/openapi/support/user/team/group/api';

/**
 * 成员组列表（只读）。
 *
 * 开源版尚未实现成员组的增删改，但协作者选择弹窗（MemberManager）在打开时
 * 会无条件拉取本接口，缺失会直接弹「未配置商业版链接」。因此先补上只读实现，
 * 让权限管理可用；withMembers 所需的成员预览暂不返回。
 */
async function handler(req: ApiRequestProps<ListGroupBodyType>, _res: ApiResponseType) {
  const { searchKey } = parseApiInput({ req, bodySchema: ListGroupBodySchema }).body;

  const { teamId } = await authUserPer({ req, authToken: true });

  const groups = await MongoMemberGroupModel.find({
    teamId,
    ...(searchKey ? { name: { $regex: new RegExp(replaceRegChars(searchKey), 'i') } } : {})
  }).lean();

  return groups.map((group) => ({
    _id: String(group._id),
    teamId: String(group.teamId),
    name: group.name,
    avatar: group.avatar,
    updateTime: group.updateTime
  }));
}

export default withProFallback(NextAPI(handler));
