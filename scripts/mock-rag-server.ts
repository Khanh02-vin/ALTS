/**
 * Ponytail mock server — ultra lazy fallback (Node native, no deps)
 * Run: node scripts/mock-rag-server.ts
 */
import { createServer } from "node:http";
import { parse } from "node:url";

const PORT = Number(process.env.MOCK_RAG_PORT ?? 1420);
// Dev-only stub, but binding all interfaces on a laptop with a LAN would publish
// it to every machine on the network. Loopback unless explicitly overridden.
const HOST = process.env.MOCK_RAG_HOST ?? "127.0.0.1";
const state: { playlists: unknown[]; videos: unknown[] } = { playlists: [], videos: [] };

createServer((req, res) => {
  const { pathname } = parse(req.url ?? "/", true);

  // The real sidecar is same-origin (the webview fetches 127.0.0.1 directly), so
  // the mock only needs CORS for local tooling. Echo the loopback origin instead
  // of "*" so a page open in a browser cannot read another service's data here.
  const origin = req.headers.origin;
  const allowedOrigin =
    origin === undefined || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)
      ? origin ?? "*"
      : null;
  if (allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") return res.writeHead(204).end();

  if (pathname === "/api/rag/playlists") {
    if (req.method === "GET") return res.end(JSON.stringify({ playlists: state.playlists }));
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const playlist = { id: `pl-${Date.now()}`, ...JSON.parse(body), status: "indexed" };
        state.playlists.push(playlist);
        res.writeHead(201);
        res.end(JSON.stringify({ id: playlist.id, status: "indexed" }));
      });
      return;
    }
  }

  if (pathname === "/api/rag/query" && req.method === "POST") {
    return res.end(
      JSON.stringify({
        answer: "Based on transcript, video discusses key points.",
        retrieval: "embedding",
        results: [
          { score: 0.9, video_id: "test123", text: "Important point about AI models", start_seconds: 5, end_seconds: 10 },
        ],
      })
    );
  }

  res.writeHead(404);
  res.end(JSON.stringify({ message: "UNKNOWN_ENDPOINT" }));
}).listen(PORT, HOST, () => console.log(`Ponytail mock RAG server: http://${HOST}:${PORT}`));
