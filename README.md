# HowTheyBuild

A citation-first Q&A tool for software engineers. Ask a system-design question, get a synthesized answer grounded in real engineering blog posts, postmortems, and systems papers. Every claim links back to the original source.

**Use cases:**
- Real production work — find how companies actually solve hard problems, with sources you can take to your team
- System-design interview prep — real production stories, not made-up patterns

## Architecture

A focused production-grade RAG system, built incrementally.

| Layer | Stack |
|---|---|
| Frontend + API | Next.js 14 (App Router) on Vercel |
| Database | Postgres + `pgvector` (Supabase) |
| Cache | Upstash Redis |
| Edge / rate-limiting | Cloudflare |
| Embeddings | OpenAI `text-embedding-3-small` |
| Reranker | Cohere Rerank v3 |
| Generation | Anthropic Claude |
| Ingestion | Daily cron over RSS feeds + curated source list |

Single-tenant, anonymous access, IP-based rate limiting. Citation validation, refusal-on-low-confidence, prompt caching. Designed for V1 simplicity with clean migration paths to scale.

## Status

In development. V1 launch target: 6 weeks.

## License

TBD.
