// src/pages/app/BotKnowledgePage.tsx
import React, { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  Bot,
  getBotById,
  updateBot,
  crawlBotDomain,
  uploadBotDocuments
} from "../../api/bots";

const BotKnowledgePage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const [bot, setBot] = useState<Bot | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [crawlLoading, setCrawlLoading] = useState(false);
  const [uploadLoading, setUploadLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [domain, setDomain] = useState<string>("");
  const [systemPrompt, setSystemPrompt] = useState<string>("");

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setError(null);
    getBotById(id)
      .then((data) => {
        setBot(data);
        setDomain(data.domain || "");
        setSystemPrompt(data.systemPrompt);
      })
      .catch((err: any) => {
        console.error(err);
        setError(err.message || "Failed to load bot");
      })
      .finally(() => setLoading(false));
  }, [id]);

  const handleSaveSettings: React.FormEventHandler = async (e) => {
    e.preventDefault();
    if (!id || !bot) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const updated = await updateBot(id, {
        domain: domain || null,
        systemPrompt
      });
      setBot(updated);
      setSuccess("Knowledge settings updated.");
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Failed to update settings");
    } finally {
      setSaving(false);
    }
  };

  const handleCrawlDomain = async () => {
    if (!id || !bot) return;

    if (bot.status !== "ACTIVE") {
      setError("This bot is not active yet. Activate it before crawling content.");
      return;
    }

    if (!domain.trim()) {
      setError("Please set a domain before crawling.");
      return;
    }
    if (!bot.useDomainCrawler) {
      setError("Domain crawler feature is disabled for this bot.");
      return;
    }
    setError(null);
    setSuccess(null);
    setCrawlLoading(true);
    try {
      const resp = await crawlBotDomain(id, domain.trim());
      setSuccess(
        `Domain crawl started/completed for ${resp.domain}. Knowledge client: ${resp.knowledgeClientId}`
      );
      // Refresh bot to get updated knowledgeClientId
      const refreshed = await getBotById(id);
      setBot(refreshed);
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Failed to crawl domain");
    } finally {
      setCrawlLoading(false);
    }
  };

  const handleUploadDocs: React.ChangeEventHandler<HTMLInputElement> = async (
    e
  ) => {
    if (!id || !bot) return;

    if (bot.status !== "ACTIVE") {
      setError("This bot is not active yet. Activate it before uploading documents.");
      e.target.value = "";
      return;
    }

    const files = e.target.files;
    if (!files || files.length === 0) return;
    if (!bot.usePdfCrawler) {
      setError("PDF upload feature is disabled for this bot.");
      e.target.value = "";
      return;
    }
    setError(null);
    setSuccess(null);
    setUploadLoading(true);
    try {
      const resp = await uploadBotDocuments(id, files);
      setSuccess(
        `Uploaded and ingested ${resp.files.length} document(s): ${resp.files.join(
          ", "
        )}`
      );
      const refreshed = await getBotById(id);
      setBot(refreshed);
      e.target.value = ""; // reset input
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Failed to upload documents");
    } finally {
      setUploadLoading(false);
    }
  };

  if (!id) {
    return (
      <div className="page-container">
        <p>Missing bot ID.</p>
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

  if (error && !bot) {
    return (
      <div className="page-container">
        <h1>Error</h1>
        <p>{error}</p>
      </div>
    );
  }

  if (!bot) {
    return (
      <div className="page-container">
        <h1>Bot not found</h1>
      </div>
    );
  }

  const isActive = bot.status === "ACTIVE";
  const knowledgeMissing =
    (bot.useDomainCrawler || bot.usePdfCrawler) && !bot.knowledgeClientId;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Content &amp; Knowledge</h1>
          <p className="muted">
            Configure domain, prompt and trigger crawls or document ingestion
            for <strong>{bot.name}</strong>.
          </p>
        </div>
        <Link to={`/app/bots/${bot.id}`} className="btn-secondary">
          ← Back to bot
        </Link>
      </div>

      {error && <div className="form-error">{error}</div>}
      {success && <div className="form-success">{success}</div>}

      <div className="detail-layout">
        <section className="detail-main">
          <h2>Knowledge settings</h2>

          {/* If bot is NOT active → lock the whole section and show a status card only */}
          {!isActive ? (
            <div className="status-overview" style={{ marginTop: "0.75rem" }}>
              <div className="status-row">
                <div className="status-row-header">
                  <span className="status-label">Knowledge status</span>
                  <span className="status-badge status-badge-warn">
                    Locked
                  </span>
                </div>
                <p className="muted">
                  This bot is currently <strong>{bot.status}</strong>. Activate it in{" "}
                  <Link to={`/app/bots/${bot.id}/features`}>
                    Features &amp; Plan
                  </Link>{" "}
                  before crawling your site or uploading documents.
                </p>
              </div>
            </div>
          ) : (
            <>
              {/* If active but no KB yet → same style status card as overview */}
              {knowledgeMissing && (
                <div
                  className="status-overview"
                  style={{ marginTop: "0.75rem", marginBottom: "0.75rem" }}
                >
                  <div className="status-row">
                    <div className="status-row-header">
                      <span className="status-label">Knowledge status</span>
                      <span className="status-badge status-badge-warn">
                        Missing
                      </span>
                    </div>
                    <p className="muted">
                      No knowledge base has been built yet. Crawl your domain or
                      upload PDFs to give this bot real context.
                    </p>
                  </div>
                </div>
              )}

              {/* Settings form */}
              <form className="form" onSubmit={handleSaveSettings}>
                <label className="form-field">
                  <span>Domain</span>
                  <input
                    type="text"
                    value={domain}
                    onChange={(e) => setDomain(e.target.value)}
                    placeholder="https://example.com"
                  />
                  <small>
                    This domain is used when crawling your site and for RAG search
                    context.
                  </small>
                </label>
                <label className="form-field">
                  <span>System prompt</span>
                  <textarea
                    value={systemPrompt}
                    onChange={(e) => setSystemPrompt(e.target.value)}
                    rows={4}
                  />
                </label>
                <button className="btn-primary" type="submit" disabled={saving}>
                  {saving ? "Saving..." : "Save settings"}
                </button>
              </form>

              <hr />

              {/* Domain crawler */}
              <h2>Domain crawler</h2>
              {!bot.useDomainCrawler && (
                <p className="muted">
                  Domain crawler is disabled for this bot. Enable it in{" "}
                  <Link to={`/app/bots/${bot.id}/features`}>
                    Features &amp; Plan
                  </Link>{" "}
                  if you want to crawl your website.
                </p>
              )}
              {bot.useDomainCrawler && (
                <>
                  <p className="muted">
                    We&apos;ll crawl the configured domain and index the content as
                    knowledge for this bot.
                  </p>
                  <button
                    className="btn-secondary"
                    type="button"
                    onClick={handleCrawlDomain}
                    disabled={crawlLoading}
                  >
                    {crawlLoading ? "Crawling..." : "Crawl domain now"}
                  </button>
                </>
              )}

              <hr />

              {/* Upload docs */}
              <h2>Upload documents (PDFs)</h2>
              {!bot.usePdfCrawler && (
                <p className="muted">
                  PDF ingestion is disabled for this bot. Enable it in{" "}
                  <Link to={`/app/bots/${bot.id}/features`}>
                    Features &amp; Plan
                  </Link>{" "}
                  if you want to upload docs.
                </p>
              )}
              {bot.usePdfCrawler && (
                <div className="form-field">
                  <span>Upload one or more files</span>
                  <input
                    type="file"
                    accept=".pdf,.doc,.docx,.txt"
                    multiple
                    onChange={handleUploadDocs}
                    disabled={uploadLoading}
                  />
                  {uploadLoading && <p>Uploading...</p>}
                </div>
              )}
            </>
          )}
        </section>

        <section className="detail-side">
          <h2>Status</h2>
          <p>
            Knowledge client:{" "}
            {bot.knowledgeClientId ? (
              <code>{bot.knowledgeClientId}</code>
            ) : (
              <span className="muted">not created yet</span>
            )}
          </p>
          <p>
            Bot status: <strong>{bot.status}</strong>
          </p>
        </section>
      </div>
    </div>
  );
};

export default BotKnowledgePage;
