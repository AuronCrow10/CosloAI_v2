import axios from "axios";
import FormData from "form-data";
import { config } from "../config";

const client = axios.create({
  baseURL: config.knowledgeBaseUrl,
  timeout: 15000,
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
  }
);
  return res.data;
}

export async function crawlDomain(params: {
  clientId: string;
  domain: string;
}): Promise<void> {
  console.log(params);
  await client.post("/crawl", {
    clientId: params.clientId,
    domain: params.domain
  });
}

// Upload documents to /ingest-docs
export async function ingestDocs(params: {
  clientId: string;
  files: Express.Multer.File[];
}): Promise<void> {
  const form = new FormData();
  form.append("clientId", params.clientId);
  for (const f of params.files) {
    form.append("files", f.buffer, {
      filename: f.originalname,
      contentType: f.mimetype
    });
  }

  await client.post("/ingest-docs", form, {
    headers: {
      ...form.getHeaders()
    },
    maxBodyLength: Infinity
  });
}
