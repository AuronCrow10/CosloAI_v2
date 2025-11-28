// src/pages/app/BotsListPage.tsx
import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Bot, fetchBots } from "../../api/bots";

const BotsListPage: React.FC = () => {
  const [bots, setBots] = useState<Bot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchBots()
      .then((data) => setBots(data))
      .catch((err: any) => {
        console.error(err);
        setError(err.message || "Failed to load bots");
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <div className="page-header">
        <h1>Your bots</h1>
        <Link className="btn-primary" to="/app/bots/new">
          Create new bot
        </Link>
      </div>
      {loading && <p>Loading bots...</p>}
      {error && <div className="form-error">{error}</div>}
      {!loading && !error && bots.length === 0 && <p>No bots yet.</p>}
      {!loading && !error && bots.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Slug</th>
              <th>Status</th>
              <th>Domain</th>
              <th>Channels</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {bots.map((bot) => (
              <tr key={bot.id}>
                <td>{bot.name}</td>
                <td>{bot.slug}</td>
                <td>{bot.status}</td>
                <td>{bot.domain || "-"}</td>
                <td>
                  {[
                    bot.channelWeb && "Web",
                    bot.channelWhatsapp && "WhatsApp",
                    bot.channelMessenger && "Messenger",
                    bot.channelInstagram && "Instagram"
                  ]
                    .filter(Boolean)
                    .join(", ") || "-"}
                </td>
                <td>
                  <Link to={`/app/bots/${bot.id}`} className="btn-link">
                    Open
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

export default BotsListPage;
