// src/pages/WidgetBotPage.tsx
import React, { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { BotInfo, fetchBotInfo } from "../api/client";
import Chat from "../components/Chat";

const WidgetBotPage: React.FC = () => {
  const { slug } = useParams<{ slug: string }>();
  const [bot, setBot] = useState<BotInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;

    setLoading(true);
    setError(null);

    fetchBotInfo(slug)
      .then((data) => setBot(data))
      .catch((err) => {
        console.error(err);
        setError(err.message || "Failed to load bot");
      })
      .finally(() => setLoading(false));
  }, [slug]);

  if (!slug) return <div>No bot slug provided.</div>;
  if (loading) return <div>Loading...</div>;
  if (error) return <div>{error}</div>;
  if (!bot) return <div>Bot not found.</div>;

  return (
    <div
      style={{
        height: "100vh",
        margin: 0,
        padding: 8,
        boxSizing: "border-box",
        backgroundColor: "#f5f5f5",
        fontFamily: "system-ui, sans-serif"
      }}
    >
      <Chat slug={bot.slug} botName={bot.name} />
    </div>
  );
};

export default WidgetBotPage;
