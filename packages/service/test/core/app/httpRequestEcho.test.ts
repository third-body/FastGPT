import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// 回显服务监听在本机：SSRF 校验替换为放行，HTTP 客户端用未加拦截器的原生 axios，
// 请求的序列化与发送仍是真实网络行为
vi.mock('@fastgpt/service/common/system/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@fastgpt/service/common/system/utils')>()),
  isInternalAddress: vi.fn().mockResolvedValue(false)
}));
vi.mock('@fastgpt/service/common/api/axios', async () => ({
  axios: (await import('axios')).default
}));

const { runHTTPTool } = await import('@fastgpt/service/core/app/http');

/** 本地回显服务：原样返回收到的方法、路径、Content-Type 与请求体，验证真实的序列化结果 */
describe('runHTTPTool 端到端请求体', () => {
  let server: http.Server;
  let baseUrl = '';

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            method: req.method,
            url: req.url,
            contentType: req.headers['content-type'],
            body: raw
          })
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('POST 工具的参数以 JSON 请求体到达服务端', async () => {
    const { data, errorMsg } = await runHTTPTool({
      baseUrl,
      toolPath: '/api/tools/member_info',
      method: 'post',
      params: { member_id: 'aaa001' },
      requestSchema: {
        type: 'object',
        properties: { member_id: { type: 'string' } },
        required: ['member_id']
      }
    });

    expect(errorMsg).toBeUndefined();
    expect(data).toMatchObject({
      method: 'POST',
      url: '/api/tools/member_info',
      contentType: 'application/json'
    });
    expect(JSON.parse(data.body)).toEqual({ member_id: 'aaa001' });
  });
});
