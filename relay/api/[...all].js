// Souk Compass relay - Vercel Node serverless function.
// Vercel multi-segment catch-all routing proved unreliable on this account,
// so the contract is single-segment:
//   GET  /api/health                         -> {"ok":true}
//   ANY  /api/qloo?__path=/search&<params>   -> https://hackathon.api.qloo.com/search?<params>
// Auth: header X-Relay-Key must equal RELAY_SHARED_SECRET (env).
// Qloo key: QLOO_API_KEY (env), sent upstream as X-Api-Key. Never logged/stored.
const UPSTREAM = "https://hackathon.api.qloo.com";
const TIMEOUT_MS = 15000;

module.exports.config = { api: { bodyParser: false } };

module.exports = async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/api/health") {
    res.status(200).json({ ok: true, service: "souk-relay" });
    return;
  }
  if (url.pathname !== "/api/qloo") {
    res.status(404).json({ error: "not found" });
    return;
  }
  const upstreamPath = url.searchParams.get("__path");
  if (!upstreamPath || !upstreamPath.startsWith("/")) {
    res.status(400).json({ error: "missing __path" });
    return;
  }
  const shared = process.env.RELAY_SHARED_SECRET || "";
  if (!shared || req.headers["x-relay-key"] !== shared) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const apiKey = process.env.QLOO_API_KEY || "";
  if (!apiKey) {
    res.status(500).json({ error: "relay not configured" });
    return;
  }

  url.searchParams.delete("__path");
  const qs = url.searchParams.toString();
  const target = UPSTREAM + upstreamPath + (qs ? "?" + qs : "");

  const headers = { "x-api-key": apiKey, accept: "application/json" };
  if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"];

  let body;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = Buffer.concat(chunks);
  }

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    const ct = upstream.headers.get("content-type");
    if (ct) res.setHeader("content-type", ct);
    res.status(upstream.status).send(buf);
  } catch (err) {
    res.status(502).json({ error: "upstream fetch failed", detail: String((err && err.name) || err) });
  }
};
