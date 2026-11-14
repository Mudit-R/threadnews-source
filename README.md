# ThreadNews

[Live site](https://threadnews.online) · [Ask ThreadNews](https://threadnews.online/ask) · [Timelines](https://threadnews.online/threads) · [G20 economy](https://threadnews.online/economy)

ThreadNews turns a live news feed into a source-linked research tool. It collects current reporting, follows selected events across years, and charts official G20 economic series. Ask ThreadNews connects those records so readers can check the evidence behind an answer.

~~~mermaid
flowchart LR
  Feeds[RSS and official releases] --> Worker[Cloudflare Worker]
  Worker --> D1[(Cloudflare D1)]
  Reader --> Worker
  D1 --> Retrieval[Rank public evidence]
  Retrieval --> Model[Gemini or Workers AI]
  Model --> Claims[Validate citation IDs]
  Claims --> Reader
~~~

## Architecture

- **News ingestion.** Scheduled jobs collect metadata from publishers and public agencies. Stable identities, content hashes and source lineage preserve stronger evidence during refreshes.
- **Timelines.** Reviewed milestones distinguish event dates from publication dates. Public evidence retrieval shares the timeline preview rules.
- **Economic data.** Annual GDP and CPI, monthly CPI and quarterly CPI retain their separate definitions, reporting periods and sources.
- **AI answers.** The Worker retrieves a bounded set of public records, asks the model to cite those records by ID, validates the response and attaches links from the database. Readers can open the evidence directly when the model cannot answer.
- **Limits.** Request throttling and a daily inference budget bound the cost of a public feature. Source records and model responses can have gaps. Source cards make those gaps visible.

The homepage daily brief summarizes a rolling 24-hour edition. D1 stores the current brief and coordinates regeneration across concurrent requests. Each summary links back to its public source records.

## Run locally

Install Node.js 24. Seed the local D1 database with published timeline previews and an economic snapshot.

~~~sh
npm ci --prefix backend
npm --prefix backend run db:local
npm --prefix backend run db:demo
npm run dev
~~~

Open the URL printed by Wrangler. For Gemini inference, create backend/.dev.vars and set GEMINI_API_KEY there. Wrangler keeps this file local. To deploy with your own Cloudflare account, replace the example D1 UUID and add the Gemini key as a Worker secret.

~~~sh
npm test
npm run build
~~~

## Source release

Based on production revision 1c413ff10e205504aaab24c950e61b0b7b1f9e6a. This repository contains the site, Worker, migrations, tests and published sample data. Private deployment workflows and the full editorial archive live in the production repository.

Photos and source records retain their respective credits and rights. See [image credits](https://threadnews.online/about) for attribution.
