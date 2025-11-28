"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createKnowledgeClient = createKnowledgeClient;
exports.crawlDomain = crawlDomain;
exports.ingestDocs = ingestDocs;
const axios_1 = __importDefault(require("axios"));
const form_data_1 = __importDefault(require("form-data"));
const config_1 = require("../config");
const client = axios_1.default.create({
    baseURL: config_1.config.knowledgeBaseUrl,
    timeout: 15000,
    headers: {
        "X-Internal-Token": config_1.config.knowledgeInternalToken
    }
});
async function createKnowledgeClient(params) {
    const res = await client.post("/clients", {
        name: params.name,
        mainDomain: params.domain || undefined,
        embeddingModel: "text-embedding-3-small"
    });
    return res.data;
}
async function crawlDomain(params) {
    console.log(params);
    await client.post("/crawl", {
        clientId: params.clientId,
        domain: params.domain
    });
}
// Upload documents to /ingest-docs
async function ingestDocs(params) {
    const form = new form_data_1.default();
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
