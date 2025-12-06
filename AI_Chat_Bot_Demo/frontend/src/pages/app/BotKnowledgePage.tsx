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
        `Domain crawl started/completed for ${resp.domain}. The knowledge base will be refreshed shortly.`
      );
      // Refresh bot to get updated knowledgeClientId, even if we don't display it here
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

      {/* Single full-width card instead of detail-layout with right side */}
      {/*  <section className="detail-main knowledge-main">
        <h2>Knowledge settings</h2>*/}

        {/* If bot is NOT active → lock everything */}
        {!isActive ? (
          <div className="status-overview" style={{ marginTop: "0.75rem" }}>
            <div className="status-row">
              <div className="status-row-header">
                <span className="status-label">Knowledge status</span>
                <span className="status-badge status-badge-warn">Locked</span>
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
            {/* Active but no KB yet → status card */}
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

            {/* Two main cards: Domain knowledge + Documents */}
            <div className="knowledge-cards">
              {/* Domain card */}
              <section className="knowledge-card">
                <div className="knowledge-card-header">
                  <div>
                    <h3 className="knowledge-card-title">Domain knowledge</h3>
                    <p className="knowledge-card-description">
                      Configure the website to crawl and refine how the bot
                      should use it in answers.
                    </p>
                  </div>
                  <span
                    className={
                      bot.useDomainCrawler
                        ? "status-badge status-badge-ok"
                        : "status-badge status-badge-warn"
                    }
                  >
                    {bot.useDomainCrawler ? "Feature enabled" : "Feature disabled"}
                  </span>
                </div>

                <form className="form" onSubmit={handleSaveSettings}>
                  <label className="form-field">
                    <span>Domain</span>
                    <input
                      type="text"
                      value={domain}
                      onChange={(e) => setDomain(e.target.value)}
                      placeholder="https://example.com"
                    />
                    <span className="knowledge-card-muted-note">
                      This domain is used when crawling your site and as context
                      for knowledge search.
                    </span>
                  </label>

                  <label className="form-field">
                    <span>System prompt (for knowledge usage)</span>
                    <textarea
                      value={systemPrompt}
                      onChange={(e) => setSystemPrompt(e.target.value)}
                      rows={4}
                      placeholder="Explain how the bot should use website / document knowledge in its answers..."
                    />
                  </label>

                  <div className="knowledge-card-actions">
                    <button
                      className="btn-primary"
                      type="submit"
                      disabled={saving}
                    >
                      {saving ? "Saving..." : "Save knowledge settings"}
                    </button>

                    <button
                      className="btn-secondary"
                      type="button"
                      onClick={handleCrawlDomain}
                      disabled={crawlLoading || !bot.useDomainCrawler}
                    >
                      {crawlLoading ? "Crawling..." : "Crawl domain now"}
                    </button>
                  </div>

                  {!bot.useDomainCrawler && (
                    <p className="knowledge-card-muted-note">
                      Domain crawler is disabled for this bot. Enable it in{" "}
                      <Link to={`/app/bots/${bot.id}/features`}>
                        Features &amp; Plan
                      </Link>{" "}
                      to crawl your website.
                    </p>
                  )}
                </form>
              </section>

              {/* Documents card */}
              <section className="knowledge-card">
                <div className="knowledge-card-header">
                  <div>
                    <h3 className="knowledge-card-title">
                      Documents &amp; PDFs
                    </h3>
                    <p className="knowledge-card-description">
                      Upload PDFs and other documents to enrich the bot&apos;s
                      knowledge with manuals, FAQs or product sheets.
                    </p>
                  </div>
                  <span
                    className={
                      bot.usePdfCrawler
                        ? "status-badge status-badge-ok"
                        : "status-badge status-badge-warn"
                    }
                  >
                    {bot.usePdfCrawler ? "Feature enabled" : "Feature disabled"}
                  </span>
                </div>

                {!bot.usePdfCrawler && (
                  <p className="knowledge-card-muted-note">
                    PDF ingestion is disabled for this bot. Enable it in{" "}
                    <Link to={`/app/bots/${bot.id}/features`}>
                      Features &amp; Plan
                    </Link>{" "}
                    to upload documents.
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
                    {uploadLoading && (
                      <span className="knowledge-card-muted-note">
                        Uploading and ingesting documents…
                      </span>
                    )}
                    <span className="knowledge-card-muted-note">
                      Supported formats: PDF, DOC, DOCX, TXT.
                    </span>
                  </div>
                )}
              </section>
            </div>
          </>
        )}
       {/*} 
      </section>*/}
    </div>
  );
};

export default BotKnowledgePage;
