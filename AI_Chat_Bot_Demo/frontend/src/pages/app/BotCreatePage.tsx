// src/pages/app/BotCreatePage.tsx
import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { createBot, CreateBotPayload, Bot } from "../../api/bots";

const BotCreatePage: React.FC = () => {
  const navigate = useNavigate();

  // Keep local form state minimal: just identity
  const [form, setForm] = useState<{
    name: string;
    slug: string;
    description: string;
  }>({
    name: "",
    slug: "",
    description: ""
  });

  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleChange =
    (field: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const value = e.target.value;
      setForm((prev) => ({
        ...prev,
        [field]: value
      }));
    };

  const handleSubmit: React.FormEventHandler = async (e) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      const payload: CreateBotPayload = {
        name: form.name.trim(),
        slug: form.slug.trim(),
        description: form.description.trim() || undefined
        // All other fields (systemPrompt, domain, features, calendar...)
        // will use backend defaults and can be configured later.
      };

      const bot: Bot = await createBot(payload);

      // After creating, send user directly to Features & Plan,
      // where they can enable channels, crawlers, calendar, etc.
      navigate(`/app/bots/${bot.id}/features`);
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Failed to create bot");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div>
      <div className="page-header">
        <h1>Create new bot</h1>
      </div>
      <form className="form" onSubmit={handleSubmit}>
        {error && <div className="form-error">{error}</div>}

        <p className="muted">
          Step 1: choose a name and a slug. You can configure channels,
          knowledge, bookings and billing after this.
        </p>

        <label className="form-field">
          <span>Name</span>
          <input
            type="text"
            value={form.name}
            onChange={handleChange("name")}
            required
          />
        </label>

        <label className="form-field">
          <span>Slug</span>
          <input
            type="text"
            value={form.slug}
            onChange={handleChange("slug")}
            required
          />
          <small>Used in demo URLs, widget, and internal routing.</small>
        </label>

        <label className="form-field">
          <span>Description (optional)</span>
          <textarea
            value={form.description}
            onChange={handleChange("description")}
            rows={2}
          />
        </label>

        <button className="btn-primary" type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Creating..." : "Create bot"}
        </button>
      </form>
    </div>
  );
};

export default BotCreatePage;
