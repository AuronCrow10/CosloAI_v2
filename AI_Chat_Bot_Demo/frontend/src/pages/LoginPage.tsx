// src/pages/LoginPage.tsx
import React, { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

declare global {
  interface Window {
    google?: any;
  }
}

const LoginPage: React.FC = () => {
  const { login, loginWithGoogle, isLoading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation() as any;

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const googleButtonRef = useRef<HTMLDivElement | null>(null);

  const from = location.state?.from || "/app/bots";

  const handleSubmit: React.FormEventHandler = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      await login(email, password);
      navigate(from, { replace: true });
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Login non riuscito");
    }
  };

  useEffect(() => {
    const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
    if (!clientId) {
      console.warn("VITE_GOOGLE_CLIENT_ID is not set; Google login disabled.");
      return;
    }
    if (!window.google || !googleButtonRef.current) {
      return;
    }

    window.google.accounts.id.initialize({
      client_id: clientId,
      callback: async (response: any) => {
        const idToken = response.credential;
        if (!idToken) return;
        try {
          setError(null);
          await loginWithGoogle(idToken);
          navigate(from, { replace: true });
        } catch (err: any) {
          console.error(err);
          setError(err.message || "Accesso con Google non riuscito");
        }
      },
    });

    window.google.accounts.id.renderButton(googleButtonRef.current, {
      theme: "outline",
      size: "large",
    });
  }, [from, loginWithGoogle, navigate]);

  return (
    <section className="auth-landing">
      <div className="lp-container">
        <div className="auth-layout">
          {/* Copy a sinistra */}
          <div className="auth-copy">
            <h1 className="auth-title">Accedi al tuo spazio Coslo</h1>
            <p className="auth-subtitle">
              Gestisci i tuoi assistenti AI, controlla le conversazioni e modifica le
              impostazioni in pochi clic.
            </p>
            <ul className="auth-bullets">
              <li>Un&apos;unica dashboard per tutti i tuoi canali</li>
              <li>Statistiche in tempo reale sulle performance del bot</li>
              <li>Accesso sicuro e protetto</li>
            </ul>
          </div>

          {/* Card con il form */}
          <div className="auth-card">
            <h2 className="auth-card-title">Login</h2>
            <form className="form auth-form" onSubmit={handleSubmit}>
              {error && <div className="form-error auth-form-error">{error}</div>}

              <label className="form-field">
                <span>Email</span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </label>

              <label className="form-field">
                <span>Password</span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </label>

              <button className="lp-btn lp-btn-primary auth-submit" type="submit" disabled={isLoading}>
                {isLoading ? "Accesso in corso..." : "Accedi"}
              </button>
            </form>

            <div className="auth-divider">
              <span>oppure</span>
            </div>

            <div className="auth-google">
              <div ref={googleButtonRef} />
            </div>

            <p className="auth-switch">
              Non hai ancora un account? <Link to="/register">Registrati</Link>
            </p>
          </div>
        </div>
      </div>
    </section>
  );
};

export default LoginPage;
