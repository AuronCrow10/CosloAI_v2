# CosloAI - Multi-Channel AI Assistant SaaS (Full-Stack + RAG)

This repository is a production-style, multi-service SaaS platform I built to help businesses automate customer conversations, bookings, and sales support across multiple channels.

It combines:
- a full web app for onboarding and operations
- a backend API with business logic, billing, and integrations
- a dedicated knowledge ingestion/retrieval service (RAG)
- a PostgreSQL + pgvector data layer
- a mobile operations console

## Problem This Project Solves

Small and mid-sized businesses usually have the same operational bottlenecks:

- Slow replies to customer questions across different channels.
- Knowledge scattered across websites, docs, and policies.
- Repetitive manual work (booking requests, FAQs, support triage).
- Hard-to-track conversion impact and AI usage costs.
- Difficult integration work across third-party platforms (Meta, WhatsApp, Shopify, Stripe, Google).

This project solves that by providing one platform where businesses can:
- create and configure AI assistants,
- connect channels and data sources,
- automate support and booking flows,
- and monitor usage, quality, and commercial outcomes.

## What Is In This Repository

- `AI_Chat_Bot_Demo/frontend`
  - React + Vite SaaS frontend with onboarding, dashboards, bot management, billing, and admin area.
- `AI_Chat_Bot_Demo/backend`
  - Express + TypeScript backend with auth, routing, integrations, analytics, and orchestration.
- `WebScrapper`
  - Dedicated knowledge service for crawling, document ingestion, embeddings, hybrid retrieval, and search quality controls.
- `db`
  - SQL initialization/migration scripts for Postgres/pgvector and product features over time.
- `test/my-agent-console`
  - React Native (Expo) mobile console for operational workflows.
- `docker-compose.yml`
  - Multi-service local environment (Postgres + pgvector, Redis, knowledge service, backend API).

## System Architecture

```text
[React Frontend]
      |
      v
[Express Backend API] <----> [Redis]
      |   \
      |    \----> [Stripe / Meta / WhatsApp / Shopify / Google APIs]
      |
      v
[Knowledge Service (WebScrapper)]
      |
      +--> Crawl websites (Playwright/Crawlee + sitemaps + filters)
      +--> Ingest docs (PDF/DOCX/TXT)
      +--> Chunk + embed (OpenAI)
      +--> Search (vector + keyword hybrid + quality pipeline)
      |
      v
[PostgreSQL + pgvector]
```

## Core Product Capabilities

### 1. Multi-tenant SaaS foundation
- Authentication with JWT, email verification, password reset, and MFA support.
- Role-based access (`ADMIN`, `CLIENT`, `REFERRER`, `TEAM_MEMBER`).
- Team memberships and access delegation across bots.

### 2. Bot lifecycle and channel management
- Create/manage bots with configurable system behavior.
- Channel support for web widget, WhatsApp, Facebook Messenger, Instagram.
- Real-time communication support with Socket.IO.

### 3. Knowledge ingestion and RAG retrieval
- Domain crawling with robots/sitemap support and depth/page limits.
- Document ingestion for PDF, DOCX, TXT.
- Token-aware chunking and embeddings pipeline.
- Per-client isolation and deduplication of chunks.
- Search APIs with vector/hybrid strategies and confidence scoring.

### 4. Retrieval quality engineering (not just basic vector search)
- Hybrid retrieval (vector + keyword) and result fusion.
- Adjacent chunk expansion/stitching for better context continuity.
- Dedupe and source diversification controls.
- Adaptive result sizing based on token budget.
- Confidence scoring + low-confidence handling (`noAnswerOnLowConfidence`).

### 5. Business workflows
- Booking automation with calendar integration and reminder flows.
- Revenue and upsell flows (with guardrails and rate-limited behavior).
- Shopify integrations for catalog and commerce-related assistant flows.
- Referral and commission management.

### 6. SaaS operations and observability
- Usage tracking (tokens, email usage, channel activity).
- Billing and payment history management.
- Admin dashboards for bots/users/conversations/integrations.
- Crawl job history and progress tracking for knowledge ingestion.

## Technical Depth Demonstrated

- Designed a multi-service architecture where the backend and retrieval service are decoupled but coordinated through internal APIs and auth tokens.
- Built a retrieval pipeline with explicit quality controls (confidence + adaptive context), which is closer to production RAG needs than a simple nearest-neighbor search.
- Modeled a complex SaaS domain with Prisma (users, bots, subscriptions, referrals, channel sessions, booking, Shopify, Revenue AI events).
- Implemented vector and full-text indexing patterns in Postgres/pgvector, including handling large embedding dimensions with `halfvec` index strategy.
- Added production-oriented security controls (CSP strategy by route context, cookies/auth handling, webhook raw-body processing for signature verification).

## Tech Stack

- Frontend: React, TypeScript, Vite, React Router, i18next, Recharts
- Backend: Node.js, Express, TypeScript, Prisma, Socket.IO, Zod
- Knowledge service: Express, Crawlee + Playwright, OpenAI SDK, pg, multer
- Data: PostgreSQL, pgvector, Redis
- Integrations: Stripe, Meta/WhatsApp, Shopify, Google Calendar
- Mobile: React Native + Expo
- Tooling: Docker, Docker Compose, Vitest, TypeScript

## Local Development (Quick Start)

### Prerequisites
- Docker + Docker Compose
- Node.js 20+ (for local non-container runs)

### 1) Configure environment files
Create/update:
- `WebScrapper/.env`
- `AI_Chat_Bot_Demo/backend/.env`
- (optional for standalone frontend dev) `AI_Chat_Bot_Demo/frontend/.env`

### 2) Start core services
```bash
docker compose up --build
```

Services from compose:
- Postgres + pgvector on `127.0.0.1:5433`
- Redis on `127.0.0.1:6379`
- Knowledge service (`scraper`) on internal Docker network
- Backend API exposed on `http://localhost:4000`

### 3) Access app
- Main app/API: `http://localhost:4000`
- Health check: `http://localhost:4000/health`

## Testing

- Backend tests:
```bash
cd AI_Chat_Bot_Demo/backend
npm test
```

- Knowledge service tests:
```bash
cd WebScrapper
npm test
```

The repository includes focused test suites for backend services and retrieval/quality pipeline modules.

## What This Repository Shows Recruiters

This project demonstrates my ability to:

- architect and ship full-stack, multi-service SaaS systems,
- implement production-grade AI/RAG features beyond simple prototypes,
- integrate multiple external platforms safely and pragmatically,
- design complex data models and evolve them through migrations,
- and build user-facing product flows (onboarding, analytics, admin, billing) end-to-end.

If you are reviewing this repository as part of an application, I can also provide a guided walkthrough of:
- architecture decisions,
- tradeoffs made,
- incidents/edge cases handled,
- and what I would improve next in a scaling phase.
