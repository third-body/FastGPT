import type { NextApiRequest, NextApiResponse } from 'next';
import { jsonRes } from '@fastgpt/service/common/response';
import { proxyToPro } from '@/service/support/proApi/proxy';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    // 关闭了 bodyParser，可直接透传原始请求流，无需重新序列化 body
    await proxyToPro(req, res);
  } catch (error) {
    jsonRes(res, {
      code: 500,
      error
    });
  }
}

export const config = {
  api: {
    bodyParser: false
  }
};
