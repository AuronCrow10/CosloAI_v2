// services/knowledgeClient.ts
import axios from "axios";
import FormData from "form-data";
import { config } from "../config";

const client = axios.create({
  baseURL: config.knowledgeBaseUrl,
  timeout: 120000,
  headers: {
    "X-Internal-Token": config.knowledgeInternalToken
  }
});

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
  estimateId?: string;
}): Promise<{ status: string; jobId: string; clientId: string; domain: string }> {
  const res = await client.post("/crawl", {
    clientId: params.clientId,
    domain: params.domain,
    estimateId: params.estimateId
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
  return res.data; // { page, pageSize, totalItems, totalPages, jobs }
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

// ✅ Canonical ingest endpoint: /ingest-docs
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

export async function deactivateChunksByJob(params: {
  clientId: string;
  jobId: string;
}): Promise<{ status: string; jobId: string; jobType: string; deactivated: number }> {
  const res = await client.post("/chunks/deactivate", {
    clientId: params.clientId,
    jobId: params.jobId
  });
  return res.data;
}

export async function listChunksByJob(params: {
  clientId: string;
  jobId: string;
}): Promise<{
  jobId: string;
  jobType: string;
  chunks: { id: string; url: string; chunkIndex: number; text: string; createdAt: string }[];
}> {
  const q = new URLSearchParams({
    clientId: params.clientId,
    jobId: params.jobId
  });
  const res = await client.get(`/chunks/by-job?${q.toString()}`);
  return res.data;
}

export async function updateChunkText(params: {
  clientId: string;
  chunkId: string;
  text: string;
}): Promise<{ chunk: { id: string; url: string; chunkIndex: number; text: string; createdAt: string } }> {
  const res = await client.post("/chunks/update", {
    clientId: params.clientId,
    chunkId: params.chunkId,
    text: params.text
  });
  return res.data;
}

export async function deleteChunk(params: {
  clientId: string;
  chunkId: string;
}): Promise<{ status: string; chunkId: string }> {
  const res = await client.post("/chunks/delete", {
    clientId: params.clientId,
    chunkId: params.chunkId
  });
  return res.data;
}
