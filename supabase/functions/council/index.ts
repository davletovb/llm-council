// council.ts
// An LLM "council" with three quality/cost mechanisms layered on top of the basic
// fan-out + orchestration:
//
//   1. ROUTER  — a cheap model first classifies the query. Simple questions are
//      answered by a single capable model (no council), concentrating spend on the
//      hard ones. Returns complexity + domain.
//   2. DOMAIN-WEIGHTED ORCHESTRATION — the router's domain tag plus each advisor's
//      declared strengths are handed to the orchestrator so it weights the right
//      voices (coding models on code, etc.) instead of treating all votes equally.
//   3. ADAPTIVE DEBATE — after round 1, an OBJECTIVE disagreement score is computed
//      from confidence spread and answer divergence. Only when it crosses a
//      threshold do members run a second "critique & revise" round. You pay the ~2x
//      for debate exactly when the council is split, not on every query.
//
// Deployable as a Supabase Edge Function (Deno). For plain Node 18+, see the note at
// the bottom — only the entrypoint and env access change.

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const PER_CALL_TIMEOUT_MS = 60_000;

// --- Tunable behavior -------------------------------------------------------
const CONFIG = {
  useRouter: true, // route simple queries to a single model
  adaptiveDebate: true, // run a 2nd member round when the council is split
  debateThreshold: 0.35, // disagreement (0..1) above which debate triggers
};

// --- Roster -----------------------------------------------------------------
// Verify slugs against https://openrouter.ai/models — they occasionally change.
// `tags` declare each advisor's strengths; the orchestrator uses them to weight.
type ModelCfg = {
  id: string;
  model: string;
  maxTokens: number;
  reasoning?: "low" | "medium" | "high";
  tags?: string[];
};

const MEMBERS: ModelCfg[] = [
  { id: "kimi", model: "moonshotai/kimi-k2.7-code", maxTokens: 700, reasoning: "low", tags: ["coding"] },
  { id: "deepseek", model: "deepseek/deepseek-v4-pro", maxTokens: 700, reasoning: "low", tags: ["reasoning", "coding"] },
  { id: "gemini", model: "google/gemini-3.1-pro-preview", maxTokens: 700, reasoning: "low", tags: ["general", "reasoning", "multimodal"] },
];

// Frontier judge. Runs once per complex query, so frontier spend is justified here.
// A/B note: swap to { id: "grok", model: "x-ai/grok-4.3", ... } for the cheaper judge.
const ORCHESTRATOR: ModelCfg = { id: "gpt5", model: "openai/gpt-5", maxTokens: 1200, reasoning: "low" };

// Cheap, fast model used only to classify the query.
const ROUTER: ModelCfg = { id: "router", model: "openai/gpt-5-nano", maxTokens: 120, reasoning: "low" };

// Strong-but-moderate, independent baseline. Two roles:
//   - answers "simple" queries alone (router path), and
//   - on complex queries answers independently as the BASELINE the council must beat.
const ANCHOR: ModelCfg = { id: "anchor", model: "x-ai/grok-4.3", maxTokens: 900, reasoning: "low", tags: ["reasoning", "general"] };

// OpenRouter list prices per 1M tokens as [input, output]. Update as prices move.
const PRICES: Record<string, [number, number]> = {
  "moonshotai/kimi-k2.7-code": [0.75, 3.5],
  "deepseek/deepseek-v4-pro": [0.435, 0.87],
  "google/gemini-3.1-pro-preview": [2.0, 12.0],
  "x-ai/grok-4.3": [1.25, 2.5],
  "openai/gpt-5": [1.25, 10.0],
  "openai/gpt-5-nano": [0.05, 0.4],
};

// --- Prompts ----------------------------------------------------------------
const MEMBER_SYSTEM =
  `You are one advisor on a council of independent AI models. Answer the user's ` +
  `question directly and concisely on your own — do not speculate about other ` +
  `advisors. Respond with ONLY a JSON object, no markdown fences and no preamble:\n` +
  `{"answer": "<your concise answer>", "confidence": <integer 0-100>, "rationale": "<one or two sentences>"}`;

const MEMBER_DEBATE_SYSTEM =
  `You are one advisor on a council. You already gave an initial answer; now you can ` +
  `see every advisor's answer. Reconsider yours honestly: if another advisor is more ` +
  `convincing, revise; if you remain right, hold and sharpen your rationale. Do not ` +
  `simply conform to the majority. Respond with ONLY a JSON object, no fences:\n` +
  `{"answer": "<your possibly-revised answer>", "confidence": <integer 0-100>, "rationale": "<one or two sentences>"}`;

const ROUTER_SYSTEM =
  `You are a routing classifier. Judge the user's question and respond with ONLY a ` +
  `JSON object, no fences:\n` +
  `{"complexity": "simple"|"complex", "domain": "coding"|"math"|"factual"|"reasoning"|"writing"|"other", "reason": "<short>"}\n` +
  `"simple" = one capable model can answer reliably (lookups, definitions, short or ` +
  `routine tasks). "complex" = ambiguous, multi-step, high-stakes, or contested — ` +
  `worth multiple independent perspectives.`;

const ORCHESTRATOR_SYSTEM =
  `You are the orchestrator of a council of AI advisors. You receive the user's ` +
  `question, the query's domain, each advisor's declared strengths, each advisor's ` +
  `verdict, and an independent ANCHOR model's baseline answer. Weigh the advisors: ` +
  `give MORE weight to those whose strengths match the domain, favor claims multiple ` +
  `advisors independently agree on, and treat lone high-confidence outliers ` +
  `skeptically unless their rationale is clearly stronger.\n` +
  `Respond with ONLY a JSON object, no fences:\n` +
  `{\n` +
  `  "finalAnswer": "<the single best answer for the user>",\n` +
  `  "agreement": <integer 0-100, how strongly the council converged>,\n` +
  `  "consensus": ["<a point most or all advisors agreed on>", ...],\n` +
  `  "dissent": [{"advisor": "<advisor id>", "point": "<where they differed and why it matters>"}]\n` +
  `}\n` +
  `Use advisor ids exactly as given. Empty dissent array if there was no real disagreement.\n` +
  `Treat the anchor's answer as the baseline. Adopt the council's answer only if it is ` +
  `clearly better than the anchor's; otherwise return the anchor's answer as finalAnswer.`;

// --- Types ------------------------------------------------------------------
type Usage = { prompt_tokens?: number; completion_tokens?: number };
type CallResult = { content: string; costUSD: number; usage: Usage };
type Verdict = { answer: string; confidence: number; rationale: string };
type MemberResult = { id: string; model: string; verdict: Verdict; costUSD: number };
type Failure = { id: string; error: string };
type Route = { complexity: "simple" | "complex"; domain: string; reason: string };
type Orchestration = {
  finalAnswer: string;
  agreement: number;
  consensus: string[];
  dissent: { advisor: string; point: string }[];
};

// --- Core: one OpenRouter call ---------------------------------------------
async function callModel(apiKey: string, cfg: ModelCfg, system: string, user: string): Promise<CallResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PER_CALL_TIMEOUT_MS);
  try {
    const body: Record<string, unknown> = {
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    };
    if (cfg.reasoning) body.reasoning = { effort: cfg.reasoning };

    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://your-app.example",
        "X-Title": "LLM Council",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${cfg.model} -> ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    const content: string = data?.choices?.[0]?.message?.content ?? "";
    const usage: Usage = data?.usage ?? {};
    return { content, usage, costUSD: costOf(cfg.model, usage) };
  } finally {
    clearTimeout(timer);
  }
}

function costOf(model: string, usage: Usage): number {
  const price = PRICES[model];
  if (!price) return 0;
  const [inRate, outRate] = price;
  return ((usage.prompt_tokens ?? 0) / 1e6) * inRate + ((usage.completion_tokens ?? 0) / 1e6) * outRate;
}

// --- Defensive JSON parsing -------------------------------------------------
function extractJson(raw: string): string {
  const cleaned = raw.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  return start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Math.round(Number(v));
  if (Number.isNaN(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

function parseVerdict(raw: string): Verdict {
  try {
    const obj = JSON.parse(extractJson(raw));
    return {
      answer: String(obj.answer ?? "").trim(),
      confidence: clampInt(obj.confidence, 0, 100, 50),
      rationale: String(obj.rationale ?? "").trim(),
    };
  } catch {
    return { answer: raw.trim(), confidence: 50, rationale: "(unstructured response)" };
  }
}

function parseRoute(raw: string): Route {
  try {
    const obj = JSON.parse(extractJson(raw));
    const complexity = obj.complexity === "simple" ? "simple" : "complex";
    return { complexity, domain: String(obj.domain ?? "other").trim(), reason: String(obj.reason ?? "").trim() };
  } catch {
    // If routing fails, default to the full council — safer than mis-routing.
    return { complexity: "complex", domain: "other", reason: "(router parse failed; defaulted to council)" };
  }
}

function parseOrchestration(raw: string): Orchestration {
  try {
    const obj = JSON.parse(extractJson(raw));
    return {
      finalAnswer: String(obj.finalAnswer ?? "").trim(),
      agreement: clampInt(obj.agreement, 0, 100, 50),
      consensus: Array.isArray(obj.consensus) ? obj.consensus.map((x: unknown) => String(x).trim()) : [],
      dissent: Array.isArray(obj.dissent)
        ? obj.dissent.map((d: { advisor?: unknown; point?: unknown }) => ({
            advisor: String(d?.advisor ?? "").trim(),
            point: String(d?.point ?? "").trim(),
          }))
        : [],
    };
  } catch {
    return { finalAnswer: raw.trim(), agreement: 50, consensus: [], dissent: [] };
  }
}

// --- Member rounds (round 1 and debate share this) --------------------------
async function runMembers(
  apiKey: string,
  system: string,
  userFor: (m: ModelCfg) => string,
): Promise<{ verdicts: MemberResult[]; failures: Failure[]; cost: number }> {
  const settled = await Promise.allSettled(
    MEMBERS.map(async (m): Promise<MemberResult> => {
      const r = await callModel(apiKey, m, system, userFor(m));
      return { id: m.id, model: m.model, verdict: parseVerdict(r.content), costUSD: r.costUSD };
    }),
  );

  const verdicts: MemberResult[] = [];
  const failures: Failure[] = [];
  let cost = 0;
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") {
      verdicts.push(s.value);
      cost += s.value.costUSD;
    } else {
      failures.push({ id: MEMBERS[i].id, error: String(s.reason).slice(0, 200) });
    }
  });
  return { verdicts, failures, cost };
}

// --- Objective disagreement score (0..1) ------------------------------------
// Blends confidence spread (30%) with answer divergence (70%). Independent of the
// orchestrator's self-reported agreement — this is what triggers debate.
function disagreementScore(verdicts: MemberResult[]): number {
  if (verdicts.length < 2) return 0;

  const confs = verdicts.map((v) => v.verdict.confidence);
  const mean = confs.reduce((a, b) => a + b, 0) / confs.length;
  const sd = Math.sqrt(confs.reduce((a, c) => a + (c - mean) ** 2, 0) / confs.length);
  const confSpread = Math.min(1, sd / 50);

  let pairs = 0;
  let distSum = 0;
  for (let i = 0; i < verdicts.length; i++) {
    for (let j = i + 1; j < verdicts.length; j++) {
      distSum += 1 - jaccard(tokenSet(verdicts[i].verdict.answer), tokenSet(verdicts[j].verdict.answer));
      pairs++;
    }
  }
  const divergence = pairs ? distSum / pairs : 0;

  return round2(0.7 * divergence + 0.3 * confSpread);
}

function tokenSet(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

// --- Prompt builders --------------------------------------------------------
function rosterStrengths(): string {
  return MEMBERS.map((m) => `${m.id}: ${(m.tags ?? ["general"]).join(", ")}`).join("; ");
}

function buildOrchestratorPrompt(question: string, route: Route, verdicts: MemberResult[], anchor: Verdict | null): string {
  const panel = verdicts
    .map(
      (v) =>
        `Advisor ${v.id} (strengths: ${(MEMBERS.find((m) => m.id === v.id)?.tags ?? ["general"]).join(", ")}) ` +
        `— confidence ${v.verdict.confidence}/100\nAnswer: ${v.verdict.answer}\nRationale: ${v.verdict.rationale}`,
    )
    .join("\n\n");
  const baseline = anchor
    ? `Anchor baseline (the answer to beat) — confidence ${anchor.confidence}/100:\n${anchor.answer}\n\n`
    : "";
  return (
    `User question:\n${question}\n\n` +
    `Query domain (from router): ${route.domain}\n` +
    `Advisor strengths: ${rosterStrengths()}\n\n` +
    baseline +
    `Council verdicts:\n${panel}\n\nProduce the final answer for the user.`
  );
}

function buildDebatePrompt(question: string, round1: MemberResult[], selfId: string): string {
  const panel = round1
    .map((v) => `${v.id === selfId ? "(you) " : ""}${v.id} [${v.verdict.confidence}/100]: ${v.verdict.answer}`)
    .join("\n");
  return `Question:\n${question}\n\nAll advisors' initial answers:\n${panel}\n\nReconsider and give your final verdict.`;
}

// --- Public entrypoint ------------------------------------------------------
export async function runCouncil(apiKey: string, question: string) {
  let routerCost = 0;
  let route: Route = { complexity: "complex", domain: "other", reason: "(router disabled)" };

  // 1) ROUTE -----------------------------------------------------------------
  if (CONFIG.useRouter) {
    const r = await callModel(apiKey, ROUTER, ROUTER_SYSTEM, question);
    routerCost = r.costUSD;
    route = parseRoute(r.content);
  }

  // 1a) SIMPLE -> anchor model alone, skip the council ------------------------
  if (CONFIG.useRouter && route.complexity === "simple") {
    const a = await callModel(apiKey, ANCHOR, MEMBER_SYSTEM, question);
    const v = parseVerdict(a.content);
    return {
      mode: "solo" as const,
      route,
      finalAnswer: v.answer,
      agreement: 100,
      disagreement: 0,
      debated: false,
      rounds: 0,
      consensus: ["Routed to the anchor model alone — question judged simple."],
      dissent: [],
      anchor: { id: ANCHOR.id, ...v },
      verdicts: [{ id: ANCHOR.id, ...v }],
      failures: [],
      cost: {
        router: round6(routerCost),
        members: 0,
        anchor: round6(a.costUSD),
        orchestrator: 0,
        total: round6(routerCost + a.costUSD),
        currency: "USD",
      },
    };
  }

  // 2) COUNCIL: round 1 members + the anchor's baseline, in parallel ----------
  const [round1, anchorCall] = await Promise.all([
    runMembers(apiKey, MEMBER_SYSTEM, () => question),
    callModel(apiKey, ANCHOR, MEMBER_SYSTEM, question),
  ]);
  if (round1.verdicts.length === 0) {
    throw new Error("All council members failed: " + JSON.stringify(round1.failures));
  }
  const anchorVerdict = parseVerdict(anchorCall.content);
  const anchorCost = anchorCall.costUSD;

  let memberCost = round1.cost;
  let verdicts = round1.verdicts;
  let failures = round1.failures;
  const disagreement = disagreementScore(verdicts);

  // 3) ADAPTIVE DEBATE: only when the members are split -----------------------
  let debated = false;
  let rounds = 1;
  if (CONFIG.adaptiveDebate && verdicts.length >= 2 && disagreement >= CONFIG.debateThreshold) {
    const r2 = await runMembers(apiKey, MEMBER_DEBATE_SYSTEM, (m) => buildDebatePrompt(question, round1.verdicts, m.id));
    if (r2.verdicts.length > 0) {
      verdicts = r2.verdicts; // revised verdicts supersede round 1
      failures = r2.failures;
      memberCost += r2.cost;
      debated = true;
      rounds = 2;
    }
  }

  // 4) ORCHESTRATE (domain-weighted, anchor as baseline) ----------------------
  const orch = await callModel(
    apiKey,
    ORCHESTRATOR,
    ORCHESTRATOR_SYSTEM,
    buildOrchestratorPrompt(question, route, verdicts, anchorVerdict),
  );
  const consensus = parseOrchestration(orch.content);

  const total = routerCost + memberCost + anchorCost + orch.costUSD;
  return {
    mode: "council" as const,
    route,
    finalAnswer: consensus.finalAnswer,
    agreement: consensus.agreement, // orchestrator's self-report
    disagreement: Math.round(disagreement * 100), // objective, 0-100
    debated,
    rounds,
    consensus: consensus.consensus,
    dissent: consensus.dissent,
    anchor: { id: ANCHOR.id, ...anchorVerdict },
    verdicts: verdicts.map((v) => ({ id: v.id, ...v.verdict })),
    failures,
    cost: {
      router: round6(routerCost),
      members: round6(memberCost),
      anchor: round6(anchorCost),
      orchestrator: round6(orch.costUSD),
      total: round6(total),
      currency: "USD",
    },
  };
}

// --- Supabase Edge Function entrypoint (Deno) -------------------------------
// Deploy:  supabase functions deploy council
// Secret:  supabase secrets set OPENROUTER_API_KEY=sk-or-...
const CORS = {
  "Access-Control-Allow-Origin": "*", // tighten to your domain in production
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// deno-lint-ignore no-explicit-any
declare const Deno: any;

if (typeof Deno !== "undefined" && Deno.serve) {
  Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    if (req.method !== "POST") return json({ error: "POST only" }, 405);

    const apiKey = Deno.env.get("OPENROUTER_API_KEY");
    if (!apiKey) return json({ error: "Missing OPENROUTER_API_KEY secret" }, 500);

    try {
      const { question } = await req.json();
      if (!question || typeof question !== "string") {
        return json({ error: "Body must be { question: string }" }, 400);
      }
      return json(await runCouncil(apiKey, question), 200);
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  });
}

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// --- Plain Node 18+ usage ---------------------------------------------------
//   import { runCouncil } from "./council.ts";
//   const result = await runCouncil(process.env.OPENROUTER_API_KEY!, "your question");
//   console.log(result.mode, result.finalAnswer, result.cost);
// global fetch / AbortController are built in on Node 18+.
