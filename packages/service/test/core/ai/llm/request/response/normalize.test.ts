import { describe, expect, it } from 'vitest';
import {
  isStreamCompletionResponse,
  normalizeCompletionFinishReason,
  resolveToolCallName
} from '@fastgpt/service/core/ai/llm/request/response/normalize';

describe('normalizeCompletionFinishReason', () => {
  it('should prefer error over raw finish reason', () => {
    expect(
      normalizeCompletionFinishReason({
        rawFinishReason: 'stop',
        isStreamResponse: true,
        hasResponse: true,
        error: new Error('failed')
      })
    ).toBe('error');
  });

  it('should keep raw finish reason when it exists', () => {
    expect(
      normalizeCompletionFinishReason({
        rawFinishReason: 'tool_calls',
        isStreamResponse: true,
        hasResponse: true
      })
    ).toBe('tool_calls');
  });

  it('should mark partial stream response without finish reason as abnormal close', () => {
    expect(
      normalizeCompletionFinishReason({
        rawFinishReason: null,
        isStreamResponse: true,
        hasResponse: true
      })
    ).toBe('abnormal_close');
  });

  it('should fill stop for non-stream or empty stream without finish reason', () => {
    expect(
      normalizeCompletionFinishReason({
        rawFinishReason: undefined,
        isStreamResponse: false,
        hasResponse: false
      })
    ).toBe('stop');
  });
});

describe('isStreamCompletionResponse', () => {
  it('should detect stream responses by iterator or controller fields', () => {
    expect(isStreamCompletionResponse({ iterator: () => undefined } as any)).toBe(true);
    expect(isStreamCompletionResponse({ controller: { abort: () => undefined } } as any)).toBe(
      true
    );
  });

  it('should reject non-object and normal completion responses', () => {
    expect(isStreamCompletionResponse(null as any)).toBe(false);
    expect(isStreamCompletionResponse({ choices: [] } as any)).toBe(false);
  });
});

describe('resolveToolCallName', () => {
  const tools = [
    { function: { name: 'uMQ1KR4VDTYA1xfa', description: 'member_overview: 查询会员概览' } },
    { function: { name: 'read_files', description: 'Read the content of specified files.' } }
  ];

  it('精确命中 function name 时原样返回', () => {
    expect(resolveToolCallName('read_files', tools)).toBe('read_files');
    expect(resolveToolCallName('uMQ1KR4VDTYA1xfa', tools)).toBe('uMQ1KR4VDTYA1xfa');
  });

  it('按描述前缀的可读名称映射回 function name', () => {
    expect(resolveToolCallName('member_overview', tools)).toBe('uMQ1KR4VDTYA1xfa');
  });

  it('前缀需完整匹配到冒号，无法识别时返回 undefined', () => {
    expect(resolveToolCallName('member', tools)).toBeUndefined();
    expect(resolveToolCallName('unknown', tools)).toBeUndefined();
    expect(resolveToolCallName('', tools)).toBeUndefined();
  });
});
