import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
import { jsonRes } from '@fastgpt/service/common/response';
import { FastGPTProUrl } from '@fastgpt/service/common/system/constants';
import { proxyToPro } from './proxy';

/**
 * 为 `pages/api/proApi/**` 下的开源版兜底实现包一层路由分流。
 *
 * 背景：Next.js Pages Router 中静态路由优先级高于 catch-all，所以在 proApi 目录下
 * 新建具体文件会直接接管对应请求，前端请求路径和 `[...path].ts` 代理都无需改动。
 * 但这也意味着**已配置商业版的部署会被开源实现劫持**，因此这里做显式分流：
 *
 * - 配置了 `PRO_URL`：原样转发给商业版，保持既有行为完全不变；
 * - 未配置：走开源版本地 handler。
 *
 * 用法（withProFallback 必须在最外层，因为转发会直接接管响应写出，
 * 不能经过 NextAPI 的统一响应封装）：
 *
 * ```ts
 * export default withProFallback(NextAPI(handler));
 * ```
 *
 * 注意：这些路由保留 bodyParser 供本地 handler 读取 req.body，转发时原始请求流
 * 已被消费，故把解析后的 body 交给 proxyToPro 重新序列化。
 */
export const withProFallback = (handler: NextApiHandler): NextApiHandler => {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    if (!FastGPTProUrl) {
      return handler(req, res);
    }

    try {
      await proxyToPro(req, res, req.body);
    } catch (error) {
      jsonRes(res, {
        code: 500,
        error
      });
    }
  };
};
