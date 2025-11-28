// src/pages/app/ConversationDetailPage.tsx
import React, { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ConversationMessage,
  fetchConversationMessages
} from "../../api/bots";

const ConversationDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setError(null);
    fetchConversationMessages(id)
      .then((data) => setMessages(data))
      .catch((err: any) => {
        console.error(err);
        setError(err.message || "Failed to load messages");
      })
      .finally(() => setLoading(false));
  }, [id]);

  if (!id) {
    return (
      <div className="page-container">
        <p>Missing conversation ID.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h1>Conversation</h1>
        <Link to="/app/bots" className="btn-secondary">
          ← Back to bots
        </Link>
      </div>
      {loading && <p>Loading messages...</p>}
      {error && <div className="form-error">{error}</div>}
      {!loading && !error && messages.length === 0 && <p>No messages.</p>}
      {!loading && !error && messages.length > 0 && (
        <div className="conversation-view">
          {messages.map((m) => (
            <div
              key={m.id}
              className={`conversation-message conversation-message-${m.role.toLowerCase()}`}
            >
              <div className="conversation-meta">
                <span className="conversation-role">
                  {m.role === "USER"
                    ? "User"
                    : m.role === "ASSISTANT"
                    ? "Assistant"
                    : "System"}
                </span>
                <span className="conversation-time">
                  {new Date(m.createdAt).toLocaleString()}
                </span>
              </div>
              <div className="conversation-content">{m.content}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ConversationDetailPage;
