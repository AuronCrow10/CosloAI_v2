-- Crea i database applicativi
CREATE DATABASE chatbot;
CREATE DATABASE embeddings_db;

-- Abilita le estensioni necessarie nei due DB
\connect chatbot;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

\connect embeddings_db;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
