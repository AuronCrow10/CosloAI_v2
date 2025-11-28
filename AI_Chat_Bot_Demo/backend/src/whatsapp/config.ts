export type WhatsAppBotConfig = {
  phoneNumberId: string; // Meta's phone_number_id
  botSlug: string;       // demo bot slug
};

// For now, maintain this array manually.
// Later you can load from a JSON file or DB if you want.
const WHATSAPP_BOTS: WhatsAppBotConfig[] = [
  {
    phoneNumberId: "885569401305770",
    botSlug: "cosmin-marica"
  },
  {
    phoneNumberId: "987654321098765",
    botSlug: "ristorante-roma"
  }
];

export function getBotSlugByPhoneNumberId(phoneNumberId: string): string | null {
  const entry = WHATSAPP_BOTS.find((b) => b.phoneNumberId === phoneNumberId);
  return entry ? entry.botSlug : null;
}
