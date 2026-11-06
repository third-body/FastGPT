import { type StoreSecretValueType } from '@fastgpt/global/common/secret/type';
import { getSecretValue } from '../../common/secret/utils';
import { axios } from '../../common/api/axios';
import { getErrText } from '@fastgpt/global/common/error/utils';
import type { RequireOnlyOne } from '@fastgpt/global/common/type/utils';
import type { HttpToolConfigType } from '@fastgpt/global/core/app/tool/httpTool/type';
import { contentTypeMap, ContentTypes } from '@fastgpt/global/core/workflow/constants';
import { isInternalAddress, PRIVATE_URL_TEXT } from '../../common/system/utils';
import type { AppSchemaType } from '@fastgpt/global/core/app/type';
import { AppToolSourceEnum } from '@fastgpt/global/core/app/tool/constants';
import { replaceEditorVariable } from '../workflow/dispatch/utils/replaceEditorVariable';
import FormData from 'form-data';
import { getLogger, LogCategories } from '../../common/logger';
import { decodeHttpToolSetNodesFromStorage } from './jsonSchemaStorage';

const logger = getLogger(LogCategories.MODULE.APP.HTTP_TOOLS);

export type RunHTTPToolParams = {
  baseUrl: string;
  toolPath: string;
  method: string;
  params: Record<string, any>;
  headerSecret?: StoreSecretValueType | null;
  customHeaders?: Record<string, string>;
  staticParams?: HttpToolConfigType['staticParams'];
  staticHeaders?: HttpToolConfigType['staticHeaders'];
  staticBody?: HttpToolConfigType['staticBody'];
  /** 工具保存的请求结构，用于判断每个参数应放在 query / header / path 还是请求体 */
  requestSchema?: HttpToolConfigType['requestSchema'];
};

export type RunHTTPToolResult = RequireOnlyOne<{
  data?: any;
  errorMsg?: string;
}>;

type HttpParamLocation = 'query' | 'header' | 'path' | 'body';

/**
 * 按工具定义把调用参数分配到 query / header / path / 请求体。
 *
 * - 新导入的 OpenAPI 工具在 requestSchema 属性上记录了 `x-param-in`（来自 parameters[].in），直接使用；
 * - 旧数据没有该标记：来自 OpenAPI parameters 的属性带 `isToolParam`，按 query 处理；
 *   来自 requestBody 的属性是原始 body schema，不带该标记；
 * - 未声明的参数：POST/PUT/PATCH 放进请求体，其它方法放进 query。
 */
const splitParamsByLocation = ({
  method,
  params,
  requestSchema
}: Pick<RunHTTPToolParams, 'method' | 'params' | 'requestSchema'>) => {
  const isBodyMethod = ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase());
  const properties: Record<string, any> = requestSchema?.properties ?? {};
  const result: Record<HttpParamLocation, Record<string, any>> = {
    query: {},
    header: {},
    path: {},
    body: {}
  };

  Object.entries(params).forEach(([key, value]) => {
    const property = properties[key];
    const location: HttpParamLocation = (() => {
      const declared = property?.['x-param-in'];
      if (declared === 'query' || declared === 'header' || declared === 'path') return declared;
      if (declared === 'body') return isBodyMethod ? 'body' : 'query';
      if (property?.isToolParam) return 'query';
      return isBodyMethod ? 'body' : 'query';
    })();
    result[location][key] = value;
  });

  return { ...result, isBodyMethod };
};

/**
 * 组装 HTTP 工具请求。
 *
 * 配置了 staticBody（非 none）或 staticParams 的手动工具保持原有行为：请求体由模板生成，
 * 参数通过变量替换引用，staticParams 存在时参数整体并入 query。
 * 否则按 splitParamsByLocation 把参数放到对应位置，POST/PUT/PATCH 以 JSON 请求体发送。
 */
const buildHttpRequest = ({
  method,
  params,
  headerSecret,
  customHeaders,
  staticParams,
  staticHeaders,
  staticBody,
  requestSchema
}: Omit<RunHTTPToolParams, 'baseUrl' | 'toolPath'>) => {
  const replaceVariables = (text: string) => {
    return replaceEditorVariable({
      text,
      nodesMap: new Map(),
      variables: params
    });
  };

  const useParamRouting = !staticParams && (!staticBody || staticBody.type === ContentTypes.none);
  const routed = useParamRouting
    ? splitParamsByLocation({ method, params, requestSchema })
    : undefined;

  const body = (() => {
    if (!staticBody || staticBody.type === ContentTypes.none) {
      if (!['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) return undefined;
      return routed ? routed.body : {};
    }

    if (staticBody.type === ContentTypes.json) {
      const contentWithReplacedVars = staticBody.content
        ? replaceVariables(staticBody.content)
        : '{}';
      const staticContent = JSON.parse(contentWithReplacedVars);
      return { ...staticContent };
    }

    if (staticBody.type === ContentTypes.formData) {
      const formData = new FormData();
      staticBody.formData?.forEach(({ key, value }) => {
        const replacedKey = replaceVariables(key);
        const replacedValue = replaceVariables(value);
        formData.append(replacedKey, replacedValue);
      });
      return formData;
    }

    if (staticBody.type === ContentTypes.xWwwFormUrlencoded) {
      const urlencoded = new URLSearchParams();
      staticBody.formData?.forEach(({ key, value }) => {
        const replacedKey = replaceVariables(key);
        const replacedValue = replaceVariables(value);
        urlencoded.append(replacedKey, replacedValue);
      });
      return urlencoded.toString();
    }

    if (staticBody.type === ContentTypes.xml || staticBody.type === ContentTypes.raw) {
      return replaceVariables(staticBody.content || '');
    }

    return undefined;
  })();

  const contentType =
    contentTypeMap[staticBody?.type || ContentTypes.none] ||
    (routed?.isBodyMethod ? contentTypeMap[ContentTypes.json] : '');
  const headers = {
    ...(contentType && { 'Content-Type': contentType }),
    // 参数声明的请求头优先级最低，不能覆盖自定义请求头与鉴权密钥
    ...Object.fromEntries(
      Object.entries(routed?.header ?? {}).map(([key, value]) => [key, String(value)])
    ),
    ...(customHeaders || {}),
    ...(headerSecret ? getSecretValue({ storeSecret: headerSecret }) : {}),
    ...(staticHeaders?.reduce(
      (acc, { key, value }) => {
        const replacedKey = replaceVariables(key);
        const replacedValue = replaceVariables(value);
        acc[replacedKey] = replacedValue;
        return acc;
      },
      {} as Record<string, string>
    ) || {})
  };

  const queryParams = (() => {
    const staticParamsObj =
      staticParams?.reduce(
        (acc, { key, value }) => {
          const replacedKey = replaceVariables(key);
          const replacedValue = replaceVariables(value);
          acc[replacedKey] = replacedValue;
          return acc;
        },
        {} as Record<string, any>
      ) || {};

    const mergedParams = routed
      ? { ...staticParamsObj, ...routed.query }
      : method.toUpperCase() === 'GET' || staticParams
        ? { ...staticParamsObj, ...params }
        : staticParamsObj;

    return Object.keys(mergedParams).length > 0 ? mergedParams : undefined;
  })();

  return {
    headers,
    body,
    queryParams,
    pathParams: routed?.path ?? {}
  };
};

/** 把 `{name}` 形式的路径参数替换为编码后的实际值 */
const fillPathParams = (toolPath: string, pathParams: Record<string, any>) =>
  Object.entries(pathParams).reduce(
    (path, [key, value]) => path.split(`{${key}}`).join(encodeURIComponent(String(value))),
    toolPath
  );

export const runHTTPTool = async ({
  baseUrl,
  toolPath,
  method = 'POST',
  params,
  headerSecret,
  customHeaders,
  staticParams,
  staticHeaders,
  staticBody,
  requestSchema
}: RunHTTPToolParams): Promise<RunHTTPToolResult> => {
  try {
    // Construct full base URL
    const fullBaseUrl = !baseUrl
      ? ''
      : baseUrl.startsWith('http://') || baseUrl.startsWith('https://')
        ? baseUrl
        : `https://${baseUrl}`;

    // SSRF Protection: Validate URL before making request
    // When baseUrl is empty, toolPath must be a complete URL
    const { headers, body, queryParams, pathParams } = buildHttpRequest({
      method,
      params,
      headerSecret,
      customHeaders,
      staticParams,
      staticHeaders,
      staticBody,
      requestSchema
    });
    const requestPath = fillPathParams(toolPath, pathParams);

    const fullUrl = fullBaseUrl
      ? new URL(requestPath, fullBaseUrl).toString()
      : new URL(requestPath).toString();

    if (await isInternalAddress(fullUrl)) {
      return { errorMsg: PRIVATE_URL_TEXT };
    }

    const { data } = await axios({
      method: method.toUpperCase(),
      baseURL: fullBaseUrl,
      url: requestPath,
      headers,
      data: body,
      params: queryParams,
      timeout: 300000
    });

    return { data };
  } catch (error) {
    logger.warn('HTTP tool request failed', { error });
    return { errorMsg: getErrText(error) };
  }
};

export const getHTTPToolList = async (app: AppSchemaType) => {
  const modules = decodeHttpToolSetNodesFromStorage(app.modules);
  return (
    modules[0].toolConfig?.httpToolSet?.toolList.map((item) => ({
      ...item,
      id: `${AppToolSourceEnum.http}-${String(app._id)}/${item.name}`,
      avatar: app.avatar
    })) ?? []
  );
};
