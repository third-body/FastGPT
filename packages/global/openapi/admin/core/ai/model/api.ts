import {
  EmbeddingSystemModelDocumentSchema,
  EmbeddingModelConfigSchema,
  LLMSystemModelDocumentSchema,
  LLMModelConfigSchema,
  RerankSystemModelDocumentSchema,
  RerankModelConfigSchema,
  STTSystemModelDocumentSchema,
  STTModelConfigSchema,
  SystemModelDataSchema,
  SystemModelDocumentDataSchema,
  TTSModelConfigSchema,
  TTSSystemModelDocumentSchema
} from '../../../../../core/ai/model.schema';
import { ModelScopeEnum, ModelTypeEnum } from '../../../../../core/ai/constants';
import { IntSchema } from '../../../../../common/zod';
import z from 'zod';
import { ModelProviderSchema } from '../../../../core/ai/model/api';
import { ModelDefaultIdsSchema } from '../../../../../core/ai/defaultModel';
import { ObjectIdSchema } from '../../../../../common/type/mongo';

const ModelIdSchema = ObjectIdSchema.meta({
  example: '68ad85a7463006c963799a05',
  description: '模型稳定 ObjectId'
});

export const AdminSystemModelReferenceSchema = z.object({
  modelId: ModelIdSchema
});
export type AdminSystemModelReference = z.infer<typeof AdminSystemModelReferenceSchema>;

/* ============================================================================
 * API: 获取管理员系统模型列表
 * Route: GET /api/admin/settings/model/list
 * Method: GET
 * Description: 获取全部系统作用域模型
 * Tags: ['管理员系统配置', 'Read']
 * ============================================================================ */

export const GetAdminSystemModelListResponseSchema = z.object({
  models: z.array(SystemModelDataSchema),
  providers: z.array(ModelProviderSchema),
  defaultModelIds: ModelDefaultIdsSchema,
  aiproxyChannels: z.array(
    z.object({
      channelId: z.number(),
      name: z.object({ en: z.string(), 'zh-CN': z.string(), 'zh-Hant': z.string() }),
      avatar: z.string()
    })
  )
});
export type GetAdminSystemModelListResponse = z.infer<typeof GetAdminSystemModelListResponseSchema>;

/* ============================================================================
 * API: 获取管理员系统模型详情
 * Route: GET /api/admin/settings/model/detail
 * Method: GET
 * Description: 按 modelId 获取系统模型详情
 * Tags: ['管理员系统配置', 'Read']
 * ============================================================================ */

export const GetAdminSystemModelDetailResponseSchema = SystemModelDataSchema;
export type GetAdminSystemModelDetailResponse = z.infer<
  typeof GetAdminSystemModelDetailResponseSchema
>;

/* ============================================================================
 * API: 获取系统模型模板默认配置
 * Route: GET /api/admin/settings/model/getDefaultConfig
 * Method: GET
 * Description: 按 modelId 获取插件模板中的默认配置
 * Tags: ['管理员系统配置', 'Read']
 * ============================================================================ */

export const GetAdminSystemModelDefaultConfigResponseSchema = SystemModelDocumentDataSchema;
export type GetAdminSystemModelDefaultConfigResponse = z.infer<
  typeof GetAdminSystemModelDefaultConfigResponseSchema
>;

/* ============================================================================
 * API: 测试系统模型配置
 * Route: GET /api/admin/settings/model/test
 * Method: GET
 * Description: 按 modelId 测试系统模型调用
 * Tags: ['管理员系统配置', 'Read']
 * ============================================================================ */

export const TestAdminSystemModelQuerySchema = AdminSystemModelReferenceSchema.extend({
  channelId: IntSchema.positive().optional().meta({
    example: 1,
    description: '可选的 AI Proxy 渠道 ID'
  })
});
export type TestAdminSystemModelQuery = z.infer<typeof TestAdminSystemModelQuerySchema>;
export const TestAdminSystemModelResponseSchema = z.unknown();
export type TestAdminSystemModelResponse = z.infer<typeof TestAdminSystemModelResponseSchema>;

/* ============================================================================
 * API: 创建自定义系统模型
 * Route: POST /api/admin/settings/model/create
 * Method: POST
 * Description: 按最新持久化结构创建自定义系统模型
 * Tags: ['管理员系统配置', 'Write']
 * ============================================================================ */

export const CreateSystemModelBodySchema = z.object({
  modelData: SystemModelDocumentDataSchema.meta({ description: '完整的系统模型配置' })
});
export type CreateSystemModelBody = z.infer<typeof CreateSystemModelBodySchema>;
export const CreateSystemModelResponseSchema = z.object({
  modelId: ModelIdSchema
});
export type CreateSystemModelResponse = z.infer<typeof CreateSystemModelResponseSchema>;

/* ============================================================================
 * API: 更新系统模型配置
 * Route: PUT /api/admin/settings/model/update
 * Method: PUT
 * Description: 只按 modelId 更新已有系统模型，不执行 upsert 或历史结构修复
 * Tags: ['管理员系统配置', 'Write']
 * ============================================================================ */

export const UpdateSystemModelBodySchema = z.object({
  modelId: ModelIdSchema,
  modelData: SystemModelDocumentDataSchema.meta({ description: '完整的系统模型配置' })
});
export type UpdateSystemModelBody = z.infer<typeof UpdateSystemModelBodySchema>;

// 配置 JSON 允许来自其他实例的 ID；导入逻辑只把本实例真实 ObjectId 用作 `_id`，其余按 model 对齐。
const ImportedModelIdField = {
  modelId: z.string().trim().min(1).meta({
    example: 'source-instance-model-id',
    description: '源实例模型 ID，仅用于导入时识别记录'
  }),
  scope: z.literal(ModelScopeEnum.system).meta({ description: '系统模型作用域' })
};

export const ImportedSystemModelSchema = z.discriminatedUnion('type', [
  LLMSystemModelDocumentSchema.extend({
    ...ImportedModelIdField,
    config: LLMModelConfigSchema
  }),
  EmbeddingSystemModelDocumentSchema.extend({
    ...ImportedModelIdField,
    config: EmbeddingModelConfigSchema
  }),
  TTSSystemModelDocumentSchema.extend({
    ...ImportedModelIdField,
    config: TTSModelConfigSchema
  }),
  STTSystemModelDocumentSchema.extend({
    ...ImportedModelIdField,
    config: STTModelConfigSchema
  }),
  RerankSystemModelDocumentSchema.extend({
    ...ImportedModelIdField,
    config: RerankModelConfigSchema
  })
]);
export type ImportedSystemModel = z.infer<typeof ImportedSystemModelSchema>;

const ImportedSystemModelRecordListSchema = z.array(z.record(z.string(), z.unknown()));
const JsonSystemModelListSchema = z.string().transform((value, ctx) => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    ctx.addIssue({ code: 'custom', message: 'config must be valid JSON' });
    return z.NEVER;
  }
});

/* ============================================================================
 * API: 导入系统模型配置
 * Route: PUT /api/admin/settings/model/updateWithJson
 * Method: PUT
 * Description: 忽略无 modelId 的旧记录，按 modelId 更新或按 model 创建外部实例记录
 * Tags: ['管理员系统配置', 'Write']
 * ============================================================================ */

export const UpdateSystemModelsWithJsonBodySchema = z.object({
  config: JsonSystemModelListSchema.pipe(ImportedSystemModelRecordListSchema).meta({
    example:
      '[{"modelId":"68ad85a7463006c963799a05","scope":"system","type":"llm","provider":"OpenAI","model":"gpt-5","name":"GPT-5","isActive":true,"config":{"maxContext":400000,"maxResponse":128000,"quoteMaxToken":300000,"toolChoice":true}}]',
    description: '最新系统模型配置 JSON；无 modelId 的旧记录会被忽略'
  })
});
export type UpdateSystemModelsWithJsonBody = z.input<typeof UpdateSystemModelsWithJsonBodySchema>;
export type ParsedSystemModelsWithJsonBody = z.output<typeof UpdateSystemModelsWithJsonBodySchema>;

/* ============================================================================
 * API: 导出系统模型配置
 * Route: GET /api/admin/settings/model/getConfigJson
 * Method: GET
 * Description: 导出包含 modelId 的最新系统模型配置 JSON
 * Tags: ['管理员系统配置', 'Read']
 * ============================================================================ */

export const GetSystemModelConfigJsonResponseSchema = z.string().meta({
  description: '最新系统模型配置 JSON 字符串'
});
export type GetSystemModelConfigJsonResponse = z.infer<
  typeof GetSystemModelConfigJsonResponseSchema
>;

/* ============================================================================
 * API: 更新系统默认模型
 * Route: PUT /api/admin/settings/model/updateDefault
 * Method: PUT
 * Description: 按 string modelId 更新各类型及系统用途的默认模型
 * Tags: ['管理员系统配置', 'Write']
 * ============================================================================ */

export const UpdateDefaultModelsBodySchema = z.object({
  [ModelTypeEnum.llm]: ModelIdSchema.optional(),
  [ModelTypeEnum.embedding]: ModelIdSchema.optional(),
  [ModelTypeEnum.tts]: ModelIdSchema.optional(),
  [ModelTypeEnum.stt]: ModelIdSchema.optional(),
  [ModelTypeEnum.rerank]: ModelIdSchema.optional(),
  datasetTextLLMModelId: ModelIdSchema.optional(),
  datasetImageLLMModelId: ModelIdSchema.optional(),
  chatTitleLLMModelId: ModelIdSchema.optional()
});
export type UpdateDefaultModelsBody = z.infer<typeof UpdateDefaultModelsBodySchema>;

/* ============================================================================
 * API: 预览 / 执行模型替换
 * Route: POST /api/admin/settings/model/replace/preview
 * Route: POST /api/admin/settings/model/replace
 * Method: POST
 * Description: 把全部资源中对源模型的引用替换为目标模型；预览只统计不写入
 * Tags: ['管理员系统配置', 'Write']
 * ============================================================================ */

export const ReplaceSystemModelBodySchema = z.object({
  sourceModelId: ModelIdSchema.meta({ description: '被替换的模型 ID，允许已停用' }),
  targetModelId: ModelIdSchema.meta({ description: '替换后的模型 ID，必须已启用且类型一致' })
});
export type ReplaceSystemModelBody = z.infer<typeof ReplaceSystemModelBodySchema>;

export const ModelReplaceItemKeySchema = z
  .enum([
    'datasetAgentModel',
    'datasetVlmModel',
    'datasetVlmModelCleared',
    'datasetVectorModel',
    'app',
    'appVersion',
    'appTemplate',
    'evaluation',
    'defaultModel'
  ])
  .meta({
    description:
      '引用位置：知识库文本理解/图片理解/被清空的图片理解/索引模型、应用草稿、应用版本、应用模板、评测、系统默认模型'
  });
export type ModelReplaceItemKey = z.infer<typeof ModelReplaceItemKeySchema>;

export const ReplaceSystemModelResponseSchema = z.object({
  items: z.array(
    z.object({
      key: ModelReplaceItemKeySchema,
      matched: z.number().meta({ description: '命中引用的资源数' }),
      updated: z.number().meta({ description: '已改写的资源数，预览时为 0' }),
      skipped: z.number().meta({ description: '跳过的资源数（如知识库正在训练）' })
    })
  ),
  rebuildDataCount: z.number().meta({ description: '索引模型替换时需要重建的数据条数' }),
  targetRestricted: z
    .boolean()
    .meta({ description: '目标模型是否配置了成员可用权限，受限时部分成员可能无权使用' }),
  failures: z.array(
    z.object({
      key: ModelReplaceItemKeySchema,
      resourceId: z.string(),
      name: z.string().optional(),
      reason: z.string()
    })
  )
});
export type ReplaceSystemModelResponse = z.infer<typeof ReplaceSystemModelResponseSchema>;
