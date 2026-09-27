import { NodeInputKeyEnum } from '@fastgpt/global/core/workflow/constants';
import {
  FlowNodeInputTypeEnum,
  FlowNodeTypeEnum
} from '@fastgpt/global/core/workflow/node/constant';
import {
  getSelectedInputRenderType,
  isWorkflowSystemModelInput,
  workflowModelKeyMappings
} from '@fastgpt/global/core/workflow/utils';

/**
 * 一次模型替换的上下文。
 * - sourceModelId：被替换模型的稳定 ID，所有 `*ModelId` 字段按字符串比较。
 * - sourceModel：被替换模型的 model 标识，只用于匹配迁移前遗留、尚未补齐 ID 的 legacy 字段。
 */
export type ModelReplaceContext = {
  sourceModelId: string;
  sourceModel: string;
  targetModelId: string;
};

/** 一对模型引用字段：新 ID 字段 + 历史 legacy 字段。 */
export type ModelRefField = {
  idKey: string;
  legacyKey: string;
};

/** 工作流中动态引用（引用其它节点输出 / 变量模板）的值不属于具体模型，不能被替换。 */
const isDynamicValue = (value: unknown) =>
  Array.isArray(value) || (typeof value === 'string' && /^\{\{.*\}\}$/.test(value));

/**
 * 判断一组模型引用字段是否指向源模型。
 * 与运行时解析规则保持一致：ID 字段存在时只看 ID，不再回退 legacy 字段；
 * 只有 ID 字段缺失时，legacy model 标识等于源模型才算命中。
 */
const isSourceReference = ({
  idValue,
  legacyValue,
  ctx
}: {
  idValue: unknown;
  legacyValue: unknown;
  ctx: ModelReplaceContext;
}) => {
  if (idValue !== undefined && idValue !== null) {
    return String(idValue) === ctx.sourceModelId;
  }
  return typeof legacyValue === 'string' && legacyValue === ctx.sourceModel;
};

/**
 * 替换普通对象上的模型引用字段，返回需要 `$set` 的字段；未命中返回 undefined。
 * 不修改入参，也不删除 legacy 字段：写入 ID 后运行时以 ID 为准，legacy 值不再生效。
 */
export const replaceFlatModelRefs = ({
  record,
  fields,
  ctx
}: {
  record: Record<string, any> | undefined | null;
  fields: ModelRefField[];
  ctx: ModelReplaceContext;
}): Record<string, string> | undefined => {
  if (!record || typeof record !== 'object') return;

  const set: Record<string, string> = {};
  for (const { idKey, legacyKey } of fields) {
    if (isDynamicValue(record[idKey]) || isDynamicValue(record[legacyKey])) continue;
    if (isSourceReference({ idValue: record[idKey], legacyValue: record[legacyKey], ctx })) {
      set[idKey] = ctx.targetModelId;
    }
  }
  return Object.keys(set).length > 0 ? set : undefined;
};

/** Agent 节点 datasetParams 中保存的检索模型引用。 */
const agentDatasetParamsFields: ModelRefField[] = [
  {
    idKey: NodeInputKeyEnum.datasetSearchRerankModelId,
    legacyKey: NodeInputKeyEnum.datasetSearchRerankModel
  },
  {
    idKey: NodeInputKeyEnum.datasetSearchExtensionModelId,
    legacyKey: NodeInputKeyEnum.datasetSearchExtensionModel
  }
];

/**
 * 替换工作流节点中的系统模型引用，返回新节点数组与是否发生变化。
 *
 * - 只处理 `isWorkflowSystemModelInput` 认定的系统模型输入，外部工具同名参数不动；
 * - 选择了“引用”输入方式或值是 `{{...}}` 变量模板的输入不动；
 * - 只有 legacy 输入命中时，追加对应的 ID 输入（与保存时 formatModels 的格式一致）；
 * - Agent 节点额外处理 datasetParams 内的 rerank / 问题优化模型。
 */
export const replaceWorkflowNodeModelRefs = ({
  nodes,
  ctx
}: {
  nodes: unknown;
  ctx: ModelReplaceContext;
}): { nodes: unknown; changed: boolean } => {
  if (!Array.isArray(nodes)) return { nodes, changed: false };

  let changed = false;
  const nextNodes = nodes.map((node) => {
    if (!node || typeof node !== 'object' || !Array.isArray(node.inputs)) return node;

    const inputs = [...node.inputs];
    let nodeChanged = false;

    // 引用方式输入或变量模板，其值不是具体模型 ID
    const isDynamicInput = (input: any) =>
      getSelectedInputRenderType(input) === FlowNodeInputTypeEnum.reference ||
      isDynamicValue(input?.value);

    for (const [legacyKey, idKey] of workflowModelKeyMappings) {
      const idInputIndex = inputs.findIndex((input) => input?.key === idKey);
      const idInput = inputs[idInputIndex];
      const legacyInput = inputs.find((input) => input?.key === legacyKey);
      const systemInput = idInput ?? legacyInput;
      if (!systemInput || !isWorkflowSystemModelInput({ node, input: systemInput })) continue;
      if (isDynamicInput(systemInput)) continue;

      if (!isSourceReference({ idValue: idInput?.value, legacyValue: legacyInput?.value, ctx })) {
        continue;
      }

      if (idInput) {
        inputs[idInputIndex] = { ...idInput, value: ctx.targetModelId };
      } else {
        inputs.push({ ...legacyInput, key: idKey, value: ctx.targetModelId });
      }
      nodeChanged = true;
    }

    const datasetParamsIndex = inputs.findIndex(
      (input) => input?.key === NodeInputKeyEnum.datasetParams
    );
    const datasetParams = inputs[datasetParamsIndex]?.value;
    if (
      node.flowNodeType === FlowNodeTypeEnum.agent &&
      datasetParams &&
      typeof datasetParams === 'object' &&
      !Array.isArray(datasetParams)
    ) {
      const set = replaceFlatModelRefs({
        record: datasetParams,
        fields: agentDatasetParamsFields,
        ctx
      });
      if (set) {
        inputs[datasetParamsIndex] = {
          ...inputs[datasetParamsIndex],
          value: { ...datasetParams, ...set }
        };
        nodeChanged = true;
      }
    }

    if (!nodeChanged) return node;
    changed = true;
    return { ...node, inputs };
  });

  return { nodes: changed ? nextNodes : nodes, changed };
};

/** 替换应用对话配置中的问题引导模型和语音播报模型引用。 */
export const replaceChatConfigModelRefs = ({
  chatConfig,
  ctx
}: {
  chatConfig: unknown;
  ctx: ModelReplaceContext;
}): { chatConfig: unknown; changed: boolean } => {
  if (!chatConfig || typeof chatConfig !== 'object') return { chatConfig, changed: false };

  const config = chatConfig as Record<string, any>;
  let next = config;
  for (const key of ['questionGuide', 'ttsConfig'] as const) {
    const set = replaceFlatModelRefs({
      record: config[key],
      fields: [{ idKey: 'modelId', legacyKey: 'model' }],
      ctx
    });
    if (set) next = { ...next, [key]: { ...config[key], ...set } };
  }

  return { chatConfig: next, changed: next !== config };
};
