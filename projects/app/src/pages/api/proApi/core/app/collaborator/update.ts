import type { ApiRequestProps, ApiResponseType } from '@fastgpt/next/type';
import { NextAPI } from '@/service/middleware/entry';
import { withProFallback } from '@/service/support/proApi/withProFallback';
import { authApp } from '@fastgpt/service/support/permission/app/auth';
import {
  ManagePermissionVal,
  PerResourceTypeEnum
} from '@fastgpt/global/support/permission/constant';
import { parseApiInput } from '@fastgpt/service/common/zod/requestParseError';
import { updateResourceCollaboratorList } from '@fastgpt/service/support/permission/resourceCollaboratorService';
import { MongoApp } from '@fastgpt/service/core/app/schema';
import { addAuditLog } from '@fastgpt/service/support/user/audit/util';
import { AuditEventEnum } from '@fastgpt/global/support/user/audit/constants';
import {
  UpdateAppCollaboratorBodySchema,
  type UpdateAppCollaboratorBodyType
} from '@fastgpt/global/openapi/support/permission/api';

/** 覆盖式更新应用协作者，变更会同步到继承本应用权限的子资源。 */
async function handler(
  req: ApiRequestProps<UpdateAppCollaboratorBodyType>,
  _res: ApiResponseType
): Promise<void> {
  const { appId, collaborators } = parseApiInput({
    req,
    bodySchema: UpdateAppCollaboratorBodySchema
  }).body;

  const { app, teamId, tmbId } = await authApp({
    req,
    authToken: true,
    appId,
    per: ManagePermissionVal
  });

  const auditParams = await updateResourceCollaboratorList({
    teamId,
    resourceType: PerResourceTypeEnum.app,
    resource: app,
    resourceModel: MongoApp,
    collaborators
  });

  addAuditLog({
    tmbId,
    teamId,
    event: AuditEventEnum.UPDATE_APP_COLLABORATOR,
    params: { appName: app.name, appType: app.type, ...auditParams }
  });
}

export default withProFallback(NextAPI(handler));
