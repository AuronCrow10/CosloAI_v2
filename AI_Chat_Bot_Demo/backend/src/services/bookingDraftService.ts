// services/bookingDraftService.ts

export type BookingDraft = {
  name?: string;
  email?: string;
  phone?: string;
  service?: string;
  datetime?: string;
  customFields: Record<string, string>;
};

/**
 * NOTE: This is an in-memory store keyed by conversationId.
 * In production you probably want to persist this in your DB
 * (e.g. a JSON column on Conversation, or a separate table).
 */
const inMemoryDrafts = new Map<string, BookingDraft>();

export async function loadBookingDraft(
  conversationId: string
): Promise<BookingDraft | null> {
  const draft = inMemoryDrafts.get(conversationId);
  if (!draft) return null;

  // Return a shallow copy to avoid accidental external mutation
  return {
    ...draft,
    customFields: { ...(draft.customFields || {}) }
  };
}

/**
 * Merge new booking fields into the existing draft for this conversation.
 * `args` is whatever the tool passed; `customFieldNames` is used to separate
 * base fields from custom fields.
 */
export async function updateBookingDraft(
  conversationId: string,
  args: Record<string, any>,
  customFieldNames: string[]
): Promise<BookingDraft> {
  const existing: BookingDraft =
    inMemoryDrafts.get(conversationId) || { customFields: {} };

  const updated: BookingDraft = {
    ...existing,
    customFields: { ...(existing.customFields || {}) }
  };

  if (typeof args.name === "string" && args.name.trim()) {
    updated.name = args.name.trim();
  }

  if (typeof args.email === "string" && args.email.trim()) {
    updated.email = args.email.trim();
  }

  if (typeof args.phone === "string" && args.phone.trim()) {
    updated.phone = args.phone.trim();
  }

  if (typeof args.service === "string" && args.service.trim()) {
    updated.service = args.service.trim();
  }

  if (typeof args.datetime === "string" && args.datetime.trim()) {
    updated.datetime = args.datetime.trim();
  }

  for (const fieldName of customFieldNames) {
    const value = args[fieldName];
    if (typeof value === "string" && value.trim()) {
      updated.customFields[fieldName] = value.trim();
    }
  }

  inMemoryDrafts.set(conversationId, updated);
  return updated;
}
