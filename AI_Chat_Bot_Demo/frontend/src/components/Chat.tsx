import React, { useState } from "react";
import { ChatResponse, sendChatMessage } from "../api/client";

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
};

interface ChatProps {
  slug: string;
  botName: string;
}

const Chat: React.FC<ChatProps> = ({ slug, botName }) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || isSending) return;

    setError(null);

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: trimmed
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsSending(true);

    try {
      const response: ChatResponse = await sendChatMessage(slug, {
        message: trimmed,
        conversationId
      });

      if (response.conversationId && response.conversationId !== conversationId) {
        setConversationId(response.conversationId);
      }

      const assistantMessage: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content: response.reply
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Failed to send message");
      const systemMessage: ChatMessage = {
        id: `system-${Date.now()}`,
        role: "system",
        content: "Sorry, there was an error sending your message. Please try again."
      };
      setMessages((prev) => [...prev, systemMessage]);
    } finally {
      setIsSending(false);
    }
  };

  const handleKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement> = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="chat-container">
      <div className="chat-messages">
        {messages.length === 0 && (
          <div className="chat-empty">
            <p>
              You’re chatting with <strong>{botName}</strong>. Ask anything about their website.
            </p>
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className={`chat-message chat-message-${msg.role}`}>
            <div className="chat-message-bubble">
              {msg.role !== "system" && (
                <div className="chat-message-role">
                  {msg.role === "user" ? "You" : botName}
                </div>
              )}
              <div className="chat-message-content">{msg.content}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="chat-input-container">
        {error && <div className="chat-error">{error}</div>}
        <textarea
          className="chat-input"
          placeholder={`Ask ${botName} a question...`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={3}
          maxLength={2000}
        />
        <button className="chat-send-button" onClick={handleSend} disabled={isSending || !input.trim()}>
          {isSending ? "Sending..." : "Send"}
        </button>
      </div>
    </div>
  );
};

export default Chat;
