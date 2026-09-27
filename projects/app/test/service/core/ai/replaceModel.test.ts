import { beforeEach, describe, expect, it, vi } from 'vitest';
import { replaceSystemModel } from '@fastgpt/service/core/ai/replace/service';
import {
  replaceChatConfigModelRefs,
  replaceWorkflowNodeModelRefs,
  type ModelReplaceContext
} from '@fastgpt/service/core/ai/replace/utils';
import { getEmbeddingModelData } from '@fastgpt/service/core/ai/model';
import { MongoDataset } from '@fastgpt/service/core/dataset/schema';
import { MongoDatasetData } from '@fastgpt/service/core/dataset/data/schema';
import { MongoDatasetCollection } from '@fastgpt/service/core/dataset/collection/schema';
import { MongoDatasetTraining } from '@fastgpt/service/core/dataset/training/schema';
import { MongoApp } from '@fastgpt/service/core/app/schema';
import { MongoAppVersion } from '@fastgpt/service/core/app/version/schema';
import { MongoAIDefaultModel } from '@fastgpt/service/core/ai/defaultModel/schema';
import { ModelScopeEnum } from '@fastgpt/global/core/ai/constants';
import { NodeInputKeyEnum } from '@fastgpt/global/core/workflow/constants';
import {
  FlowNodeInputTypeEnum,
  FlowNodeTypeEnum
} from '@fastgpt/global/core/workflow/node/constant';
import { DatasetCollectionTypeEnum, DatasetTypeEnum } from '@fastgpt/global/core/dataset/constants';
import type {
  EmbeddingSystemModelDataType,
  LLMSystemModelDataType
} from '@fastgpt/global/core/ai/model.schema';
import { getRootUser } from '@test/datas/users';
import { Types } from 'mongoose';

// 默认模型写入后会刷新模型缓存并请求插件服务，测试环境无插件服务
vi.mock('@fastgpt/service/core/ai/config/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@fastgpt/service/core/ai/config/utils')>()),
  updatedReloadSystemModel: vi.fn()
}));

const SOURCE_LLM = '6a9bd7a170a15c4409331c01';
const TARGET_LLM = '6a9bd7a170a15c4409331c02';
const TARGET_VLM = '6a9bd7a170a15c4409331c03';
const SOURCE_EMB = '6a9bd7a170a15c4409331c04';
const TARGET_EMB = '6a9bd7a170a15c4409331c05';

const ctx: ModelReplaceContext = {
  sourceModelId: SOURCE_LLM,
  sourceModel: 'source-llm',
  targetModelId: TARGET_LLM
};

const llmNode = (inputs: any[]) => ({
  nodeId: 'chat',
  flowNodeType: FlowNodeTypeEnum.chatNode,
  inputs,
  outputs: []
});

describe('replace model utils', () => {
  it('替换 ID 输入，保留引用方式与其它模型', () => {
    const nodes = [
      llmNode([{ key: NodeInputKeyEnum.aiModelId, renderTypeList: [], value: SOURCE_LLM }]),
      llmNode([
        {
          key: NodeInputKeyEnum.aiModelId,
          renderTypeList: [FlowNodeInputTypeEnum.reference],
          value: SOURCE_LLM
        }
      ]),
      llmNode([{ key: NodeInputKeyEnum.aiModelId, renderTypeList: [], value: 'other-id' }])
    ];

    const result = replaceWorkflowNodeModelRefs({ nodes, ctx });
    const next = result.nodes as typeof nodes;

    expect(result.changed).toBe(true);
    expect(next[0].inputs[0].value).toBe(TARGET_LLM);
    expect(next[1]).toBe(nodes[1]);
    expect(next[2]).toBe(nodes[2]);
  });

  it('只有 legacy 输入命中时追加 ID 输入；ID 存在时不看 legacy', () => {
    const legacyOnly = llmNode([
      { key: NodeInputKeyEnum.aiModel, renderTypeList: [], value: 'source-llm' }
    ]);
    const idWins = llmNode([
      { key: NodeInputKeyEnum.aiModel, renderTypeList: [], value: 'source-llm' },
      { key: NodeInputKeyEnum.aiModelId, renderTypeList: [], value: 'other-id' }
    ]);

    const [a, b] = replaceWorkflowNodeModelRefs({ nodes: [legacyOnly, idWins], ctx })
      .nodes as any[];

    expect(a.inputs).toContainEqual(
      expect.objectContaining({ key: NodeInputKeyEnum.aiModelId, value: TARGET_LLM })
    );
    expect(b).toBe(idWins);
  });

  it('替换 Agent 节点 datasetParams 与 chatConfig 中的模型', () => {
    const agent = {
      nodeId: 'agent',
      flowNodeType: FlowNodeTypeEnum.agent,
      inputs: [
        {
          key: NodeInputKeyEnum.datasetParams,
          value: { datasetSearchExtensionModelId: SOURCE_LLM, datasets: [] }
        }
      ],
      outputs: []
    };
    const [next] = replaceWorkflowNodeModelRefs({ nodes: [agent], ctx }).nodes as any[];
    expect(next.inputs[0].value.datasetSearchExtensionModelId).toBe(TARGET_LLM);

    const chatConfig = replaceChatConfigModelRefs({
      chatConfig: {
        questionGuide: { open: true, modelId: SOURCE_LLM },
        ttsConfig: { type: 'web' }
      },
      ctx
    });
    expect(chatConfig.changed).toBe(true);
    expect((chatConfig.chatConfig as any).questionGuide.modelId).toBe(TARGET_LLM);
  });
});

describe('replaceSystemModel', () => {
  let root: Awaited<ReturnType<typeof getRootUser>>;

  beforeEach(async () => {
    root = await getRootUser();
    const baseLLM = global.systemDefaultModel.llm;
    const baseEmb = global.systemDefaultModel.embedding;
    const models = [
      {
        ...baseLLM,
        modelId: SOURCE_LLM,
        model: 'source-llm',
        isActive: false,
        config: { ...baseLLM.config, vision: true }
      },
      {
        ...baseLLM,
        modelId: TARGET_LLM,
        model: 'target-llm',
        isActive: true,
        config: { ...baseLLM.config, vision: false }
      },
      {
        ...baseLLM,
        modelId: TARGET_VLM,
        model: 'target-vlm',
        isActive: true,
        config: { ...baseLLM.config, vision: true }
      },
      { ...baseEmb, modelId: SOURCE_EMB, model: 'source-emb', isActive: false },
      { ...baseEmb, modelId: TARGET_EMB, model: 'target-emb', isActive: true }
    ] as (LLMSystemModelDataType | EmbeddingSystemModelDataType)[];
    models.forEach((model) => {
      global.systemModelMap.set(`id:${model.modelId}`, model);
      global.systemModelMap.set(`model:${model.model}`, model);
    });

    // 全局测试环境固定 mock 了 embedding 解析，这里恢复为按 ID 查表
    vi.mocked(getEmbeddingModelData).mockImplementation(({ modelId }) => {
      const model = global.systemModelMap.get(`id:${modelId}`);
      if (!model) throw new Error('模型不存在');
      return model as EmbeddingSystemModelDataType;
    });
  });

  it('拒绝类型不一致或目标未启用', async () => {
    await expect(
      replaceSystemModel({ sourceModelId: SOURCE_LLM, targetModelId: TARGET_EMB, dryRun: true })
    ).rejects.toThrow();
    await expect(
      replaceSystemModel({ sourceModelId: TARGET_LLM, targetModelId: SOURCE_LLM, dryRun: true })
    ).rejects.toThrow();
  });

  it('预览只统计，执行后改写知识库、应用草稿与版本、默认模型，并清空无法满足视觉的 VLM', async () => {
    const dataset = await MongoDataset.create({
      name: 'replace-dataset',
      teamId: root.teamId,
      tmbId: root.tmbId,
      vectorModelId: TARGET_EMB,
      agentModelId: SOURCE_LLM,
      vlmModelId: SOURCE_LLM
    });
    const nodes = [
      llmNode([{ key: NodeInputKeyEnum.aiModelId, renderTypeList: [], value: SOURCE_LLM }])
    ];
    const app = await MongoApp.create({
      name: 'replace-app',
      teamId: root.teamId,
      tmbId: root.tmbId,
      modules: nodes
    });
    await MongoAppVersion.create({
      appId: app._id,
      teamId: root.teamId,
      tmbId: root.tmbId,
      nodes,
      edges: []
    });
    await MongoAIDefaultModel.findOneAndUpdate(
      { scope: ModelScopeEnum.system },
      { $set: { defaultModelIds: { llm: SOURCE_LLM, datasetImageLLM: SOURCE_LLM } } },
      { upsert: true }
    );

    const preview = await replaceSystemModel({
      sourceModelId: SOURCE_LLM,
      targetModelId: TARGET_LLM,
      dryRun: true
    });
    const count = (report: typeof preview, key: string) =>
      report.items.find((item) => item.key === key);
    expect(count(preview, 'datasetAgentModel')).toMatchObject({ matched: 1, updated: 0 });
    expect(count(preview, 'datasetVlmModelCleared')).toMatchObject({ matched: 1 });
    expect(count(preview, 'app')).toMatchObject({ matched: 1 });
    expect(count(preview, 'appVersion')).toMatchObject({ matched: 1 });
    expect((await MongoDataset.findById(dataset._id).lean())?.agentModelId).toBe(SOURCE_LLM);

    const report = await replaceSystemModel({
      sourceModelId: SOURCE_LLM,
      targetModelId: TARGET_LLM,
      dryRun: false
    });
    expect(report.failures.map((f) => f.resourceId)).toEqual(['datasetImageLLM']);

    const updatedDataset = await MongoDataset.findById(dataset._id).lean();
    expect(updatedDataset?.agentModelId).toBe(TARGET_LLM);
    expect(updatedDataset?.vlmModelId).toBeUndefined();

    const updatedApp = await MongoApp.findById(app._id).lean();
    expect(updatedApp?.modules[0].inputs[0].value).toBe(TARGET_LLM);
    const version = await MongoAppVersion.findOne({ appId: app._id }).lean();
    expect(version?.nodes[0].inputs[0].value).toBe(TARGET_LLM);

    const defaults = await MongoAIDefaultModel.findOne({ scope: ModelScopeEnum.system }).lean();
    expect(defaults?.defaultModelIds).toMatchObject({
      llm: TARGET_LLM,
      datasetImageLLM: SOURCE_LLM
    });
  });

  it('匹配以 ObjectId 存储的历史模型 ID', async () => {
    const dataset = await MongoDataset.create({
      name: 'objectid-dataset',
      teamId: root.teamId,
      tmbId: root.tmbId,
      vectorModelId: TARGET_EMB
    });
    await MongoDataset.collection.updateOne(
      { _id: dataset._id },
      { $set: { agentModelId: new Types.ObjectId(SOURCE_LLM) } }
    );

    await replaceSystemModel({
      sourceModelId: SOURCE_LLM,
      targetModelId: TARGET_LLM,
      dryRun: false
    });

    expect((await MongoDataset.findById(dataset._id).lean())?.agentModelId).toBe(TARGET_LLM);
  });

  it('目标支持视觉时替换 VLM 而不是清空', async () => {
    const dataset = await MongoDataset.create({
      name: 'vlm-dataset',
      teamId: root.teamId,
      tmbId: root.tmbId,
      vectorModelId: TARGET_EMB,
      vlmModelId: SOURCE_LLM
    });

    await replaceSystemModel({
      sourceModelId: SOURCE_LLM,
      targetModelId: TARGET_VLM,
      dryRun: false
    });

    expect((await MongoDataset.findById(dataset._id).lean())?.vlmModelId).toBe(TARGET_VLM);
  });

  it('索引模型替换触发重建，训练中的知识库跳过并报告', async () => {
    const idle = await MongoDataset.create({
      name: 'idle-dataset',
      teamId: root.teamId,
      tmbId: root.tmbId,
      vectorModelId: SOURCE_EMB
    });
    const folder = await MongoDataset.create({
      name: 'folder',
      type: DatasetTypeEnum.folder,
      teamId: root.teamId,
      tmbId: root.tmbId,
      vectorModelId: SOURCE_EMB
    });
    const busy = await MongoDataset.create({
      name: 'busy-dataset',
      teamId: root.teamId,
      tmbId: root.tmbId,
      vectorModelId: SOURCE_EMB
    });
    for (const dataset of [idle, busy]) {
      const collection = await MongoDatasetCollection.create({
        name: 'c',
        type: DatasetCollectionTypeEnum.file,
        teamId: root.teamId,
        tmbId: root.tmbId,
        datasetId: dataset._id
      });
      await MongoDatasetData.create({
        teamId: root.teamId,
        tmbId: root.tmbId,
        datasetId: dataset._id,
        collectionId: collection._id,
        q: 'q'
      });
      if (dataset === busy) {
        await MongoDatasetTraining.create({
          teamId: root.teamId,
          tmbId: root.tmbId,
          datasetId: dataset._id,
          collectionId: collection._id,
          billId: '507f1f77bcf86cd799439011',
          mode: 'chunk'
        });
      }
    }

    const preview = await replaceSystemModel({
      sourceModelId: SOURCE_EMB,
      targetModelId: TARGET_EMB,
      dryRun: true
    });
    expect(preview.rebuildDataCount).toBe(2);

    const report = await replaceSystemModel({
      sourceModelId: SOURCE_EMB,
      targetModelId: TARGET_EMB,
      dryRun: false
    });

    expect(report.items.find((i) => i.key === 'datasetVectorModel')).toMatchObject({
      matched: 3,
      updated: 2,
      skipped: 1
    });
    expect(report.failures).toEqual([
      expect.objectContaining({ resourceId: String(busy._id), name: 'busy-dataset' })
    ]);
    expect((await MongoDataset.findById(idle._id).lean())?.vectorModelId).toBe(TARGET_EMB);
    expect((await MongoDataset.findById(busy._id).lean())?.vectorModelId).toBe(SOURCE_EMB);
    // 文件夹直接改 ID，不走重建，不产生训练记录
    expect((await MongoDataset.findById(folder._id).lean())?.vectorModelId).toBe(TARGET_EMB);
    expect(await MongoDatasetTraining.countDocuments({ datasetId: folder._id })).toBe(0);
  });
});
