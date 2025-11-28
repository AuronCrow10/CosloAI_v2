"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendFacebookTextMessage = sendFacebookTextMessage;
exports.sendInstagramTextMessage = sendInstagramTextMessage;
const axios_1 = __importDefault(require("axios"));
const config_1 = require("../config");
function getBaseUrl() {
    const base = config_1.config.metaGraphApiBaseUrl;
    if (!base) {
        throw new Error("META_GRAPH_API_BASE_URL is not configured");
    }
    return base.replace(/\/+$/, ""); // trim trailing slash
}
async function sendFacebookTextMessage(params) {
    const { pageId, accessToken, recipientId, text } = params;
    const baseUrl = getBaseUrl();
    const url = `${baseUrl}/${pageId}/messages`;
    await axios_1.default.post(url, {
        messaging_type: "RESPONSE",
        recipient: { id: recipientId },
        message: { text }
    }, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json"
        },
        timeout: 10000
    });
}
async function sendInstagramTextMessage(params) {
    const { igBusinessId, accessToken, recipientId, text } = params;
    const baseUrl = getBaseUrl();
    const url = `${baseUrl}/${igBusinessId}/messages`;
    await axios_1.default.post(url, {
        messaging_type: "RESPONSE",
        recipient: { id: recipientId },
        message: { text }
    }, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json"
        },
        timeout: 10000
    });
}
