import type { ApiRequestProps } from '@fastgpt/next/type';
import { NextAPI } from '@/service/middleware/entry';
import { authSystemAdmin } from '@fastgpt/service/support/permission/user/auth';
import { parseApiInput } from '@fastgpt/service/common/zod/requestParseError';
import { replaceSystemModel } from '@fastgpt/service/core/ai/replace/service';
import {
  ReplaceSystemModelBodySchema,
  ReplaceSystemModelResponseSchema,
  type ReplaceSystemModelBody,
  type ReplaceSystemModelResponse
} from '@fastgpt/global/openapi/admin/core/ai/model/api';

/** 预览模型替换：只统计各类资源中引用源模型的数量，不写入任何数据。仅系统管理员可用。 */
async function handler(
  req: ApiRequestProps<ReplaceSystemModelBody>
): Promise<ReplaceSystemModelResponse> {
  await authSystemAdmin({ req });
  const { sourceModelId, targetModelId } = parseApiInput({
    req,
    bodySchema: ReplaceSystemModelBodySchema
  }).body;

  const report = await replaceSystemModel({ sourceModelId, targetModelId, dryRun: true });
  return ReplaceSystemModelResponseSchema.parse(report);
}

export default NextAPI(handler);
