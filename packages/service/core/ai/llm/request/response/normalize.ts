import type {
  CompletionFinishReason,
  StreamResponseType,
  UnStreamResponseType
} from '@fastgpt/global/core/ai/llm/type';

/**
 * 补齐模型响应的 finish_reason。
 *
 * stream 场景下，如果已经收到部分内容但没有正常结束标记，记录为 abnormal_close；
 * 非 stream 场景一般是完整响应，缺失 finish_reason 时按 stop 处理。
 */
export const normalizeCompletionFinishReason = ({
  rawFinishReason,
  isStreamResponse,
  hasResponse,
  error
}: {
  rawFinishReason: CompletionFinishReason;
  isStreamResponse: boolean;
  hasResponse: boolean;
  error?: any;
}): CompletionFinishReason => {
  if (error) return 'error';
  if (rawFinishReason) return rawFinishReason;
  if (isStreamResponse && hasResponse) return 'abnormal_close';
  return 'stop';
};

/**
 * 判断 SDK 返回值是否为 stream。
 * 这里不用 instanceof，避免不同 SDK/运行时包装后原型不一致。
 */
export const isStreamCompletionResponse = (
  response: StreamResponseType | UnStreamResponseType
): response is StreamResponseType => {
  return (
    typeof response === 'object' &&
    response !== null &&
    ('iterator' in response || 'controller' in response)
  );
};

/**
 * 把模型返回的工具名解析为本轮请求中的 function name；无法解析时返回 undefined。
 *
 * 工作流工具的 function name 是节点 ID（如 `uMQ1KR4VDTYA1xfa`），可读名称只写在描述开头
 * （`member_overview: 查询...`，见 compileToolRuntime）。部分模型会按描述里的可读名称发起调用，
 * 精确匹配失败时按描述前缀兜底，避免调用被静默丢弃后表现为“模型响应为空”。
 */
export const resolveToolCallName = (
  name: string,
  tools: { function: { name: string; description?: string } }[] = []
): string | undefined => {
  if (!name) return;
  if (tools.some((tool) => tool.function.name === name)) return name;
  return tools.find((tool) => tool.function.description?.startsWith(`${name}: `))?.function.name;
};
