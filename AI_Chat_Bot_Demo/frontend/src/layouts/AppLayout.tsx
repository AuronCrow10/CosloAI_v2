// src/layouts/AppLayout.tsx
import React from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

const AppLayout: React.FC = () => {
  const { user, logout } = useAuth();
  const location = useLocation();

  const isActive = (path: string): boolean => {
    return location.pathname.startsWith(path);
  };

  const handleLogout = async () => {
    await logout();
  };

  return (
    <div className="app-layout-root">
      <aside className="app-sidebar">
        <div className="app-sidebar-header">
          <h2>Dashboard</h2>
        </div>
<nav className="app-sidebar-nav">
  <Link
    to="/app/bots"
    className={isActive("/app/bots") ? "active" : undefined}
  >
    Bots
  </Link>
  <Link
    to="/app/billing"
    className={isActive("/app/billing") ? "active" : undefined}
  >
    Billing
  </Link>
</nav>
      </aside>
      <div className="app-main">
        <header className="app-main-header">
          <div className="app-main-header-left">
            <span className="brand-small">Coslo - Assistente AI</span>
          </div>
          <div className="app-main-header-right">
            {user && (
              <>
                <span className="user-pill">{user.email}</span>
                <button className="btn-link" onClick={handleLogout}>
                  Logout
                </button>
              </>
            )}
          </div>
        </header>
        <main className="app-main-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
};

export default AppLayout;
