-- HowTheyBuild — initial schema
-- Tables: sources, documents, chunks, queries, rate_limits, removal_requests
-- Extensions: pgvector (HNSW index), built-in tsvector + GIN

CREATE EXTENSION IF NOT EXISTS vector;

-- Top-level catalogs (a blog, a paper archive, an org, a book)
CREATE TABLE IF NOT EXISTS sources (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  base_url        TEXT NOT NULL,
  source_type     TEXT NOT NULL CHECK (source_type IN ('blog', 'paper', 'postmortem', 'book')),
  rss_url         TEXT,
  license_tag     TEXT,
  contact_email   TEXT,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'removed')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at  TIMESTAMPTZ
);

-- Individual posts/papers/chapters
CREATE TABLE IF NOT EXISTS documents (
  id                   BIGSERIAL PRIMARY KEY,
  source_id            INTEGER REFERENCES sources(id),
  url                  TEXT NOT NULL UNIQUE,
  title                TEXT NOT NULL,
  author               TEXT,
  source_published_at  TIMESTAMPTZ,
  content_hash         TEXT NOT NULL,
  raw_text             TEXT,
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed', 'flagged')),
  scraped_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source_id);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);

-- Retrievable units
CREATE TABLE IF NOT EXISTS chunks (
  id                   BIGSERIAL PRIMARY KEY,
  document_id          BIGINT REFERENCES documents(id) ON DELETE CASCADE,
  chunk_position       INTEGER NOT NULL,
  parent_chunk_id      BIGINT REFERENCES chunks(id),
  breadcrumb           TEXT NOT NULL,
  text                 TEXT NOT NULL,
  parent_text          TEXT,
  token_count          INTEGER NOT NULL,
  embedding            VECTOR(1536),
  embedding_model_id   TEXT NOT NULL DEFAULT 'openai:text-embedding-3-small:v1',
  text_fts             tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, chunk_position)
);
CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_chunks_fts       ON chunks USING gin  (text_fts);
CREATE INDEX IF NOT EXISTS idx_chunks_doc       ON chunks(document_id);

-- Per-request audit log; powers analytics + eval + abuse detection
CREATE TABLE IF NOT EXISTS queries (
  id                       BIGSERIAL PRIMARY KEY,
  client_ip_hash           TEXT NOT NULL,
  query_text               TEXT NOT NULL,
  rewritten_query          TEXT,
  retrieved_chunk_ids      BIGINT[],
  reranked_chunk_ids       BIGINT[],
  top_rerank_score         REAL,
  refused                  BOOLEAN NOT NULL DEFAULT false,
  refusal_reason           TEXT,
  llm_model                TEXT NOT NULL,
  llm_input_tokens         INTEGER,
  llm_input_tokens_cached  INTEGER,
  llm_output_tokens        INTEGER,
  total_cost_usd           NUMERIC(10, 6),
  total_latency_ms         INTEGER,
  ttft_ms                  INTEGER,
  thumbs_up                BOOLEAN,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_queries_ip      ON queries(client_ip_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_queries_created ON queries(created_at DESC);

-- Daily rate-limit counters
CREATE TABLE IF NOT EXISTS rate_limits (
  client_ip_hash   TEXT NOT NULL,
  date             DATE NOT NULL,
  query_count      INTEGER NOT NULL DEFAULT 0,
  total_cost_usd   NUMERIC(10, 6) NOT NULL DEFAULT 0,
  PRIMARY KEY (client_ip_hash, date)
);

-- Source removal requests (legal / ethical posture)
CREATE TABLE IF NOT EXISTS removal_requests (
  id              SERIAL PRIMARY KEY,
  url             TEXT NOT NULL,
  contact_email   TEXT,
  reason          TEXT,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'rejected')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);
