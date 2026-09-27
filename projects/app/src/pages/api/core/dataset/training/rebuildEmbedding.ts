import { NextAPI } from '@/service/middleware/entry';
import { authDataset } from '@fastgpt/service/support/permission/dataset/auth';
import { getEmbeddingModelData } from '@fastgpt/service/core/ai/model';
import { rebuildDatasetEmbedding } from '@fastgpt/service/core/dataset/training/service';
import { type ApiRequestProps } from '@fastgpt/next/type';
import { OwnerPermissionVal } from '@fastgpt/global/support/permission/constant';
import { parseApiInput } from '@fastgpt/service/common/zod/requestParseError';
import {
  RebuildEmbeddingBodySchema,
  RebuildEmbeddingResponseSchema,
  type RebuildEmbeddingResponse
} from '@fastgpt/global/openapi/core/dataset/training/api';

async function handler(req: ApiRequestProps): Promise<RebuildEmbeddingResponse> {
  const { datasetId, vectorModelId } = parseApiInput({
    req,
    bodySchema: RebuildEmbeddingBodySchema
  }).body;

  const { teamId, tmbId, dataset } = await authDataset({
    req,
    authToken: true,
    authApiKey: true,
    datasetId,
    per: OwnerPermissionVal
  });

  await rebuildDatasetEmbedding({
    dataset,
    teamId,
    tmbId,
    vectorModelData: getEmbeddingModelData({ modelId: vectorModelId })
  });

  return RebuildEmbeddingResponseSchema.parse(undefined);
}

export default NextAPI(handler);
