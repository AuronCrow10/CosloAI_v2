// src/pages/app/BotChannelsPage.tsx
import React, { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  BotChannel,
  ChannelType,
  fetchChannels,
  createChannel,
  updateChannel,
  deleteChannel,
  getMetaConnectUrl,
  getMetaSession,
  attachMetaSession,
  MetaSessionResponse,
  completeWhatsappEmbeddedSignup,
  attachWhatsappSession,
  WhatsappConnectSessionResponse
} from "../../api/bots";
import { loadFacebookSdk } from "../../utils/facebookSdk";

const channelTypes: ChannelType[] = ["WEB", "WHATSAPP", "FACEBOOK", "INSTAGRAM"];

function isMetaChannelType(type: ChannelType) {
  return type === "FACEBOOK" || type === "INSTAGRAM";
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const BotChannelsPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();

  const [channels, setChannels] = useState<BotChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState<{
    type: ChannelType;
    externalId: string;
    accessToken: string;
    meta: string;
  }>({
    type: "WEB",
    externalId: "",
    accessToken: "",
    meta: ""
  });

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{
    externalId: string;
    accessToken: string;
    meta: string;
  }>({
    externalId: "",
    accessToken: "",
    meta: ""
  });

  // Meta connect session state (page selection)
  const [metaSession, setMetaSession] = useState<MetaSessionResponse | null>(
    null
  );
  const [metaSessionLoading, setMetaSessionLoading] = useState(false);
  const [metaSessionError, setMetaSessionError] = useState<string | null>(null);
  const [metaSelectedPageId, setMetaSelectedPageId] = useState<string>("");
  const [metaAttachLoading, setMetaAttachLoading] = useState(false);

  // WhatsApp embedded signup session state
  const [waSession, setWaSession] =
    useState<WhatsappConnectSessionResponse | null>(null);
  const [waSelectedNumberId, setWaSelectedNumberId] = useState<string>("");
  const [waConnecting, setWaConnecting] = useState(false);
  const [waAttachLoading, setWaAttachLoading] = useState(false);

  const loadChannels = () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    fetchChannels(id)
      .then((data) => setChannels(data))
      .catch((err: any) => {
        console.error(err);
        setError(err.message || "Failed to load channels");
      })
      .finally(() => setLoading(false));
  };

  const loadMetaSessionFromQuery = () => {
    const params = new URLSearchParams(location.search);
    const sessionId = params.get("metaSessionId");
    if (!sessionId) {
      setMetaSession(null);
      setMetaSessionError(null);
      setMetaSelectedPageId("");
      return;
    }

    setMetaSessionLoading(true);
    setMetaSessionError(null);
    getMetaSession(sessionId)
      .then((session) => {
        setMetaSession(session);
        setMetaSelectedPageId("");
      })
      .catch((err: any) => {
        console.error(err);
        setMetaSessionError(err.message || "Failed to load Meta session");
        setMetaSession(null);
      })
      .finally(() => setMetaSessionLoading(false));
  };

  useEffect(() => {
    loadChannels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    loadMetaSessionFromQuery();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  if (!id) {
    return (
      <div className="page-container">
        <p>Missing bot ID.</p>
      </div>
    );
  }

  const handleCreateChange =
    (field: keyof typeof createForm) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      setCreateForm({
        ...createForm,
        [field]: e.target.value
      });
    };

  const handleEditChange =
    (field: keyof typeof editForm) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setEditForm({
        ...editForm,
        [field]: e.target.value
      });
    };

  const handleCreateSubmit: React.FormEventHandler = async (e) => {
    e.preventDefault();
    if (!id) return;
    setError(null);
    try {
      const metaTypeSelected = isMetaChannelType(createForm.type);

      if (metaTypeSelected) {
        throw new Error(
          "Facebook/Instagram channels must be connected via the Meta connect buttons above."
        );
      }

      let meta: any = undefined;
      if (createForm.meta.trim()) {
        meta = JSON.parse(createForm.meta);
      }
      await createChannel(id, {
        type: createForm.type,
        externalId: createForm.externalId,
        accessToken: createForm.accessToken,
        meta
      });
      setCreateForm({
        type: "WEB",
        externalId: "",
        accessToken: "",
        meta: ""
      });
      setCreating(false);
      loadChannels();
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Failed to create channel");
    }
  };

  const startEdit = (ch: BotChannel) => {
    if (isMetaChannelType(ch.type)) {
      setError(
        "Facebook and Instagram channels are managed via Meta. To update them, disconnect and reconnect using the buttons above."
      );
      return;
    }

    setEditingId(ch.id);
    setEditForm({
      externalId: ch.externalId,
      accessToken: ch.accessToken,
      meta: ch.meta ? JSON.stringify(ch.meta, null, 2) : ""
    });
  };

  const handleEditSubmit: React.FormEventHandler = async (e) => {
    e.preventDefault();
    if (!id || !editingId) return;
    setError(null);
    try {
      let meta: any = undefined;
      if (editForm.meta.trim()) {
        meta = JSON.parse(editForm.meta);
      }
      await updateChannel(id, editingId, {
        externalId: editForm.externalId,
        accessToken: editForm.accessToken,
        meta
      });
      setEditingId(null);
      loadChannels();
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Failed to update channel");
    }
  };

  const handleDelete = async (channelId: string) => {
    if (!id) return;
    if (!window.confirm("Delete this channel?")) return;
    setError(null);
    try {
      await deleteChannel(id, channelId);
      loadChannels();
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Failed to delete channel");
    }
  };

  const metaTypeSelectedInCreate = isMetaChannelType(createForm.type);

  const clearMetaSessionFromUrl = () => {
    const params = new URLSearchParams(location.search);
    if (params.has("metaSessionId")) {
      params.delete("metaSessionId");
      navigate(
        {
          pathname: location.pathname,
          search: params.toString()
        },
        { replace: true }
      );
    }
  };

  const handleAttachMetaSession = async () => {
    if (!metaSession || !metaSelectedPageId) return;
    setMetaAttachLoading(true);
    setError(null);
    try {
      await attachMetaSession(metaSession.id, metaSelectedPageId);
      setMetaSession(null);
      setMetaSelectedPageId("");
      clearMetaSessionFromUrl();
      loadChannels();
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Failed to attach Meta page");
    } finally {
      setMetaAttachLoading(false);
    }
  };

  const handleConnectWhatsApp = async () => {
    if (!id) return;
    setError(null);
    setWaConnecting(true);

    const appId =
      (import.meta as any).env.VITE_META_APP_ID ||
      (import.meta as any).env.VITE_FACEBOOK_APP_ID;
    const configId = (import.meta as any).env
      .VITE_WHATSAPP_EMBEDDED_CONFIG_ID;

    if (!appId || !configId) {
      setError(
        "WhatsApp signup is not configured. Please set VITE_META_APP_ID and VITE_WHATSAPP_EMBEDDED_CONFIG_ID."
      );
      setWaConnecting(false);
      return;
    }

    try {
      const FB = await loadFacebookSdk(appId);

      FB.login(
        async (response: any) => {
          if (
            !response ||
            !response.authResponse ||
            !response.authResponse.code
          ) {
            setError("WhatsApp signup was cancelled or did not complete.");
            setWaConnecting(false);
            return;
          }

          const code = response.authResponse.code as string;

          try {
            const session = await completeWhatsappEmbeddedSignup(id, { code });
            setWaSession(session);
            setWaSelectedNumberId("");
          } catch (err: any) {
            console.error(err);
            setError(
              err?.message || "Failed to complete WhatsApp embedded signup"
            );
          } finally {
            setWaConnecting(false);
          }
        },
        {
          config_id: configId,
          response_type: "code",
          override_default_response_type: true
        }
      );
    } catch (err: any) {
      console.error(err);
      setError(err?.message || "Failed to initialize WhatsApp signup");
      setWaConnecting(false);
    }
  };

  const handleAttachWhatsappSession = async () => {
    if (!waSession || !waSelectedNumberId) return;
    setWaAttachLoading(true);
    setError(null);
    try {
      await attachWhatsappSession(waSession.sessionId, waSelectedNumberId);
      setWaSession(null);
      setWaSelectedNumberId("");
      loadChannels();
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Failed to attach WhatsApp number");
    } finally {
      setWaAttachLoading(false);
    }
  };

  const renderChannelDetails = (ch: BotChannel) => {
    if (isMetaChannelType(ch.type)) {
      const pageName = ch.meta?.pageName as string | undefined;
      const label =
        ch.type === "FACEBOOK"
          ? "Facebook Page"
          : "Instagram Business Profile";

      if (pageName) {
        return (
          <>
            <strong>{label}</strong>
            <div className="muted">{pageName}</div>
          </>
        );
      }
      return (
        <>
          <strong>{label}</strong>
          <div className="muted">Connected via Meta</div>
        </>
      );
    }

    if (ch.type === "WHATSAPP") {
      const displayPhoneNumber =
        (ch.meta?.displayPhoneNumber as string | undefined) ||
        (ch.meta?.display_phone_number as string | undefined);
      const verifiedName =
        (ch.meta?.verifiedName as string | undefined) ||
        (ch.meta?.verified_name as string | undefined);

      return (
        <>
          <strong>WhatsApp</strong>
          <div className="muted">
            {displayPhoneNumber
              ? `Number: ${displayPhoneNumber}`
              : `Number ID: ${ch.externalId}`}
            {verifiedName ? ` – ${verifiedName}` : ""}
          </div>
        </>
      );
    }

    if (ch.type === "WEB") {
      return (
        <>
          <strong>Web widget</strong>
          <div className="muted">
            External ID: {ch.externalId || "Default website widget"}
          </div>
        </>
      );
    }

    return (
      <>
        <strong>{ch.type}</strong>
        <div className="muted">External ID: {ch.externalId}</div>
      </>
    );
  };

  const renderChannelStatusBadge = (ch: BotChannel) => {
    const meta = (ch.meta as any) || {};

    if (!isMetaChannelType(ch.type)) {
      const needsReconnect = meta.needsReconnect === true;
      if (needsReconnect) {
        return (
          <span className="status-badge status-badge-error">
            Needs reconnect
          </span>
        );
      }
      return <span className="status-badge status-badge-ok">Active</span>;
    }

    const now = Date.now();
    const needsReconnect = meta.needsReconnect === true;
    const tokenExpiresAtStr: string | undefined = meta.tokenExpiresAt;
    let expiresAt: Date | null = null;

    if (tokenExpiresAtStr) {
      const d = new Date(tokenExpiresAtStr);
      if (!isNaN(d.getTime())) {
        expiresAt = d;
      }
    }

    let label = "Connected";
    let className = "status-badge status-badge-ok";

    if (needsReconnect) {
      label = "Needs reconnect";
      className = "status-badge status-badge-error";
    } else if (!expiresAt) {
      label = "Connected (expiry unknown)";
      className = "status-badge status-badge-ok";
    } else {
      const diff = expiresAt.getTime() - now;

      if (diff <= 0) {
        label = "Expired";
        className = "status-badge status-badge-error";
      } else if (diff <= SEVEN_DAYS_MS) {
        label = "Expiring soon";
        className = "status-badge status-badge-warn";
      } else {
        label = "Connected";
        className = "status-badge status-badge-ok";
      }
    }

    return <span className={className}>{label}</span>;
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Channels</h1>
          <p className="muted">
            Connect your bot to web, WhatsApp, Facebook Pages and Instagram
            Business profiles.
          </p>
        </div>
        <Link to={`/app/bots/${id}`} className="btn-secondary">
          ← Back to bot
        </Link>
      </div>

      {error && <div className="form-error">{error}</div>}

      {/* Meta session selection UI */}
      {metaSessionLoading && <p>Loading Meta pages...</p>}
      {metaSessionError && (
        <div className="form-error">
          Failed to load Meta session: {metaSessionError}
        </div>
      )}
      {metaSession && (
        <div className="card" style={{ marginBottom: "1.5rem" }}>
          <h2>
            Select{" "}
            {metaSession.channelType === "FACEBOOK"
              ? "Facebook Page"
              : "Instagram Business Profile"}
          </h2>
          <p className="muted">
            We retrieved the pages you manage from Meta. Choose which one to
            link to this bot.
          </p>
          <label className="form-field">
            <span>
              {metaSession.channelType === "FACEBOOK"
                ? "Facebook Page"
                : "Page with Instagram Business account"}
            </span>
            <select
              value={metaSelectedPageId}
              onChange={(e) => setMetaSelectedPageId(e.target.value)}
            >
              <option value="">Select a page...</option>
              {metaSession.pages
                .filter((p) =>
                  metaSession.channelType === "INSTAGRAM"
                    ? !!p.instagramBusinessId
                    : true
                )
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </label>
          {metaSession.channelType === "INSTAGRAM" && (
            <p className="muted">
              Only pages with an attached Instagram Business account can be used
              for Instagram.
            </p>
          )}
          <div className="form-actions-inline">
            <button
              className="btn-primary"
              type="button"
              disabled={!metaSelectedPageId || metaAttachLoading}
              onClick={handleAttachMetaSession}
            >
              {metaAttachLoading ? "Connecting..." : "Connect selected"}
            </button>
            <button
              className="btn-secondary"
              type="button"
              onClick={() => {
                setMetaSession(null);
                setMetaSelectedPageId("");
                clearMetaSessionFromUrl();
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* WhatsApp session selection UI */}
      {waSession && (
        <div className="card" style={{ marginBottom: "1.5rem" }}>
          <h2>Select WhatsApp number</h2>
          <p className="muted">
            We retrieved the WhatsApp numbers in your WhatsApp Business account.
            Choose which one to link to this bot.
          </p>
          <label className="form-field">
            <span>WhatsApp number</span>
            <select
              value={waSelectedNumberId}
              onChange={(e) => setWaSelectedNumberId(e.target.value)}
            >
              <option value="">Select a number...</option>
              {waSession.numbers.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.displayPhoneNumber || n.id}
                  {n.verifiedName ? ` – ${n.verifiedName}` : ""}
                </option>
              ))}
            </select>
          </label>
          <div className="form-actions-inline">
            <button
              className="btn-primary"
              type="button"
              disabled={!waSelectedNumberId || waAttachLoading}
              onClick={handleAttachWhatsappSession}
            >
              {waAttachLoading ? "Connecting..." : "Connect selected"}
            </button>
            <button
              className="btn-secondary"
              type="button"
              onClick={() => {
                setWaSession(null);
                setWaSelectedNumberId("");
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Meta + WhatsApp connect buttons */}
      {!loading && (
        <div style={{ marginBottom: "1.5rem" }}>
          <h2>Connect social channels</h2>
          <p className="muted">
            Use Meta login to connect your Facebook Page, Instagram Business
            account or WhatsApp Business number. We&apos;ll store the necessary
            tokens securely and keep your bot responding.
          </p>
          <div className="form-actions-inline">
            <button
              type="button"
              className="btn-primary"
              onClick={async () => {
                try {
                  const { url } = await getMetaConnectUrl(id, "FACEBOOK");
                  window.location.href = url;
                } catch (err: any) {
                  console.error(err);
                  setError(
                    err.message || "Failed to start Facebook connection"
                  );
                }
              }}
            >
              Connect Facebook Page
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={async () => {
                try {
                  const { url } = await getMetaConnectUrl(id, "INSTAGRAM");
                  window.location.href = url;
                } catch (err: any) {
                  console.error(err);
                  setError(
                    err.message || "Failed to start Instagram connection"
                  );
                }
              }}
            >
              Connect Instagram Business
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={handleConnectWhatsApp}
              disabled={waConnecting}
            >
              {waConnecting ? "Connecting WhatsApp..." : "Connect WhatsApp"}
            </button>
          </div>
        </div>
      )}

      {/* Existing channels list */}
      {loading && <p>Loading channels...</p>}
      {!loading && channels.length === 0 && <p>No channels configured yet.</p>}
      {!loading && channels.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Details</th>
              <th>Status</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {channels.map((ch) => (
              <tr key={ch.id}>
                <td>{ch.type}</td>
                <td>{renderChannelDetails(ch)}</td>
                <td>{renderChannelStatusBadge(ch)}</td>
                <td>{new Date(ch.createdAt).toLocaleString()}</td>
                <td>
                  {!isMetaChannelType(ch.type) && (
                    <button
                      className="btn-link"
                      type="button"
                      onClick={() => startEdit(ch)}
                    >
                      Edit
                    </button>
                  )}
                  <button
                    className="btn-link danger"
                    type="button"
                    onClick={() => handleDelete(ch.id)}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <hr className="section-separator" />

      {/* Manual channel creation (non-Meta) */}
      {!creating && !editingId && (
        <button
          className="btn-primary"
          type="button"
          onClick={() => setCreating(true)}
        >
          Add channel
        </button>
      )}

      {creating && (
        <form className="form" onSubmit={handleCreateSubmit}>
          <h2>New channel</h2>
          <label className="form-field">
            <span>Type</span>
            <select
              value={createForm.type}
              onChange={handleCreateChange("type")}
            >
              {channelTypes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="form-field">
            <span>External ID</span>
            <input
              type="text"
              value={createForm.externalId}
              onChange={handleCreateChange("externalId")}
              required={!metaTypeSelectedInCreate}
              disabled={metaTypeSelectedInCreate}
              placeholder={
                metaTypeSelectedInCreate
                  ? "Filled automatically after Meta connect"
                  : ""
              }
            />
          </label>
          <label className="form-field">
            <span>Access token</span>
            <input
              type="text"
              value={createForm.accessToken}
              onChange={handleCreateChange("accessToken")}
              required={!metaTypeSelectedInCreate}
              disabled={metaTypeSelectedInCreate}
              placeholder={
                metaTypeSelectedInCreate
                  ? "Filled automatically after Meta connect"
                  : ""
              }
            />
          </label>
          <label className="form-field">
            <span>Meta (JSON, optional)</span>
            <input
              type="text"
              value={createForm.meta}
              onChange={handleCreateChange("meta")}
              placeholder='e.g. {"label": "Main number"}'
            />
          </label>
          {metaTypeSelectedInCreate && (
            <p className="muted">
              Facebook and Instagram channels are configured via the Meta
              connect buttons above. You don&apos;t need to fill External ID or
              Access token manually.
            </p>
          )}
          <div className="form-actions-inline">
            <button className="btn-primary" type="submit">
              Save
            </button>
            <button
              className="btn-secondary"
              type="button"
              onClick={() => setCreating(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {editingId && (
        <form className="form" onSubmit={handleEditSubmit}>
          <h2>Edit channel</h2>
          <label className="form-field">
            <span>External ID</span>
            <input
              type="text"
              value={editForm.externalId}
              onChange={handleEditChange("externalId")}
              required
            />
          </label>
          <label className="form-field">
            <span>Access token</span>
            <input
              type="text"
              value={editForm.accessToken}
              onChange={handleEditChange("accessToken")}
              required
            />
          </label>
          <label className="form-field">
            <span>Meta (JSON, optional)</span>
            <textarea
              value={editForm.meta}
              onChange={handleEditChange("meta")}
              rows={3}
            />
          </label>
          <div className="form-actions-inline">
            <button className="btn-primary" type="submit">
              Save
            </button>
            <button
              className="btn-secondary"
              type="button"
              onClick={() => setEditingId(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
};

export default BotChannelsPage;
