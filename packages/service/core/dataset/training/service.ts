import type { DatasetSchemaType } from '@fastgpt/global/core/dataset/type';
import type { EmbeddingSystemModelDataType } from '@fastgpt/global/core/ai/model.schema';
import { TrainingModeEnum } from '@fastgpt/global/core/dataset/constants';
import { UsageSourceEnum } from '@fastgpt/global/support/wallet/usage/constants';
import { mongoSessionRun } from '../../../common/mongo/sessionRun';
import { MongoDataset } from '../schema';
import { MongoDatasetData } from '../data/schema';
import { MongoDatasetCollection } from '../collection/schema';
import { MongoDatasetTraining } from './schema';
import { createTrainingUsage } from '../../../support/wallet/usage/controller';
import { getDefaultLLMModelData, getLLMModelData, getOptionalVlmModelData } from '../../ai/model';
import { getDatasetImageIndexCapability, getDatasetImageTrainingMode } from '../utils';
import { uniqueDatasetDataMarkdownImageUrls } from '../data/utils';

/**
 * 为知识库切换索引模型并重建全部向量。
 *
 * 流程：校验新旧模型不同且知识库空闲 → 创建训练账单 → 事务内更新 vectorModelId 并把全部数据
 * 标记为 rebuilding → 预先把少量数据推入训练队列，其余由训练队列按 rebuilding 标记继续拉取。
 *
 * - 计费记到 `tmbId` 所在团队（调用方决定是操作者还是知识库所有者）。
 * - 新索引模型不支持图片索引时，同步关闭知识库与集合的 imageIndex。
 * - 文本理解模型已失效时账单记到系统默认文本模型（此流程只用它做账单归类）；
 * - 图片理解模型已失效（删除/停用/不支持视觉）时按未配置处理，不阻塞索引切换；
 *   此时图片数据不进入 imageParse 模式，训练阶段也不会用到该模型。
 * - 知识库正在训练或重建时拒绝执行，调用方可稍后重试。
 */
export const rebuildDatasetEmbedding = async ({
  dataset,
  teamId,
  tmbId,
  vectorModelData
}: {
  dataset: Pick<
    DatasetSchemaType,
    '_id' | 'vectorModelId' | 'agentModelId' | 'agentModel' | 'vlmModelId' | 'vlmModel'
  >;
  teamId: string;
  tmbId: string;
  vectorModelData: EmbeddingSystemModelDataType;
}) => {
  const datasetId = String(dataset._id);

  if (String(dataset.vectorModelId || '') === vectorModelData.modelId) {
    return Promise.reject('vectorModel 不合法');
  }

  const [rebuilding, training] = await Promise.all([
    MongoDatasetData.findOne({ teamId, datasetId, rebuilding: true }),
    MongoDatasetTraining.findOne({ teamId, datasetId })
  ]);
  if (rebuilding || training) {
    return Promise.reject('数据集正在训练或者重建中，请稍后再试');
  }

  const vlmModelData = (() => {
    try {
      return getOptionalVlmModelData({
        modelId: dataset.vlmModelId ? String(dataset.vlmModelId) : undefined,
        model: dataset.vlmModel
      });
    } catch {
      return undefined;
    }
  })();
  const { availableVlmModel, supportVlm, supportImageIndex } = getDatasetImageIndexCapability({
    vectorModel: vectorModelData,
    vlmModel: vlmModelData
  });

  const { usageId } = await createTrainingUsage({
    teamId,
    tmbId,
    appName: '切换索引模型',
    billSource: UsageSourceEnum.training,
    vectorModelId: vectorModelData.modelId!,
    // 文本理解模型只用于账单归类，已失效时记到默认模型，避免阻塞索引切换
    agentModelId: (() => {
      try {
        return getLLMModelData({
          modelId: dataset.agentModelId ? String(dataset.agentModelId) : undefined,
          model: dataset.agentModel
        }).modelId;
      } catch {
        return getDefaultLLMModelData().modelId;
      }
    })(),
    vllmModelId: availableVlmModel?.modelId
  });

  // update vector model and dataset.data rebuild field
  await mongoSessionRun(async (session) => {
    await MongoDataset.findByIdAndUpdate(
      datasetId,
      {
        $set: {
          vectorModelId: vectorModelData.modelId,
          ...(!supportImageIndex && { 'chunkSettings.imageIndex': false })
        }
      },
      { session }
    );
    if (!supportImageIndex) {
      await MongoDatasetCollection.updateMany(
        { teamId, datasetId },
        { $set: { imageIndex: false } },
        { session }
      );
    }
    await MongoDatasetData.updateMany(
      { teamId, datasetId },
      { $set: { rebuilding: true } },
      { session }
    );
  });

  // get 10 init dataset.data
  const max = global.systemEnv?.vectorMaxProcess || 10;
  const arr = new Array(max * 2).fill(0);

  for (let i = 0; i < arr.length; i++) {
    try {
      const hasNext = await mongoSessionRun(async (session) => {
        // get next dataset.data
        const data = await MongoDatasetData.findOneAndUpdate(
          { rebuilding: true, teamId, datasetId },
          { $unset: { rebuilding: null }, updateTime: new Date() },
          { session }
        ).select({ _id: 1, collectionId: 1, imageId: 1, q: 1, indexes: 1 });

        if (data) {
          const collection = await MongoDatasetCollection.findById(data.collectionId)
            .select('imageIndex')
            .session(session);
          const hasMarkdownImages =
            !!collection?.imageIndex && uniqueDatasetDataMarkdownImageUrls([data.q]).length > 0;
          const mode = getDatasetImageTrainingMode({
            supportVlm,
            supportImageIndex,
            imageId: data.imageId,
            hasMarkdownImages
          });

          await MongoDatasetTraining.create(
            [
              {
                teamId,
                tmbId,
                datasetId,
                collectionId: data.collectionId,
                billId: usageId,
                mode,
                dataId: data._id,
                ...(data.imageId && { imageId: data.imageId }),
                ...(mode === TrainingModeEnum.image && {
                  q: data.q,
                  indexes: data.indexes
                }),
                retryCount: 50
              }
            ],
            { session, ordered: true }
          );
        }

        return !!data;
      });

      if (!hasNext) {
        break;
      }
    } catch {}
  }
};
