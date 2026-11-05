import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";

const app = express();
const PORT = 3000;

app.use(express.json());



// Local dev proxy for /api/scopus (mirrors Cloudflare Pages function at functions/api/scopus.ts)
app.get("/api/scopus", async (req, res) => {
  const apiKey = process.env.SCOPUS_API_KEY?.trim();
  if (!apiKey) {
    return res.status(500).json({
      error: "SCOPUS_API_KEY secret is not configured. On Cloudflare Pages, set the SCOPUS_API_KEY environment secret.",
    });
  }

  const query = req.query.query as string;
  if (!query || typeof query !== "string" || !query.trim()) {
    return res.status(400).json({ error: 'Missing required "query" parameter' });
  }

  if (query.length > 2000) {
    return res.status(400).json({ error: "Query exceeds maximum allowed length of 2000 characters" });
  }

  const upstreamUrl = new URL("https://api.elsevier.com/content/search/scopus");
  upstreamUrl.searchParams.set("query", query.trim());

  const count = parseInt((req.query.count as string) || "25", 10);
  upstreamUrl.searchParams.set("count", String(isNaN(count) || count <= 0 || count > 25 ? 25 : count));

  const start = parseInt((req.query.start as string) || "0", 10);
  upstreamUrl.searchParams.set("start", String(isNaN(start) || start < 0 || start > 5000 ? 0 : start));

  if (req.query.view === "COMPLETE") {
    upstreamUrl.searchParams.set("view", "COMPLETE");
  } else if (req.query.view === "STANDARD") {
    upstreamUrl.searchParams.set("view", "STANDARD");
  }

  try {
    const upstreamRes = await fetch(upstreamUrl.toString(), {
      headers: {
        "X-ELS-APIKey": apiKey,
        "Accept": "application/json",
        "User-Agent": "EPIC-Paper-Local-Dev/1.0",
      },
    });

    if (!upstreamRes.ok) {
      let safeErrorDetail = `Upstream Scopus API error (${upstreamRes.status})`;
      try {
        const errJson: any = await upstreamRes.json();
        const msg =
          errJson?.["service-error"]?.status?.statusText ||
          errJson?.["error-response"]?.["error-message"] ||
          errJson?.message;
        if (msg) safeErrorDetail = msg;
      } catch {
        safeErrorDetail = upstreamRes.statusText || safeErrorDetail;
      }
      return res.status(upstreamRes.status).json({ error: safeErrorDetail, status: upstreamRes.status });
    }

    const data = await upstreamRes.json();
    res.json(data);
  } catch (err: any) {
    console.error("Local scopus proxy error:", err);
    res.status(500).json({ error: "Internal error processing Scopus request." });
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
