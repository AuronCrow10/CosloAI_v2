import axios, { AxiosRequestConfig } from "axios";
import { requireShopifyConfig } from "./config";

type GraphQlResponse<T> = {
  data?: T;
  errors?: Array<{ message: string }>;
};

async function requestWithRetry<T>(config: AxiosRequestConfig): Promise<T> {
  const maxAttempts = 3;
  let lastErr: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const res = await axios.request<T>(config);
      return res.data;
    } catch (err: any) {
      lastErr = err;
      const status = err?.response?.status;
      if (status !== 429 && status !== 500 && status !== 502 && status !== 503) {
        throw err;
      }
      const retryAfter =
        Number(err?.response?.headers?.["retry-after"]) || 1 + attempt;
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
    }
  }

  throw lastErr;
}

export async function shopifyAdminRest<T>(
  shopDomain: string,
  accessToken: string,
  path: string,
  method: AxiosRequestConfig["method"] = "GET",
  data?: any,
  params?: Record<string, any>
): Promise<T> {
  const { apiVersion } = requireShopifyConfig();

  return requestWithRetry<T>({
    method,
    url: `https://${shopDomain}/admin/api/${apiVersion}${path}`,
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json"
    },
    data,
    params,
    timeout: 20000
  });
}

export async function shopifyAdminGraphql<T>(
  shopDomain: string,
  accessToken: string,
  query: string,
  variables?: Record<string, any>
): Promise<T> {
  const { apiVersion } = requireShopifyConfig();
  const data = await requestWithRetry<GraphQlResponse<T>>({
    method: "POST",
    url: `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`,
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json"
    },
    data: { query, variables },
    timeout: 20000
  });

  if (data.errors && data.errors.length > 0) {
    throw new Error(data.errors.map((e) => e.message).join("; "));
  }

  if (!data.data) {
    throw new Error("Shopify GraphQL response missing data");
  }

  return data.data;
}
