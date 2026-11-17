# AI retrieval and personal impact

Ask ThreadNews retrieves from D1. It applies publication and access rules before selecting evidence from article briefs, timeline milestones and official economic releases. Lexical search finds candidates and Cloudflare BGE reranks them when available. Gemini drafts cited claims, with Workers AI as a fallback. The response validator rejects unknown citation IDs and claims with unsupported or reversed numeric values. It does not check whether every claim follows from a passage.

Article questions keep the selected record first. The context can include a linked timeline and related recent reports. An archive article requires the same entitlement as the archive API and skips the shared answer cache. Headline evidence exposes the headline itself. **Browse sources** runs candidate retrieval without calling an AI model or spending the daily inference budget.

The personal impact panel fetches one shared, bounded public candidate pool. D1 interleaves recent articles by category and region. The browser then applies the reader’s optional region, life stage and priorities. Each match explains the factors that raised it. The request accepts zero preference parameters and sends no account cookie. Saving choices is optional and confined to the device.

Run the offline retrieval evaluator from `backend` with Node 24 or later.

```sh
npm run eval:retrieval
```

The evaluator applies the repository migrations to local SQLite and reports recall@5, mean reciprocal rank and policy checks for a small synthetic corpus. It exercises the production lexical retrieval path without credentials or model calls. Treat it as a regression check. Production ranking, citation support, abstention and geographic coverage need a larger labeled evaluation set.

## A recommendation model that trains on the reader's device

The homepage delivers a shared pool of up to 160 public records. A browser Worker scores the candidates using logistic regression on a 512-dimensional sparse hashed vector. The features come from headline and keyword terms, an editorial topic, and broad region. A positive or negative vote becomes a labeled example. The Worker replays up to 48 examples using bounded stochastic gradient updates. It can learn a reader's preferences before a server has a large population of historical interactions.

The homepage remains readable before any feedback. Recommendations are an optional section with topic diversity on the first screen, an explanation after feedback, and a reset. The server receives the same public article request regardless of votes. The browser can remember the examples only if the reader opts in. Recommendations use no hosted model inference.

For a larger benchmark, collect consented relevance labels separately from production telemetry. Freeze chronological train and test sets. Compare recency and topic rules, the browser learner, and a learned server reranker on NDCG@10 and topic diversity. Report cold-start performance separately. Keep the same editorial eligibility checks for every model.
