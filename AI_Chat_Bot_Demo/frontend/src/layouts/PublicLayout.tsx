// src/layouts/PublicLayout.tsx
import React from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import CookieBanner from "../components/CookieBanner";

const PublicLayout: React.FC = () => {
  const { user } = useAuth();
  const location = useLocation();

  const isLanding = location.pathname === "/" || location.pathname === "/policy" || location.pathname === "/terms";

  return (
    <div className={isLanding ? "layout-root layout-root-landing" : "layout-root"}>
      <header className={isLanding ? "layout-header layout-header-landing" : "layout-header"}>
        <div className="layout-header-left">
          <Link to="/" className={isLanding ? "brand brand-landing" : "brand"}>
            Coslo - Assistente AI
          </Link>
        </div>
        <nav className={isLanding ? "layout-nav layout-nav-landing" : "layout-nav"}>
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

      <main className={isLanding ? "layout-main layout-main-landing" : "layout-main"}>
        <Outlet />
      </main>
      <CookieBanner />
    </div>
  );
};

export default PublicLayout;
