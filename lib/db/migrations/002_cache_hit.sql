-- Phase 8: track whether the served answer came from the answer cache.
ALTER TABLE queries
  ADD COLUMN IF NOT EXISTS cache_hit BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_queries_cache_hit ON queries(cache_hit, created_at DESC);
