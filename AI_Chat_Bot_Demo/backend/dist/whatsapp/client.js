"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendWhatsAppTextMessage = sendWhatsAppTextMessage;
const axios_1 = __importDefault(require("axios"));
const config_1 = require("../config");
/**
 * Sends a text message via WhatsApp Cloud API.
 */
async function sendWhatsAppTextMessage(params) {
    const { phoneNumberId, to, text } = params;
    if (!config_1.config.whatsappApiBaseUrl || !config_1.config.whatsappAccessToken) {
        throw new Error("WhatsApp API is not configured");
    }
    const url = `${config_1.config.whatsappApiBaseUrl}/${phoneNumberId}/messages`;
    await axios_1.default.post(url, {
        messaging_product: "whatsapp",
        to,
        text: {
            body: text
        }
    }, {
        headers: {
            Authorization: `Bearer ${config_1.config.whatsappAccessToken}`,
            "Content-Type": "application/json"
        },
        timeout: 10000
    });
}
