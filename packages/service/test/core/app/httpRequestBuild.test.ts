import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContentTypes } from '@fastgpt/global/core/workflow/constants';

const { axiosMock } = vi.hoisted(() => ({
  axiosMock: vi.fn()
}));

vi.mock('@fastgpt/service/common/api/axios', () => ({
  axios: axiosMock
}));
vi.mock('@fastgpt/service/common/system/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@fastgpt/service/common/system/utils')>()),
  isInternalAddress: vi.fn().mockResolvedValue(false)
}));

const { runHTTPTool } = await import('@fastgpt/service/core/app/http');

/** 取最近一次 axios 请求配置 */
const lastRequest = () => axiosMock.mock.calls.at(-1)?.[0];

describe('runHTTPTool 参数位置', () => {
  beforeEach(() => {
    axiosMock.mockReset();
    axiosMock.mockResolvedValue({ data: { ok: true } });
  });

  it('POST 未配置静态请求体时，requestBody 字段作为 JSON 请求体发送', async () => {
    await runHTTPTool({
      baseUrl: 'https://api.example.com',
      toolPath: '/member_info',
      method: 'post',
      params: { member_id: 'aaa001' },
      requestSchema: {
        type: 'object',
        properties: { member_id: { type: 'string' } },
        required: ['member_id']
      }
    });

    expect(lastRequest()).toMatchObject({
      method: 'POST',
      url: '/member_info',
      data: { member_id: 'aaa001' },
      params: undefined,
      headers: { 'Content-Type': 'application/json' }
    });
  });

  it('没有 requestSchema 时 POST 参数也进入请求体', async () => {
    await runHTTPTool({
      baseUrl: 'https://api.example.com',
      toolPath: '/echo',
      method: 'POST',
      params: { a: 1 }
    });

    expect(lastRequest().data).toEqual({ a: 1 });
  });

  it('按 x-param-in 把参数放入 query / header / path，其余进请求体', async () => {
    await runHTTPTool({
      baseUrl: 'https://api.example.com',
      toolPath: '/members/{id}',
      method: 'post',
      params: { id: 'a b', page: 2, 'X-Tenant': 't1', name: 'n' },
      customHeaders: { Authorization: 'Bearer secret' },
      requestSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', 'x-param-in': 'path' },
          page: { type: 'number', 'x-param-in': 'query' },
          'X-Tenant': { type: 'string', 'x-param-in': 'header' },
          name: { type: 'string' }
        }
      }
    });

    const request = lastRequest();
    expect(request.url).toBe('/members/a%20b');
    expect(request.params).toEqual({ page: 2 });
    expect(request.headers).toMatchObject({ 'X-Tenant': 't1', Authorization: 'Bearer secret' });
    expect(request.data).toEqual({ name: 'n' });
  });

  it('参数声明的请求头不能覆盖自定义请求头', async () => {
    await runHTTPTool({
      baseUrl: 'https://api.example.com',
      toolPath: '/x',
      method: 'get',
      params: { Authorization: 'evil' },
      customHeaders: { Authorization: 'Bearer secret' },
      requestSchema: {
        type: 'object',
        properties: { Authorization: { type: 'string', 'x-param-in': 'header' } }
      }
    });

    expect(lastRequest().headers.Authorization).toBe('Bearer secret');
  });

  it('旧数据中来自 OpenAPI parameters 的参数（isToolParam）在 POST 时进入 query', async () => {
    await runHTTPTool({
      baseUrl: 'https://api.example.com',
      toolPath: '/search',
      method: 'post',
      params: { keyword: 'k' },
      requestSchema: {
        type: 'object',
        properties: { keyword: { type: 'string', isToolParam: true } }
      }
    });

    expect(lastRequest()).toMatchObject({ params: { keyword: 'k' }, data: {} });
  });

  it('GET 参数仍进入 query，不发送请求体', async () => {
    await runHTTPTool({
      baseUrl: 'https://api.example.com',
      toolPath: '/search',
      method: 'get',
      params: { keyword: 'k' }
    });

    expect(lastRequest()).toMatchObject({ params: { keyword: 'k' }, data: undefined });
  });

  it('配置了 JSON 静态请求体时保持模板行为，不额外拼入参数', async () => {
    await runHTTPTool({
      baseUrl: 'https://api.example.com',
      toolPath: '/tpl',
      method: 'post',
      params: { member_id: 'aaa001' },
      staticBody: { type: ContentTypes.json, content: '{"uid":"{{member_id}}"}' }
    });

    expect(lastRequest()).toMatchObject({ data: { uid: 'aaa001' }, params: undefined });
  });

  it('配置了静态 Query 时参数整体并入 query，请求体保持为空对象', async () => {
    await runHTTPTool({
      baseUrl: 'https://api.example.com',
      toolPath: '/q',
      method: 'post',
      params: { member_id: 'aaa001' },
      staticParams: [{ key: 'v', value: '1' }]
    });

    expect(lastRequest()).toMatchObject({
      params: { v: '1', member_id: 'aaa001' },
      data: {}
    });
  });
});
