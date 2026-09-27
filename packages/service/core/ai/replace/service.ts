import type {
  ModelReplaceItemKey,
  ReplaceSystemModelResponse
} from '@fastgpt/global/openapi/admin/core/ai/model/api';
import { ModelTypeEnum } from '@fastgpt/global/core/ai/constants';
import { ModelErrEnum } from '@fastgpt/global/common/error/code/model';
import { UserError, getErrText } from '@fastgpt/global/common/error/utils';
import { PerResourceTypeEnum } from '@fastgpt/global/support/permission/constant';
import type { ModelDefaultIds } from '@fastgpt/global/core/ai/defaultModel';
import { Types } from '../../../common/mongo';
import { get } from 'lodash-es';
import { DatasetTypeEnum } from '@fastgpt/global/core/dataset/constants';
import { findModelData, getEmbeddingModelData } from '../model';
import { findSystemDefaultModelIds, upsertSystemDefaultModelIds } from '../defaultModel/entity';
import { updatedReloadSystemModel } from '../config/utils';
import { MongoDataset } from '../../dataset/schema';
import { MongoDatasetData } from '../../dataset/data/schema';
import { rebuildDatasetEmbedding } from '../../dataset/training/service';
import { MongoEvaluation } from '../../app/evaluation/evalSchema';
import { MongoApp } from '../../app/schema';
import { MongoAppVersion } from '../../app/version/schema';
import { MongoAppTemplate } from '../../app/templates/templateSchema';
import { MongoResourcePermission } from '../../../support/permission/schema';
import {
  replaceChatConfigModelRefs,
  replaceFlatModelRefs,
  replaceWorkflowNodeModelRefs,
  type ModelReplaceContext
} from './utils';

type ReplaceReport = ReplaceSystemModelResponse;

/**
 * 把全部资源中对源模型的引用替换为目标模型；`dryRun` 为 true 时只统计不写入（预览）。
 *
 * 覆盖范围：知识库文本理解/图片理解/索引模型、应用草稿、应用全部历史版本、应用模板、评测、
 * 系统默认模型。按引用 ID 精确匹配，同时兼容迁移前只保存 legacy model 标识的历史数据。
 *
 * 关键规则：
 * - 源模型必须仍存在（可已停用），目标模型必须已启用，二者类型一致；
 * - 索引模型不能直接改 ID（向量不兼容），改为逐个知识库调用重建，计费记到知识库所有者；
 *   正在训练/重建的知识库跳过并计入 failures，可稍后再次执行；
 * - 目标模型不支持视觉时，引用源模型作为图片理解模型的知识库改为清空该配置；
 *   默认图片理解模型槽位同理跳过；
 * - 同步执行，单条资源失败不影响其它资源，失败原因收集在 failures 中。
 */
export const replaceSystemModel = async ({
  sourceModelId,
  targetModelId,
  dryRun
}: {
  sourceModelId: string;
  targetModelId: string;
  dryRun: boolean;
}): Promise<ReplaceReport> => {
  const source = findModelData({ modelId: sourceModelId });
  const target = findModelData({ modelId: targetModelId });
  if (!source || !target || !target.isActive) throw new UserError(ModelErrEnum.unExist);
  if (source.modelId === target.modelId) throw new UserError('源模型与目标模型不能相同');
  if (source.type !== target.type) throw new UserError('源模型与目标模型类型不一致');

  const ctx: ModelReplaceContext = {
    sourceModelId: source.modelId,
    sourceModel: source.model,
    targetModelId: target.modelId
  };
  const targetSupportsVision = target.type === ModelTypeEnum.llm && !!target.config.vision;

  const report: ReplaceReport = {
    items: [],
    rebuildDataCount: 0,
    targetRestricted: !!(await MongoResourcePermission.exists({
      resourceType: PerResourceTypeEnum.model,
      resourceId: target.modelId
    })),
    failures: []
  };
  const getItem = (key: ModelReplaceItemKey) => {
    let item = report.items.find((i) => i.key === key);
    if (!item) {
      item = { key, matched: 0, updated: 0, skipped: 0 };
      report.items.push(item);
    }
    return item;
  };
  // 单条资源写入失败只记录，不中断整体替换
  const runSafely = async ({
    key,
    resourceId,
    name,
    fn
  }: {
    key: ModelReplaceItemKey;
    resourceId: unknown;
    name?: string;
    fn: () => Promise<unknown>;
  }) => {
    const item = getItem(key);
    item.matched++;
    if (dryRun) return;
    try {
      await fn();
      item.updated++;
    } catch (error) {
      item.skipped++;
      report.failures.push({
        key,
        resourceId: String(resourceId),
        name,
        reason: getErrText(error)
      });
    }
  };

  // 历史数据中的模型 ID 可能以 BSON ObjectId 存储，查询时两种形态都要匹配
  const sourceIdValues = [ctx.sourceModelId, new Types.ObjectId(ctx.sourceModelId)];
  /** 构造“ID 字段等于源 ID，或 ID 缺失/为 null 且 legacy 字段等于源 model”的候选查询条件 */
  const flatRefQuery = (idKey: string, legacyKey: string) => [
    { [idKey]: { $in: sourceIdValues } },
    { [idKey]: null, [legacyKey]: ctx.sourceModel }
  ];
  /**
   * 用原生 collection 按候选条件取 _id，再交给 Mongoose 读取完整文档。
   * Mongoose 会把 String 字段上的查询值强转为字符串，导致 ObjectId 形态的历史 ID 查不到。
   */
  const findCandidateIds = (collection: typeof MongoDataset.collection, query: object) =>
    collection.distinct('_id', query);

  /* ---------- 知识库 ---------- */
  if (source.type === ModelTypeEnum.embedding) {
    const datasets = await MongoDataset.find({
      _id: {
        $in: await findCandidateIds(MongoDataset.collection, {
          deleteTime: null,
          $or: flatRefQuery('vectorModelId', 'vectorModel')
        })
      }
    }).lean();

    report.rebuildDataCount = datasets.length
      ? await MongoDatasetData.countDocuments({ datasetId: { $in: datasets.map((d) => d._id) } })
      : 0;

    const vectorModelData = getEmbeddingModelData({ modelId: target.modelId });
    for (const dataset of datasets) {
      await runSafely({
        key: 'datasetVectorModel',
        resourceId: dataset._id,
        name: dataset.name,
        // 文件夹没有数据，直接改 ID，避免重建流程生成空的训练账单
        fn: () =>
          dataset.type === DatasetTypeEnum.folder
            ? MongoDataset.updateOne(
                { _id: dataset._id },
                { $set: { vectorModelId: vectorModelData.modelId } }
              )
            : rebuildDatasetEmbedding({
                dataset,
                teamId: String(dataset.teamId),
                tmbId: String(dataset.tmbId),
                vectorModelData
              })
      });
    }
  }

  if (source.type === ModelTypeEnum.llm) {
    const datasets = await MongoDataset.find({
      _id: {
        $in: await findCandidateIds(MongoDataset.collection, {
          deleteTime: null,
          $or: [
            ...flatRefQuery('agentModelId', 'agentModel'),
            ...flatRefQuery('vlmModelId', 'vlmModel')
          ]
        })
      }
    }).lean();

    for (const dataset of datasets) {
      const agentSet = replaceFlatModelRefs({
        record: dataset,
        fields: [{ idKey: 'agentModelId', legacyKey: 'agentModel' }],
        ctx
      });
      const vlmSet = replaceFlatModelRefs({
        record: dataset,
        fields: [{ idKey: 'vlmModelId', legacyKey: 'vlmModel' }],
        ctx
      });

      if (agentSet) {
        await runSafely({
          key: 'datasetAgentModel',
          resourceId: dataset._id,
          name: dataset.name,
          fn: () => MongoDataset.updateOne({ _id: dataset._id }, { $set: agentSet })
        });
      }
      if (vlmSet) {
        // 目标不支持视觉时不能作为图片理解模型，VLM 为可选配置，直接清空
        await runSafely({
          key: targetSupportsVision ? 'datasetVlmModel' : 'datasetVlmModelCleared',
          resourceId: dataset._id,
          name: dataset.name,
          fn: () =>
            MongoDataset.updateOne(
              { _id: dataset._id },
              targetSupportsVision ? { $set: vlmSet } : { $unset: { vlmModelId: 1, vlmModel: 1 } }
            )
        });
      }
    }

    /* ---------- 评测 ---------- */
    const evaluations = await MongoEvaluation.find({
      _id: {
        $in: await findCandidateIds(MongoEvaluation.collection, {
          $or: flatRefQuery('evalModelId', 'evalModel')
        })
      }
    }).lean();
    for (const evaluation of evaluations) {
      const set = replaceFlatModelRefs({
        record: evaluation,
        fields: [{ idKey: 'evalModelId', legacyKey: 'evalModel' }],
        ctx
      });
      if (!set) continue;
      await runSafely({
        key: 'evaluation',
        resourceId: evaluation._id,
        name: evaluation.name,
        fn: () => MongoEvaluation.updateOne({ _id: evaluation._id }, { $set: set })
      });
    }
  }

  /* ---------- 工作流：应用草稿 / 全部版本 / 模板 ---------- */
  // 模型引用嵌在节点 inputs 中，先用宽松条件筛出候选文档，再由 transform 精确判断
  const workflowCandidateQuery = (nodesPath: string, chatConfigPath: string) => ({
    $or: [
      { [`${nodesPath}.inputs.value`]: { $in: [...sourceIdValues, ctx.sourceModel] } },
      { [`${nodesPath}.inputs.value.rerankModelId`]: { $in: sourceIdValues } },
      { [`${nodesPath}.inputs.value.rerankModel`]: ctx.sourceModel },
      { [`${nodesPath}.inputs.value.datasetSearchExtensionModelId`]: { $in: sourceIdValues } },
      { [`${nodesPath}.inputs.value.datasetSearchExtensionModel`]: ctx.sourceModel },
      ...['questionGuide', 'ttsConfig'].flatMap((key) => [
        { [`${chatConfigPath}.${key}.modelId`]: { $in: sourceIdValues } },
        { [`${chatConfigPath}.${key}.model`]: ctx.sourceModel }
      ])
    ]
  });
  // 使用原生 collection 读写，避免 Mongoose 按 Schema 改写历史节点结构
  const workflowStages: {
    key: ModelReplaceItemKey;
    collection: typeof MongoApp.collection;
    nodesPaths: string[];
    chatConfigPath: string;
  }[] = [
    {
      key: 'app',
      collection: MongoApp.collection,
      nodesPaths: ['modules'],
      chatConfigPath: 'chatConfig'
    },
    {
      key: 'appVersion',
      collection: MongoAppVersion.collection,
      nodesPaths: ['nodes'],
      chatConfigPath: 'chatConfig'
    },
    {
      key: 'appTemplate',
      collection: MongoAppTemplate.collection,
      nodesPaths: ['workflow.nodes', 'workflow.modules'],
      chatConfigPath: 'workflow.chatConfig'
    }
  ];

  for (const stage of workflowStages) {
    const query = {
      $or: stage.nodesPaths.flatMap(
        (nodesPath) => workflowCandidateQuery(nodesPath, stage.chatConfigPath).$or
      )
    };
    // 只取改写与报告需要的字段，历史版本的节点快照体积较大
    const projection = Object.fromEntries(
      ['name', 'versionName', ...stage.nodesPaths, stage.chatConfigPath].map((path) => [path, 1])
    );
    const cursor = stage.collection.find(query, { projection });
    for await (const doc of cursor) {
      const set: Record<string, unknown> = {};
      for (const nodesPath of stage.nodesPaths) {
        const result = replaceWorkflowNodeModelRefs({ nodes: get(doc, nodesPath), ctx });
        if (result.changed) set[nodesPath] = result.nodes;
      }
      const chatConfigResult = replaceChatConfigModelRefs({
        chatConfig: get(doc, stage.chatConfigPath),
        ctx
      });
      if (chatConfigResult.changed) set[stage.chatConfigPath] = chatConfigResult.chatConfig;
      if (Object.keys(set).length === 0) continue;

      await runSafely({
        key: stage.key,
        resourceId: doc._id,
        name: doc.name ?? doc.versionName,
        fn: () => stage.collection.updateOne({ _id: doc._id }, { $set: set })
      });
    }
  }

  /* ---------- 系统默认模型 ---------- */
  const defaults = await findSystemDefaultModelIds();
  const nextDefaults: ModelDefaultIds = { ...defaults };
  let defaultsChanged = false;
  for (const [slot, modelId] of Object.entries(defaults) as [keyof ModelDefaultIds, string][]) {
    if (modelId !== ctx.sourceModelId) continue;
    const item = getItem('defaultModel');
    item.matched++;
    // 默认图片理解模型必须支持视觉，目标不满足时保留原值，由加载阶段按同类型回退
    if (slot === 'datasetImageLLM' && !targetSupportsVision) {
      item.skipped++;
      report.failures.push({
        key: 'defaultModel',
        resourceId: slot,
        reason: '目标模型不支持视觉，不能作为默认图片理解模型'
      });
      continue;
    }
    nextDefaults[slot] = ctx.targetModelId;
    defaultsChanged = true;
    if (!dryRun) item.updated++;
  }
  if (!dryRun && defaultsChanged) {
    await upsertSystemDefaultModelIds(nextDefaults);
    await updatedReloadSystemModel();
  }

  return report;
};
