import type { ApiRequestProps, ApiResponseType } from '@fastgpt/next/type';
import { NextAPI } from '@/service/middleware/entry';
import { withProFallback } from '@/service/support/proApi/withProFallback';
import { authUserPer } from '@fastgpt/service/support/permission/user/auth';
import { parseApiInput } from '@fastgpt/service/common/zod/requestParseError';
import { MongoTeamMember } from '@fastgpt/service/support/user/team/teamMemberSchema';
import { MongoUser } from '@fastgpt/service/support/user/schema';
import { MongoMemberGroupModel } from '@fastgpt/service/support/permission/memberGroup/memberGroupSchema';
import { MongoOrgModel } from '@fastgpt/service/support/permission/org/orgSchema';
import { MongoOrgMemberModel } from '@fastgpt/service/support/permission/org/orgMemberSchema';
import { TeamMemberStatusEnum } from '@fastgpt/global/support/user/team/constant';
import { replaceRegChars } from '@fastgpt/global/common/string/tools';
import {
  SearchMembersOrgsGroupsQuerySchema,
  type SearchMembersOrgsGroupsResponseType
} from '@fastgpt/global/openapi/support/user/team/api';

/**
 * 聚合搜索团队成员、部门和成员组。
 *
 * 协作者选择弹窗（MemberManager）的搜索框直接打这个接口，缺失会弹
 * 「未配置商业版链接」。按契约约定：searchKey 为空时返回空结果，
 * 三个开关默认都为 true。
 */
async function handler(
  req: ApiRequestProps,
  _res: ApiResponseType
): Promise<SearchMembersOrgsGroupsResponseType> {
  const { searchKey, members, orgs, groups } = parseApiInput({
    req,
    querySchema: SearchMembersOrgsGroupsQuerySchema
  }).query;

  const { teamId } = await authUserPer({ req, authToken: true });

  const empty = { members: [], orgs: [], groups: [] };
  if (!searchKey) return empty as SearchMembersOrgsGroupsResponseType;

  const regex = new RegExp(replaceRegChars(searchKey), 'i');

  const [memberList, orgList, groupList] = await Promise.all([
    members === false ? [] : searchMembers({ teamId, regex }),
    orgs === false ? [] : searchOrgs({ teamId, regex }),
    groups === false ? [] : searchGroups({ teamId, regex })
  ]);

  return {
    members: memberList,
    orgs: orgList,
    groups: groupList
  } as SearchMembersOrgsGroupsResponseType;
}

/** 成员搜索需同时覆盖团队内成员名和用户登录名，后者在 users 表。 */
async function searchMembers({ teamId, regex }: { teamId: string; regex: RegExp }) {
  const matchedUsers = await MongoUser.find({ username: regex }, { _id: 1 }).lean();

  const tmbs = await MongoTeamMember.find({
    teamId,
    status: TeamMemberStatusEnum.active,
    $or: [
      { name: regex },
      ...(matchedUsers.length ? [{ userId: { $in: matchedUsers.map((u) => u._id) } }] : [])
    ]
  })
    .limit(20)
    .lean();

  return tmbs.map((tmb) => ({
    tmbId: String(tmb._id),
    userId: String(tmb.userId),
    teamId: String(tmb.teamId),
    name: tmb.name,
    memberName: tmb.name,
    avatar: tmb.avatar,
    status: (tmb.status ?? TeamMemberStatusEnum.active) as TeamMemberStatusEnum,
    ...(tmb.role ? { role: tmb.role } : {})
  }));
}

/** 部门搜索。total 为该部门下的成员数与子部门数之和，用于列表右侧计数。 */
async function searchOrgs({ teamId, regex }: { teamId: string; regex: RegExp }) {
  const orgList = await MongoOrgModel.find({ teamId, name: regex }).limit(20).lean();

  return Promise.all(
    orgList.map(async (org) => {
      const [memberCount, childCount] = await Promise.all([
        MongoOrgMemberModel.countDocuments({ teamId, orgId: org._id }),
        MongoOrgModel.countDocuments({ teamId, path: `${org.path}/${org.pathId}` })
      ]);
      return {
        _id: String(org._id),
        teamId: String(org.teamId),
        pathId: org.pathId,
        path: org.path,
        name: org.name,
        avatar: org.avatar ?? '',
        ...(org.description ? { description: org.description } : {}),
        updateTime: org.updateTime,
        total: memberCount + childCount
      };
    })
  );
}

async function searchGroups({ teamId, regex }: { teamId: string; regex: RegExp }) {
  const groupList = await MongoMemberGroupModel.find({ teamId, name: regex }).limit(20).lean();

  return groupList.map((group) => ({
    _id: String(group._id),
    teamId: String(group.teamId),
    name: group.name,
    avatar: group.avatar,
    updateTime: group.updateTime
  }));
}

export default withProFallback(NextAPI(handler));
