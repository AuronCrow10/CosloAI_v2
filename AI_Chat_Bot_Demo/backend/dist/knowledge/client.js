"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.searchKnowledge = searchKnowledge;
const axios_1 = __importDefault(require("axios"));
const config_1 = require("../config");
async function searchKnowledge(params) {
    const { clientId, query, domain, limit = 5 } = params;
    console.log(clientId, query, domain);
    const url = `${config_1.config.knowledgeBaseUrl}/search`;
    const response = await axios_1.default.post(url, {
        clientId,
        query,
        // domain,
        limit
    }, {
        headers: {
            "Content-Type": "application/json",
            "X-Internal-Token": config_1.config.knowledgeInternalToken
        },
        timeout: 10000
    });
    if (!response.data || !Array.isArray(response.data.results)) {
        throw new Error("Invalid response from Knowledge Backend");
    }
    return response.data.results;
}
