import type { ApiRequestProps, ApiResponseType } from '@fastgpt/next/type';
import { NextAPI } from '@/service/middleware/entry';
import { withProFallback } from '@/service/support/proApi/withProFallback';
import { authDataset } from '@fastgpt/service/support/permission/dataset/auth';
import {
  ManagePermissionVal,
  PerResourceTypeEnum
} from '@fastgpt/global/support/permission/constant';
import { parseApiInput } from '@fastgpt/service/common/zod/requestParseError';
import { updateResourceCollaboratorList } from '@fastgpt/service/support/permission/resourceCollaboratorService';
import { MongoDataset } from '@fastgpt/service/core/dataset/schema';
import { addAuditLog } from '@fastgpt/service/support/user/audit/util';
import { AuditEventEnum } from '@fastgpt/global/support/user/audit/constants';
import {
  UpdateDatasetCollaboratorBodySchema,
  type UpdateDatasetCollaboratorBody
} from '@fastgpt/global/openapi/core/dataset/api';

/** 覆盖式更新知识库协作者，变更会同步到继承本知识库权限的子资源。 */
async function handler(
  req: ApiRequestProps<UpdateDatasetCollaboratorBody>,
  _res: ApiResponseType
): Promise<void> {
  const { datasetId, collaborators } = parseApiInput({
    req,
    bodySchema: UpdateDatasetCollaboratorBodySchema
  }).body;

  const { dataset, teamId, tmbId } = await authDataset({
    req,
    authToken: true,
    datasetId,
    per: ManagePermissionVal
  });

  const auditParams = await updateResourceCollaboratorList({
    teamId,
    resourceType: PerResourceTypeEnum.dataset,
    resource: dataset,
    resourceModel: MongoDataset,
    collaborators
  });

  addAuditLog({
    tmbId,
    teamId,
    event: AuditEventEnum.UPDATE_DATASET_COLLABORATOR,
    params: { datasetName: dataset.name, datasetType: dataset.type, ...auditParams }
  });
}

export default withProFallback(NextAPI(handler));
