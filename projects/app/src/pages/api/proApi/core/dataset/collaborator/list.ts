import type { ApiRequestProps, ApiResponseType } from '@fastgpt/next/type';
import { NextAPI } from '@/service/middleware/entry';
import { withProFallback } from '@/service/support/proApi/withProFallback';
import { authDataset } from '@fastgpt/service/support/permission/dataset/auth';
import {
  ManagePermissionVal,
  PerResourceTypeEnum
} from '@fastgpt/global/support/permission/constant';
import { parseApiInput } from '@fastgpt/service/common/zod/requestParseError';
import { getResourceCollaboratorList } from '@fastgpt/service/support/permission/resourceCollaboratorService';
import {
  GetDatasetCollaboratorListQuerySchema,
  type GetDatasetCollaboratorListResponse
} from '@fastgpt/global/openapi/core/dataset/api';

/** 读取知识库协作者列表。需管理权限。 */
async function handler(
  req: ApiRequestProps,
  _res: ApiResponseType
): Promise<GetDatasetCollaboratorListResponse> {
  const { datasetId, showUsername } = parseApiInput({
    req,
    querySchema: GetDatasetCollaboratorListQuerySchema
  }).query;

  const { dataset, teamId } = await authDataset({
    req,
    authToken: true,
    datasetId,
    per: ManagePermissionVal
  });

  return getResourceCollaboratorList({
    teamId,
    resourceType: PerResourceTypeEnum.dataset,
    resource: dataset,
    ownerTmbId: String(dataset.tmbId),
    showUsername
  }) as Promise<GetDatasetCollaboratorListResponse>;
}

export default withProFallback(NextAPI(handler));
