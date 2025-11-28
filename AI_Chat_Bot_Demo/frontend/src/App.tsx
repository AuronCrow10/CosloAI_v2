// src/App.tsx
import React from "react";
import { Routes, Route } from "react-router-dom";

import DemoBotPage from "./pages/DemoBotPage";
import LandingPage from "./pages/LandingPage";
import PolicyPage from "./pages/PolicyPage";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import VerifyEmailPage from "./pages/VerifyEmailPage";

import PublicLayout from "./layouts/PublicLayout";
import AppLayout from "./layouts/AppLayout";
import RequireAuth from "./components/RequireAuth";

import BotsListPage from "./pages/app/BotsListPage";
import BotCreatePage from "./pages/app/BotCreatePage";
import BotDetailPage from "./pages/app/BotDetailPage";
import BotChannelsPage from "./pages/app/BotChannelsPage";
import BotConversationsPage from "./pages/app/BotConversationsPage";
import ConversationDetailPage from "./pages/app/ConversationDetailsPage";
import BotKnowledgePage from "./pages/app/BotKnowledgePage";
import BotFeaturesPage from "./pages/app/BotFeaturesPage";


import WidgetBotPage from "./pages/WidgetBotPage"; // in alto

const App: React.FC = () => {
  return (
    <div className="app-root">
      <Routes>
        {/* Public layout */}
        <Route element={<PublicLayout />}>
          <Route path="/" element={<LandingPage />} />
          <Route path="/policy" element={<PolicyPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/verify-email" element={<VerifyEmailPage />} />
          {/* Demo route must remain exactly the same */}
          <Route path="/demo/:slug" element={<DemoBotPage />} />
        </Route>

         <Route path="/widget/:slug" element={<WidgetBotPage />} />

        {/* Authenticated app layout */}
        <Route
          path="/app"
          element={
            <RequireAuth>
              <AppLayout />
            </RequireAuth>
          }
        >
          <Route path="bots" element={<BotsListPage />} />
          <Route path="bots/new" element={<BotCreatePage />} />
          <Route path="bots/:id" element={<BotDetailPage />} />
          <Route path="bots/:id/channels" element={<BotChannelsPage />} />
          <Route path="bots/:id/conversations" element={<BotConversationsPage />} />
          <Route path="bots/:id/knowledge" element={<BotKnowledgePage />} />
          <Route path="bots/:id/features" element={<BotFeaturesPage />} />
        </Route>

        {/* Conversations top-level route for details */}
        <Route
          path="/app/conversations/:id"
          element={
            <RequireAuth>
              <AppLayout />
            </RequireAuth>
          }
        >
          <Route index element={<ConversationDetailPage />} />
        </Route>

        {/* Fallback */}
        <Route path="*" element={<NotFound />} />
      </Routes>
    </div>
  );
};

const NotFound: React.FC = () => (
  <div className="page-container">
    <h2>Page not found</h2>
    <p>Check the URL or go back to the <a href="/">home page</a>.</p>
  </div>
);

export default App;
