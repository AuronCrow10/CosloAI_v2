import axios from "axios";
import FormData from "form-data";
import { config } from "../config";

export interface KnowledgeSearchResult {
  id: string;
  clientId: string;
  domain: string;
  url: string;
  chunkIndex: number;
  text: string;
  score: number;
  createdAt: string;
}

export interface KnowledgeSearchResponse {
  results: KnowledgeSearchResult[];
}

const client = axios.create({
  baseURL: config.knowledgeBaseUrl,
  timeout: 600000,
  headers: {
    "X-Internal-Token": config.knowledgeInternalToken
  }
});

export async function searchKnowledge(params: {
  clientId: string;
  query: string;
  domain?: string;
  limit?: number;
}): Promise<KnowledgeSearchResult[]> {
  const { clientId, query, domain, limit = 5 } = params;

  const url = `${config.knowledgeBaseUrl}/search`;

  const response = await axios.post<KnowledgeSearchResponse>(
    url,
    {
      clientId,
      query,
      domain,
      limit
    },
    {
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Token": config.knowledgeInternalToken
      },
      timeout: 10_000
    }
  );

  if (!response.data || !Array.isArray(response.data.results)) {
    throw new Error("Invalid response from Knowledge Backend");
  }

  return response.data.results;
}

export async function createKnowledgeClient(params: {
  name: string;
  domain?: string | null;
}): Promise<{ client: { id: string } }> {
  const res = await client.post("/clients", {
    name: params.name,
    mainDomain: params.domain || undefined,
    embeddingModel: "text-embedding-3-small"
  });
  return res.data;
}

export async function crawlDomain(params: {
  clientId: string;
  domain: string;
}): Promise<{ status: string; jobId: string; clientId: string; domain: string }> {
  const res = await client.post("/crawl", {
    clientId: params.clientId,
    domain: params.domain
  });
  return res.data;
}

export async function getCrawlJob(jobId: string): Promise<any> {
  const res = await client.get(`/crawl/jobs/${encodeURIComponent(jobId)}`);
  return res.data; // { job: ... }
}

export async function listCrawlJobs(params: {
  clientId: string;
  page: number;
  pageSize: number;
}): Promise<any> {
  const q = new URLSearchParams({
    clientId: params.clientId,
    page: String(params.page),
    pageSize: String(params.pageSize)
  });
  const res = await client.get(`/crawl/jobs?${q.toString()}`);
  return res.data;
}

export async function estimateCrawl(domain: string): Promise<any> {
  const res = await client.post("/estimate/crawl", { domain });
  return res.data; // { estimate: ... }
}

export async function estimateDocs(params: {
  clientId: string;
  files: Express.Multer.File[];
  domain?: string | null;
}): Promise<any> {
  const form = new FormData();
  form.append("clientId", params.clientId);
  if (params.domain) form.append("domain", params.domain);

  for (const f of params.files) {
    form.append("files", f.buffer, {
      filename: f.originalname,
      contentType: f.mimetype
    });
  }

  const res = await client.post("/estimate/docs", form, {
    headers: { ...form.getHeaders() },
    maxBodyLength: Infinity
  });

  return res.data; // { estimate: ... }
}

export async function ingestDocs(params: {
  clientId: string;
  files: Express.Multer.File[];
  domain?: string | null;
}): Promise<any> {
  const form = new FormData();
  form.append("clientId", params.clientId);
  if (params.domain) form.append("domain", params.domain);

  for (const f of params.files) {
    form.append("files", f.buffer, {
      filename: f.originalname,
      contentType: f.mimetype
    });
  }

  const res = await client.post("/ingest-docs", form, {
    headers: { ...form.getHeaders() },
    maxBodyLength: Infinity
  });

  return res.data;
}

export async function deleteKnowledgeClient(clientId: string): Promise<void> {
  try {
    await client.delete(`/clients/${clientId}`);
  } catch (err: any) {
    if (err.response && err.response.status === 404) {
      console.warn(`Knowledge client ${clientId} not found while deleting, continuing.`);
      return;
    }
    console.error(`Failed to delete knowledge client ${clientId}`, err);
    throw err;
  }
}
