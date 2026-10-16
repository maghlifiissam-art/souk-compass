# souk-relay

Minimal authenticated relay between the Cloudflare Worker and the Qloo hackathon API.
The Worker's Qloo calls go to `https://souk-relay.vercel.app/api/qloo?__path=<path>&<query>`
with an `X-Relay-Key` header; the relay forwards to `https://hackathon.api.qloo.com`
with the Qloo key, which exists only as a secret on the relay host. It stores and logs
nothing. Single Vercel Node serverless function, free Hobby tier, zero dependencies.

Deploy: `vercel deploy --prod` from this directory, with env secrets
`QLOO_API_KEY` and `RELAY_SHARED_SECRET` set in the Vercel project.
