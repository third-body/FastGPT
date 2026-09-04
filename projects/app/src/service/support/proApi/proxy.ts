import type { NextApiRequest, NextApiResponse } from 'next';
import { Readable } from 'stream';
import { FastGPTProUrl } from '@fastgpt/service/common/system/constants';
import { buildSameOriginUrl } from '@fastgpt/service/common/security/network';
import { FASTGPT_PRO_TOKEN_HEADER } from '@fastgpt/global/common/system/constants';

/** 转发时需要丢弃的逐跳头与鉴权头，避免污染商业版侧的请求。 */
const skippedRequestHeaders = new Set(['rootkey', FASTGPT_PRO_TOKEN_HEADER, 'host', 'connection']);

/**
 * 还原要转发给商业版的目标路径。
 *
 * catch-all 路由 (`[...path].ts`) 能直接拿到 `req.query.path` 数组；
 * 而开源兜底用的静态路由（如 `proApi/support/user/team/member/list.ts`）没有该参数，
 * 只能从 `req.url` 里剥掉 `/api/proApi` 前缀来还原，两种情况都要支持。
 */
const resolveProRequestPath = (req: NextApiRequest): string => {
  const { path, ...query } = req.query as any;

  if (Array.isArray(path) && path.length > 0) {
    return `/api/${path.join('/')}?${new URLSearchParams(query).toString()}`;
  }

  const rawUrl = req.url || '';
  const [pathname, search = ''] = rawUrl.split('?');
  // /api/proApi/support/... → /support/...
  const strippedPath = pathname.replace(/^\/api\/proApi/, '');

  if (!strippedPath) {
    throw new Error('url is empty');
  }

  return `/api${strippedPath}${search ? `?${search}` : ''}`;
};

/**
 * 把 /api/proApi/** 请求转发到商业版服务，并把响应流式回写。
 *
 * 从 pages/api/proApi/[...path].ts 抽出，供 catch-all 代理和开源版兜底实现
 * (withProFallback) 共用，避免转发逻辑出现两份实现而产生行为漂移。
 *
 * @param parsedBody 已被 bodyParser 消费掉的请求体。catch-all 代理关闭了 bodyParser，
 *   可以直接透传原始请求流；但兜底静态路由必须保留 bodyParser 给本地 handler 用，
 *   此时原始流已不可读，只能把解析后的 body 重新序列化为 JSON 转发。
 */
export const proxyToPro = async (
  req: NextApiRequest,
  res: NextApiResponse,
  parsedBody?: unknown
) => {
  if (!FastGPTProUrl) {
    throw new Error(`未配置商业版链接: ${req.url}`);
  }

  const requestPath = resolveProRequestPath(req);
  // 防御 protocol-relative URL 覆盖主机(如 path 含空段 → `//169.254...`)
  const targetUrl = buildSameOriginUrl(requestPath, FastGPTProUrl);

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (skippedRequestHeaders.has(key)) continue;
    if (value) {
      headers[key] = Array.isArray(value) ? value.join(', ') : value;
    }
  }

  const isBodylessMethod = req.method === 'GET' || req.method === 'HEAD';
  const shouldReserializeBody = !isBodylessMethod && parsedBody !== undefined;

  if (shouldReserializeBody) {
    headers['content-type'] = 'application/json';
    // 重新序列化后长度会变，原 content-length 必须丢弃，否则商业版侧会截断或挂起
    delete headers['content-length'];
  }

  const request = new Request(targetUrl, {
    // @ts-ignore
    duplex: 'half',
    method: req.method,
    headers,
    body: isBodylessMethod
      ? null
      : shouldReserializeBody
        ? JSON.stringify(parsedBody)
        : (req as any)
  });

  const response = await fetch(request);

  response.headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();
    if (lowerKey === 'content-encoding' || lowerKey === 'transfer-encoding') return;
    res.setHeader(key, value);
  });

  res.status(response.status);

  if (response.body) {
    const nodeStream = Readable.fromWeb(response.body as any);
    nodeStream.pipe(res);
  } else {
    res.end();
  }
};
