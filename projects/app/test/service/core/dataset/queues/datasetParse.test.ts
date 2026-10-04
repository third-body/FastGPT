import { describe, expect, it } from 'vitest';
import { datasetParseQueue } from '@/service/core/dataset/queues/datasetParse';
import { MongoDataset } from '@fastgpt/service/core/dataset/schema';
import { MongoDatasetCollection } from '@fastgpt/service/core/dataset/collection/schema';
import { MongoDatasetTraining } from '@fastgpt/service/core/dataset/training/schema';
import {
  DatasetCollectionTypeEnum,
  TrainingModeEnum
} from '@fastgpt/global/core/dataset/constants';
import { getRootUser } from '@test/datas/users';

describe('datasetParseQueue', () => {
  it('知识库引用的模型失效时记录错误信息，而不是静默中断 worker', async () => {
    const root = await getRootUser();
    const dataset = await MongoDataset.create({
      name: 'stale-model-dataset',
      teamId: root.teamId,
      tmbId: root.tmbId,
      vectorModelId: global.systemDefaultModel.embedding.modelId,
      // 不存在的文本理解模型
      agentModelId: '6a9bd7a170a15c4409331c99'
    });
    const collection = await MongoDatasetCollection.create({
      name: 'c',
      type: DatasetCollectionTypeEnum.file,
      teamId: root.teamId,
      tmbId: root.tmbId,
      datasetId: dataset._id
    });
    const training = await MongoDatasetTraining.create({
      teamId: root.teamId,
      tmbId: root.tmbId,
      datasetId: dataset._id,
      collectionId: collection._id,
      billId: '507f1f77bcf86cd799439011',
      mode: TrainingModeEnum.parse
    });

    global.datasetParseQueueLen = 0;
    await datasetParseQueue();

    const updated = await MongoDatasetTraining.findById(training._id).lean();
    expect(updated?.errorMsg).toBeTruthy();
    expect(global.datasetParseQueueLen).toBe(0);
  });
});
