# Souk Compass

A bounded cultural-evidence agent for Moroccan creators and small sellers. It takes named taste anchors, checks cross-domain Qloo affinities, revises weak coverage, then suggests small experiments whose citations must match returned entity IDs.

## Current status

Deployed at https://souk-compass.magpro369.workers.dev and live-verified on October 16, 2026: 22 offline tests pass and real end-to-end runs complete against the live hackathon Qloo API and the Gemini free tier. A measured full run takes about 5-6 seconds wall time with about 2 ms of Worker CPU time; under a 5-way parallel burst the budget controls fail closed (HTTP 503 at the free-tier RPM edge, HTTP 429 at the per-IP daily cap) instead of exceeding quotas. The UI clears previous results at every run start, auto-retries a transient 503 twice with a busy notice, and states the daily reset plainly on 429. Redeployed and re-verified October 16, 2026 (Worker version f4f69579). Public judge access is the same-origin UI. No saved Qloo responses or recorded examples are included.

## What the prototype does

1. Resolves up to three named taste anchors through Qloo search. It selects the first match and shows the resolved names for review. Ambiguous or wrong matches need a clearer input.
2. Uses an optional cultural keyword to find Qloo tags, then requests cross-domain insights with location context and an optional age signal.
3. Revises weak coverage at most twice. A rule first drops the tag signal; if needed, Gemini suggests a broader keyword, which is resolved against Qloo's tag API. Gemini cannot invent operational tag IDs.
4. Keeps returned evidence only when it includes an entity ID and numeric affinity.
5. Generates two sets of experiments: an LLM-only baseline and a Qloo-grounded plan. The brief, configured model, temperature and output limit match; the evidence context is the intentional difference. This is a qualitative comparison, not an uplift claim.
6. Drops generated ideas without a valid returned evidence ID. The trace labels API observations, rule choices and LLM choices separately.

Qloo affinity is cultural association, not demand, market size or predicted sales. Citation validation proves only that an ID was returned; it does not prove the LLM's interpretation. Generated experiments must be reviewed and tested.

## Architecture

```
Same-origin browser form
  -> Worker /api/run (fixed schema, 4 KB body cap)
  -> singleton SQLite BudgetDO (atomic admission / reserve / commit)
  -> Qloo search + tags + insights (max 8 calls)
  -> Gemini (max 3 calls, each reserved before dispatch)
  -> citation post-check
  -> two comparison panels + decision trace
```

Only `/search`, `/v2/tags` and `/v2/insights` on `https://hackathon.api.qloo.com` are used. In production the Worker reaches Qloo through a minimal authenticated relay (`souk-relay.vercel.app`, single-file Vercel function): the Qloo key exists only as a relay host secret, and the Worker authenticates to the relay with its own `RELAY_SHARED_SECRET` secret. The relay stores and logs nothing. Direct mode (Worker secret `QLOO_API_KEY`) remains as a fallback. Keys are never in source. No prompt, plan or Qloo response cache is implemented. No arbitrary URL fetching, collaboration, messaging or purchasing features exist.

### Budget behavior

- A single SQLite-backed Durable Object serializes all counters and uses `transactionSync` for read/check/write operations. Its SQL adapter uses Cloudflare `sql.exec`, not Node's `prepare` interface.
- RPM and TPM use a rolling 60-second window; RPD uses a conservative rolling 25-hour window. Gemini's provider daily reset is Pacific midnight, not UTC, and a fall-back day can last 25 hours. The longer window caps that day too and deliberately avoids dependence on reset timing; it may block calls beyond the provider reset.
- Reserve before every generation. A conservative UTF-8-byte estimate plus the output cap and framing margin is used; this is not a formal tokenizer proof. Actual provider usage is reconciled after completion.
- Failed or timed-out generations retain the full reservation. Request counts are never refunded. Unknown token usage keeps the reservation. The first commit wins. No automatic retries or cross-model fallback exist.
- A deployment must explicitly choose one live-verified Gemini model. The source list is not a promise that either API ID is currently available.
- Admission is capped at 200 runs per UTC day globally and 10 per daily salted IP hash. Raw IPs are not stored. Both admission caps are checked before either counter increments in one transaction, so rejected IP attempts cannot consume global slots. Quota limits may stop runs before admission caps.
- Storage has row caps and old rows are pruned on access. No background polling or KV cache is used.
- Code-path envelope: at most 8 Qloo fetches + 3 Gemini fetches + 7 Durable Object fetches = 18 application subrequests. Deployment measurement (2026-10-16): about 2 ms CPU and 5-6 s wall per full run; the envelope holds.
- Workers free-tier CPU and request limits are acceptance gates. A successful dry run does not prove the deployed app fits them. Never upgrade or enable billing to bypass a limit.

## Privacy and security

Use public or fictional briefs only. Google's free-tier Gemini prompts may be used to improve Google products. Taste queries go to Qloo. The app does not persist briefs or plans; external providers may process or retain them under their terms. The UI warns against entering private or personal information.

The Worker accepts same-origin JSON, rejects unknown fields and oversized bodies, hashes Cloudflare's trusted connecting IP with a server secret, suppresses upstream error bodies and returns no-store responses. The UI renders API and model text with `textContent`, never HTML. Content Security Policy blocks third-party scripts and framing.

Per-IP control and an Origin check are abuse friction, not authentication or bot-proof protection. Distributed traffic can consume the global free budget; the safe outcome is a capacity message, not a paid fallback. Deployment logs must not capture prompts, headers, keys or response bodies.

## Local checks

Node 22+ is required for the offline SQLite tests.

```sh
npm ci
npm test
npx wrangler deploy --dry-run
```

Tests use invented fixtures, not stored Qloo payloads. They cover bounded revisions, citation rejection, no-anchor abort, keyword-to-tag resolution, schema rejection, Qloo parameter mapping, unknown-usage commits, RPM/TPM/RPD bounds, idempotency, restart persistence, time boundaries (including the November 1, 2026 Pacific DST fall-back), per-IP caps, denial without consuming other admission slots, full citation-list rejection, concurrent contenders and the Cloudflare SQL adapter. Cloudflare-runtime concurrency and failure injection still require deployment testing.

## Deployment checklist (not yet executed)

1. Account remains on free Workers and SQLite Durable Object tiers; no billing upgrade. Confirmed 2026-10-16.
2. `GEMINI_MODEL` is set to `gemini-3.1-flash-lite` (free-tier access live-verified).
3. Worker secrets `RELAY_SHARED_SECRET`, `GEMINI_API_KEY`, `IP_HASH_SALT` are provisioned through a secure path. The Qloo key lives on the relay host only. No secret values in files, source control, screenshots or shell history.
4. Done: 22 offline tests pass, deployed to the user's authorized account, live Qloo + Gemini traces verified without recording secrets or raw Qloo responses in the repository.
5. Measure CPU, application subrequests, failure behavior and end-to-end latency. Verify the counters in the real Durable Object, including parallel attempts and restart behavior.
6. Verify the public URL as a signed-out judge. Availability through the required judging window is a gate, not an existing promise.
7. Complete rules and quality review before the user sees a submission draft. Submission requires the user's explicit approval. No Devpost submission action is implemented.

Public-repo creation and publication are separate pending steps. MIT license applies to original code only. No Qloo data is included in the source archive. Raw payload display, stored responses or a recorded-run fallback remain disabled pending Qloo clarification and any required permission.

## Sources and verification notes

- Hackathon overview and rules: https://qloo.devpost.com/ and https://qloo.devpost.com/rules
- Hackathon developer guide: https://docs.qloo.com/reference/qloo-llm-hackathon-developer-guide
- Cloudflare limits: https://developers.cloudflare.com/workers/platform/limits/
- SQLite storage and transactionSync: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ (checked October 7, 2026)
- Gemini project rate limits: https://ai.google.dev/gemini-api/docs/rate-limits
- Gemini pricing and free-tier data-use terms: https://ai.google.dev/gemini-api/docs/pricing
- Gemini request shape: https://ai.google.dev/gemini-api/docs/text-generation
- Token estimation caveat: https://ai.google.dev/gemini-api/docs/tokens (checked October 7, 2026)

Provider limits and availability can change. Live account settings and actual API results must be checked before deployment.

## License

MIT. See LICENSE.
