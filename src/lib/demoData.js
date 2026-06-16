// Sample council response, shape-identical to what runCouncil() returns. Used when
// no endpoint is configured or "demo" is requested, so the UI works with zero setup.

export const DEMO_RESULT = {
  mode: "council",
  route: { complexity: "complex", domain: "reasoning", reason: "Architecture trade-off with no single right answer" },
  disagreement: 43,
  debated: true,
  rounds: 2,
  finalAnswer:
    "Default to Postgres. For a real-time chat app the database choice matters less than the transport layer — fan-out and presence are solved with a broker or pub/sub (Redis, a websocket layer, or Supabase Realtime), not by the database engine. Postgres gives you relational integrity for users, rooms, and read receipts, plus JSONB if message shapes need to flex. Reach for MongoDB only if messages are genuinely document-shaped and schema churn is high early on.",
  agreement: 75,
  consensus: [
    "Real-time fan-out belongs at the transport/broker layer, not the DB",
    "Both databases can work; team familiarity is the bigger factor",
  ],
  dissent: [
    { advisor: "kimi", point: "Argued MongoDB's flexible schema speeds early iteration when message types are still changing" },
  ],
  anchor: {
    id: "anchor",
    answer: "Postgres is the safer default; handle real-time delivery with a pub/sub layer rather than the database itself.",
    confidence: 78,
    rationale: "Relational integrity plus JSONB covers most chat needs without sacrificing transactions.",
  },
  verdicts: [
    { id: "kimi", answer: "MongoDB — schema flexibility for evolving message types", confidence: 61, rationale: "Early message shapes change often; document model avoids migrations." },
    { id: "deepseek", answer: "Postgres", confidence: 80, rationale: "JSONB covers flexible payloads without giving up transactions." },
    { id: "gemini", answer: "Postgres, with Redis for presence and fan-out", confidence: 86, rationale: "Pair durable relational storage with an in-memory layer for real-time." },
  ],
  failures: [],
  cost: { router: 0.0001, members: 0.0131, anchor: 0.0029, orchestrator: 0.0156, total: 0.0317, currency: "USD" },
};
