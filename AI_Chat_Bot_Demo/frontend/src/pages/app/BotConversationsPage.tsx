// src/pages/app/BotConversationsPage.tsx
import React, { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Conversation, fetchBotConversations } from "../../api/bots";

const BotConversationsPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setError(null);
    fetchBotConversations(id)
      .then((data) => setConversations(data))
      .catch((err: any) => {
        console.error(err);
        setError(err.message || "Failed to load conversations");
      })
      .finally(() => setLoading(false));
  }, [id]);

  if (!id) {
    return (
      <div className="page-container">
        <p>Missing bot ID.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Conversations</h1>
          <p className="muted">
            All conversations across web, WhatsApp, Facebook Messenger and Instagram.
          </p>
        </div>
        <Link to={`/app/bots/${id}`} className="btn-secondary">
          ← Back to bot
        </Link>
      </div>

      {loading && <p>Loading conversations...</p>}
      {error && <div className="form-error">{error}</div>}
      {!loading && !error && conversations.length === 0 && (
        <p>No conversations yet.</p>
      )}
      {!loading && !error && conversations.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Channel</th>
              <th>External user</th>
              <th>Last message</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {conversations.map((c) => (
              <tr key={c.id}>
                <td>{c.channel}</td>
                <td>{maskExternalUserId(c.externalUserId)}</td>
                <td>{new Date(c.lastMessageAt).toLocaleString()}</td>
                <td>
                  <Link
                    to={`/app/conversations/${c.id}`}
                    className="btn-link"
                  >
                    View
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

function maskExternalUserId(id: string): string {
  if (id.length <= 4) return "****";
  return `${"*".repeat(Math.max(0, id.length - 4))}${id.slice(-4)}`;
}

export default BotConversationsPage;
