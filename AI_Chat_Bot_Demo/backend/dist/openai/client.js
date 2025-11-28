"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.openai = void 0;
exports.getChatCompletion = getChatCompletion;
const openai_1 = __importDefault(require("openai"));
const config_1 = require("../config");
exports.openai = new openai_1.default({
    apiKey: config_1.config.openaiApiKey
});
async function getChatCompletion(params) {
    const { messages, model = "gpt-4.1-mini", maxTokens = 400 } = params;
    const completion = await exports.openai.chat.completions.create({
        model,
        messages,
        max_tokens: maxTokens
    });
    const choice = completion.choices[0];
    const content = choice?.message?.content;
    if (!content) {
        throw new Error("No content returned from OpenAI");
    }
    return content;
}
