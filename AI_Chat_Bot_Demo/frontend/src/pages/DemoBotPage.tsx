import React, { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { BotInfo, fetchBotInfo } from "../api/client";
import Chat from "../components/Chat";

const DemoBotPage: React.FC = () => {
  const { slug } = useParams<{ slug: string }>();
  const [bot, setBot] = useState<BotInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;

    setLoading(true);
    setError(null);

    fetchBotInfo(slug)
      .then((data) => {
        setBot(data);
      })
      .catch((err) => {
        console.error(err);
        setError(err.message || "Failed to load bot");
      })
      .finally(() => {
        setLoading(false);
      });
  }, [slug]);

  if (!slug) {
    return (
      <div className="page-container">
        <p>No bot slug provided.</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="page-container">
        <p>Loading bot...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="page-container">
        <h2>Error</h2>
        <p>{error}</p>
      </div>
    );
  }

  if (!bot) {
    return (
      <div className="page-container">
        <h2>Bot not found</h2>
        <p>Please check the link you were given.</p>
      </div>
    );
  }

  return (
    <div className="page-container">
      <header className="bot-header">
        <div className="bot-avatar">{bot.name.charAt(0).toUpperCase()}</div>
        <div>
          <h1 className="bot-title">{bot.name}</h1>
          {bot.description && <p className="bot-description">{bot.description}</p>}
        </div>
      </header>
      <Chat slug={bot.slug} botName={bot.name} />
    </div>
  );
};

export default DemoBotPage;
