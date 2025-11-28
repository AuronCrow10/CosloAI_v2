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
      setMessage("Missing verification token.");
      return;
    }

    setStatus("loading");
    verifyEmailApi(token)
      .then((res) => {
        setStatus(res.success ? "success" : "error");
        setMessage(res.message || (res.success ? "Email verified!" : "Invalid token."));
      })
      .catch((err: any) => {
        console.error(err);
        setStatus("error");
        setMessage(err.message || "Verification failed.");
      });
  }, [searchParams]);

  return (
    <div className="page-container">
      <h1>Email verification</h1>
      {status === "loading" && <p>Verifying your email...</p>}
      {status !== "loading" && message && <p>{message}</p>}
      {(status === "success" || status === "error") && (
        <p>
          You can now go to <Link to="/login">Login</Link>.
        </p>
      )}
    </div>
  );
};

export default VerifyEmailPage;
