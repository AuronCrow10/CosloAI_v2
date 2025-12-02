// src/pages/RegisterPage.tsx
import React, { useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

function validatePassword(password: string): string[] {
  const errors: string[] = [];

  if (password.length < 8) {
    errors.push("Almeno 8 caratteri");
  }
  if (!/[A-Z]/.test(password)) {
    errors.push("Almeno una lettera maiuscola (A-Z)");
  }
  if (!/[a-z]/.test(password)) {
    errors.push("Almeno una lettera minuscola (a-z)");
  }
  if (!/[0-9]/.test(password)) {
    errors.push("Almeno una cifra (0-9)");
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    errors.push("Almeno un carattere speciale (es. !@#$%^&*)");
  }

  return errors;
}

const RegisterPage: React.FC = () => {
  const { register, isLoading } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const passwordErrors = validatePassword(password);
  const passwordsMatch = password === confirmPassword || confirmPassword === "";

  const handleSubmit: React.FormEventHandler = async (e) => {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    if (password !== confirmPassword) {
      setError("Le password non coincidono");
      return;
    }

    if (passwordErrors.length > 0) {
      setError(
        "La password non soddisfa i requisiti. Controlla i punti sotto il campo password."
      );
      return;
    }

    try {
      await register(email, password);
      setSuccess(true);
      setPassword("");
      setConfirmPassword("");
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Registrazione fallita");
    }
  };

  return (
    <section className="auth-landing">
      <div className="lp-container">
        <div className="auth-layout">
          {/* Copy a sinistra */}
          <div className="auth-copy">
            <h1 className="auth-title">Crea il tuo account Coslo</h1>
            <p className="auth-subtitle">
              In pochi minuti colleghi i tuoi canali e hai un assistente AI pronto a
              rispondere ai tuoi clienti 24/7.
            </p>
            <ul className="auth-bullets">
              <li>Multi-canale (web, WhatsApp, social, calendario)</li>
              <li>Configurazione guidata e personalizzabile</li>
              <li>Piano multi-tenant pensato per agenzie e team</li>
            </ul>
          </div>

          {/* Card con il form */}
          <div className="auth-card">
            <h2 className="auth-card-title">Registrazione</h2>

            <form className="form auth-form" onSubmit={handleSubmit}>
              {error && <div className="form-error auth-form-error">{error}</div>}
              {success && (
                <div className="form-success auth-form-success">
                  Registrazione completata! Controlla la tua email e verifica
                  l&apos;account prima di effettuare il login.
                </div>
              )}

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

              {/* Checklist requisiti password */}
              <div className="password-requirements">
                <p className="pw-title">Requisiti password:</p>
                <ul>
                  <li
                    className={
                      password.length >= 8 ? "pw-rule pw-rule-ok" : "pw-rule pw-rule-bad"
                    }
                  >
                    Almeno 8 caratteri
                  </li>
                  <li
                    className={
                      /[A-Z]/.test(password)
                        ? "pw-rule pw-rule-ok"
                        : "pw-rule pw-rule-bad"
                    }
                  >
                    Almeno una lettera maiuscola (A-Z)
                  </li>
                  <li
                    className={
                      /[a-z]/.test(password)
                        ? "pw-rule pw-rule-ok"
                        : "pw-rule pw-rule-bad"
                    }
                  >
                    Almeno una lettera minuscola (a-z)
                  </li>
                  <li
                    className={
                      /[0-9]/.test(password)
                        ? "pw-rule pw-rule-ok"
                        : "pw-rule pw-rule-bad"
                    }
                  >
                    Almeno una cifra (0-9)
                  </li>
                  <li
                    className={
                      /[^A-Za-z0-9]/.test(password)
                        ? "pw-rule pw-rule-ok"
                        : "pw-rule pw-rule-bad"
                    }
                  >
                    Almeno un carattere speciale (es. !@#$%^&*)
                  </li>
                </ul>
              </div>

              <label className="form-field">
                <span>Conferma password</span>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                />
              </label>
              {!passwordsMatch && (
                <div className="field-error">Le password non coincidono</div>
              )}

              <button
                className="lp-btn lp-btn-primary auth-submit"
                type="submit"
                disabled={isLoading}
              >
                {isLoading ? "Creazione in corso..." : "Crea account"}
              </button>
            </form>

            <p className="auth-switch">
              Hai già un account? <Link to="/login">Accedi</Link>
            </p>
          </div>
        </div>
      </div>
    </section>
  );
};

export default RegisterPage;
