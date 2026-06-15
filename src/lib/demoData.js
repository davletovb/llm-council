// Sample council response, shape-identical to what runCouncil() returns. Used when
// no endpoint is configured or "demo" is requested, so the UI works with zero setup.

export const DEMO_RESULT = {
  finalAnswer:
    "Default to Postgres. For a real-time chat app the database choice matters less than the transport layer — fan-out and presence are solved with a broker or pub/sub (Redis, a websocket layer, or Supabase Realtime), not by the database engine. Postgres gives you relational integrity for users, rooms, and read receipts, plus JSONB if message shapes need to flex. Reach for MongoDB only if messages are genuinely document-shaped and schema churn is high early on.",
  agreement: 72,
  consensus: [
    "Real-time fan-out belongs at the transport/broker layer, not the DB",
    "Both databases can work; team familiarity is the bigger factor",
  ],
  dissent: [
    {
      advisor: "kimi",
      point: "Argued MongoDB's flexible schema speeds early iteration when message types are still changing",
    },
  ],
  verdicts: [
    { id: "kimi", answer: "MongoDB — schema flexibility for evolving message types", confidence: 64, rationale: "Early-stage message shapes change often; document model avoids migrations." },
    { id: "qwen", answer: "Postgres with a pub/sub layer for delivery", confidence: 80, rationale: "Relational guarantees for accounts and rooms; fan-out handled outside the DB." },
    { id: "deepseek", answer: "Postgres", confidence: 78, rationale: "JSONB covers flexible payloads without giving up transactions." },
    { id: "gemini", answer: "Postgres unless the data is truly document-heavy", confidence: 70, rationale: "Most chat data is relational; Mongo wins only in narrow cases." },
    { id: "gpt", answer: "Postgres, add Redis for presence and fan-out", confidence: 82, rationale: "Pair durable storage with an in-memory layer for real-time." },
  ],
  failures: [],
  cost: { members: 0.0221, orchestrator: 0.0188, total: 0.0409, currency: "USD" },
};
