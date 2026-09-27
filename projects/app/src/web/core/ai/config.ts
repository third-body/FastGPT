import { DELETE, GET, POST, PUT } from '@/web/common/api/request';
import type {
  SystemModelDataType,
  SystemModelDocumentDataType
} from '@fastgpt/global/core/ai/model.schema';
import type {
  AdminSystemModelReference,
  CreateSystemModelBody,
  CreateSystemModelResponse,
  GetAdminSystemModelListResponse,
  ReplaceSystemModelBody,
  ReplaceSystemModelResponse,
  TestAdminSystemModelQuery,
  UpdateDefaultModelsBody,
  UpdateSystemModelBody,
  UpdateSystemModelsWithJsonBody
} from '@fastgpt/global/openapi/admin/core/ai/model/api';

const adminModelPath = '/admin/settings/model';

export const getSystemModelList = () =>
  GET<GetAdminSystemModelListResponse>(`${adminModelPath}/list`).then((res) => res.models);
export const getAdminModelConfig = () =>
  GET<GetAdminSystemModelListResponse>(`${adminModelPath}/list`);
export const getSystemModelDetail = (modelId: string) =>
  GET<SystemModelDataType>(`${adminModelPath}/detail`, { modelId });

export const getSystemModelDefaultConfig = (modelId: string) =>
  GET<SystemModelDocumentDataType>(`${adminModelPath}/getDefaultConfig`, { modelId });

export const postSystemModel = (data: CreateSystemModelBody) =>
  POST<CreateSystemModelResponse>(`${adminModelPath}/create`, data);
export const putSystemModel = (data: UpdateSystemModelBody) =>
  PUT(`${adminModelPath}/update`, data);

export const deleteSystemModel = (data: AdminSystemModelReference) =>
  DELETE(`${adminModelPath}/delete`, data);

export const getModelConfigJson = () => GET<string>(`${adminModelPath}/getConfigJson`);
export const putUpdateWithJson = (data: UpdateSystemModelsWithJsonBody) =>
  PUT(`${adminModelPath}/updateWithJson`, data);

export const getTestModel = (data: TestAdminSystemModelQuery) =>
  GET(`${adminModelPath}/test`, data);

export const putUpdateDefaultModels = (data: UpdateDefaultModelsBody) =>
  PUT(`${adminModelPath}/updateDefault`, data);

/** 预览模型替换：统计引用源模型的资源数量，不写入。 */
export const postReplaceSystemModelPreview = (data: ReplaceSystemModelBody) =>
  POST<ReplaceSystemModelResponse>(`${adminModelPath}/replace/preview`, data);
/** 执行模型替换；索引模型替换会触发知识库重建，耗时较长。 */
export const postReplaceSystemModel = (data: ReplaceSystemModelBody) =>
  POST<ReplaceSystemModelResponse>(`${adminModelPath}/replace`, data, { timeout: 600000 });
