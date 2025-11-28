"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBotSlugByPhoneNumberId = getBotSlugByPhoneNumberId;
// For now, maintain this array manually.
// Later you can load from a JSON file or DB if you want.
const WHATSAPP_BOTS = [
    {
        phoneNumberId: "885569401305770",
        botSlug: "cosmin-marica"
    },
    {
        phoneNumberId: "987654321098765",
        botSlug: "ristorante-roma"
    }
];
function getBotSlugByPhoneNumberId(phoneNumberId) {
    const entry = WHATSAPP_BOTS.find((b) => b.phoneNumberId === phoneNumberId);
    return entry ? entry.botSlug : null;
}
