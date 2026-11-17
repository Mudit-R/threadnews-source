# AI retrieval and personal impact

Ask ThreadNews retrieves from D1. It applies publication and access rules before selecting evidence from article briefs, timeline milestones and official economic releases. Lexical search finds candidates and Cloudflare BGE reranks them when available. Gemini drafts cited claims, with Workers AI as a fallback. The response validator rejects unknown citation IDs and claims with unsupported or reversed numeric values. It does not check whether every claim follows from a passage.

Article questions keep the selected record first. The context can include a linked timeline and related recent reports. An archive article requires the same entitlement as the archive API and skips the shared answer cache. Headline evidence exposes the headline itself. **Browse sources** runs candidate retrieval without calling an AI model or spending the daily inference budget.

The personal impact panel fetches one shared, bounded public candidate pool. D1 interleaves recent articles by category and region. The browser then applies the reader’s optional region, life stage and priorities. Each match explains the factors that raised it. The request accepts zero preference parameters and sends no account cookie. Saving choices is optional and confined to the device.

Run the offline retrieval evaluator from `backend` with Node 24 or later.

```sh
npm run eval:retrieval
```

The evaluator applies the repository migrations to local SQLite and reports recall@5, mean reciprocal rank and policy checks for a small synthetic corpus. It exercises the production lexical retrieval path without credentials or model calls. Treat it as a regression check. Production ranking, citation support, abstention and geographic coverage need a larger labeled evaluation set.
