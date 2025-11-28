// src/layouts/PublicLayout.tsx
import React from "react";
import { Link, Outlet } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

const PublicLayout: React.FC = () => {
  const { user } = useAuth();

  return (
    <div className="layout-root">
      <header className="layout-header">
        <div className="layout-header-left">
          <Link to="/" className="brand">
            AI Demo Bots
          </Link>
        </div>
        <nav className="layout-nav">
          <Link to="/policy">Policy</Link>
          {user ? (
            <Link to="/app/bots">Dashboard</Link>
          ) : (
            <>
              <Link to="/login">Login</Link>
              <Link to="/register">Sign up</Link>
            </>
          )}
        </nav>
      </header>
      <main className="layout-main">
        <Outlet />
      </main>
    </div>
  );
};

export default PublicLayout;
