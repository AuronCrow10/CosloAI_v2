// src/pages/VerifyEmailPage.tsx
import React, { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { verifyEmailApi } from "../api/auth";

const VerifyEmailPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">(
    "idle"
  );
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const token = searchParams.get("token");
    if (!token) {
      setStatus("error");
      setMessage("Token di verifica mancante.");
      return;
    }

    setStatus("loading");
    verifyEmailApi(token)
      .then((res) => {
        setStatus(res.success ? "success" : "error");
        setMessage(
          res.message ||
            (res.success
              ? "Email verificata con successo!"
              : "Token non valido o scaduto.")
        );
      })
      .catch((err: any) => {
        console.error(err);
        setStatus("error");
        setMessage(err.message || "Verifica fallita.");
      });
  }, [searchParams]);

  return (
    <section className="auth-landing">
      <div className="lp-container">
        <div className="auth-center">
          <div className="auth-card auth-card-verify">
            <h1 className="auth-card-title">Verifica email</h1>
            {status === "loading" && (
              <p className="auth-subtitle">Stiamo verificando la tua email...</p>
            )}
            {status !== "loading" && message && (
              <p className="auth-subtitle">{message}</p>
            )}
            {(status === "success" || status === "error") && (
              <p className="auth-switch" style={{ marginTop: "1.25rem" }}>
                Ora puoi tornare al{" "}
                <Link to="/login">
                  login
                </Link>.
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
};

export default VerifyEmailPage;
