import type { ApiRequestProps, ApiResponseType } from '@fastgpt/next/type';
import { NextAPI } from '@/service/middleware/entry';
import { withProFallback } from '@/service/support/proApi/withProFallback';
import { authApp } from '@fastgpt/service/support/permission/app/auth';
import { ManagePermissionVal } from '@fastgpt/global/support/permission/constant';
import { PerResourceTypeEnum } from '@fastgpt/global/support/permission/constant';
import { parseApiInput } from '@fastgpt/service/common/zod/requestParseError';
import { getResourceCollaboratorList } from '@fastgpt/service/support/permission/resourceCollaboratorService';
import {
  GetAppCollaboratorListQuerySchema,
  type GetAppCollaboratorListResponseType
} from '@fastgpt/global/openapi/support/permission/api';

/** 读取应用协作者列表。需管理权限——能看到谁有权限本身就是敏感信息。 */
async function handler(
  req: ApiRequestProps,
  _res: ApiResponseType
): Promise<GetAppCollaboratorListResponseType> {
  const { appId, showUsername } = parseApiInput({
    req,
    querySchema: GetAppCollaboratorListQuerySchema
  }).query;

  const { app, teamId } = await authApp({
    req,
    authToken: true,
    appId,
    per: ManagePermissionVal
  });

  return getResourceCollaboratorList({
    teamId,
    resourceType: PerResourceTypeEnum.app,
    resource: app,
    ownerTmbId: String(app.tmbId),
    showUsername
  }) as Promise<GetAppCollaboratorListResponseType>;
}

export default withProFallback(NextAPI(handler));
