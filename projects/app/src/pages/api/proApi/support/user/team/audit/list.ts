import type { ApiRequestProps, ApiResponseType } from '@fastgpt/next/type';
import { NextAPI } from '@/service/middleware/entry';
import { withProFallback } from '@/service/support/proApi/withProFallback';
import { authUserPer } from '@fastgpt/service/support/permission/user/auth';
import { ManagePermissionVal } from '@fastgpt/global/support/permission/constant';
import { parseApiInput } from '@fastgpt/service/common/zod/requestParseError';
import { parsePaginationRequest } from '@fastgpt/service/common/api/pagination';
import { MongoTeamAudit } from '@fastgpt/service/support/user/audit/schema';
import { addSourceMember } from '@fastgpt/service/support/user/utils';
import { Types } from '@fastgpt/service/common/mongo';
import {
  AuditListBodySchema,
  type AuditListBodyType,
  type AuditListResponseType
} from '@fastgpt/global/openapi/support/user/team/audit/api';

/**
 * 团队操作日志列表。
 *
 * 需要管理权限：日志会暴露谁在什么时候操作了哪些资源，属于敏感信息。
 * 结果按时间倒序，并通过 addSourceMember 补全操作者的成员名与头像。
 */
async function handler(
  req: ApiRequestProps<AuditListBodyType>,
  _res: ApiResponseType
): Promise<AuditListResponseType> {
  const { tmbIds, events } = parseApiInput({ req, bodySchema: AuditListBodySchema }).body;
  const { offset, pageSize } = parsePaginationRequest(req);

  const { teamId } = await authUserPer({ req, authToken: true, per: ManagePermissionVal });

  // 空数组语义是「精确筛选出空集」，不能当作未传处理
  if ((tmbIds && tmbIds.length === 0) || (events && events.length === 0)) {
    return { list: [], total: 0 };
  }

  const match = {
    teamId: new Types.ObjectId(teamId),
    ...(tmbIds ? { tmbId: { $in: tmbIds.map((id) => new Types.ObjectId(id)) } } : {}),
    ...(events ? { event: { $in: events } } : {})
  };

  const [total, logs] = await Promise.all([
    MongoTeamAudit.countDocuments(match),
    MongoTeamAudit.find(match).sort({ timestamp: -1 }).skip(offset).limit(pageSize).lean()
  ]);

  const withMember = await addSourceMember({
    list: logs.map((log) => ({
      _id: String(log._id),
      tmbId: String(log.tmbId),
      event: log.event,
      timestamp: log.timestamp,
      metadata: log.metadata ?? {}
    }))
  });

  /**
   * 回填 metadata.name 为操作人名称。
   *
   * 前端用 `t(content, metadata)` 渲染日志文案，而所有文案模板都以 `【{{name}}】` 开头；
   * 写入侧的 addAuditLog 调用方都不传 name（审计常量里 name 声明为可选正是因此），
   * 不回填的话界面会原样显示 `{{name}}` 占位符。
   * 已显式记录 name 的日志保持原值，不被覆盖。
   */
  const list = withMember.map((item) => ({
    ...item,
    metadata: {
      ...item.metadata,
      name: item.metadata?.name ?? item.sourceMember?.name ?? ''
    }
  }));

  return { list, total } as AuditListResponseType;
}

export default withProFallback(NextAPI(handler));
