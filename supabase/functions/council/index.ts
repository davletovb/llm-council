// council.ts
// An LLM "council": several independent member models answer in parallel, then a
// single orchestrator synthesizes their verdicts into one final answer.
//
// Deployable as a Supabase Edge Function (Deno). To run in plain Node 18+, see the
// note at the bottom of this file — only the entrypoint and env access change.
//
// Design goals: cheap, robust, and diverse.
//   - Members run in parallel (Promise.allSettled) so one slow/failed model can't
//     sink the whole request.
//   - Each member returns a SHORT structured verdict (JSON), which keeps both member
//     output cost and the orchestrator's input cost bounded.
//   - Hard max_tokens caps + low reasoning effort on every call.
//   - Per-call cost is computed from OpenRouter usage and returned for monitoring.

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const PER_CALL_TIMEOUT_MS = 60_000;

// --- Roster -----------------------------------------------------------------
// Verify slugs against https://openrouter.ai/models — they occasionally change.
type ModelCfg = {
  id: string; // short human label
  model: string; // OpenRouter model slug
  maxTokens: number; // hard output cap (cost control)
  reasoning?: "low" | "medium" | "high"; // OpenRouter reasoning effort
};

const MEMBERS: ModelCfg[] = [
  { id: "kimi", model: "moonshotai/kimi-k2.7-code", maxTokens: 700, reasoning: "low" },
  { id: "qwen", model: "qwen/qwen3.7-plus", maxTokens: 700, reasoning: "low" },
  { id: "deepseek", model: "deepseek/deepseek-v4-pro", maxTokens: 700, reasoning: "low" },
  { id: "gemini", model: "google/gemini-3.1-flash-lite", maxTokens: 700, reasoning: "low" },
  { id: "gpt", model: "openai/gpt-5-mini", maxTokens: 700, reasoning: "low" },
];

const ORCHESTRATOR: ModelCfg = {
  id: "grok",
  model: "x-ai/grok-4.3",
  maxTokens: 1200,
  reasoning: "low",
};

// OpenRouter list prices per 1M tokens as [input, output]. Update as prices move.
const PRICES: Record<string, [number, number]> = {
  "moonshotai/kimi-k2.7-code": [0.75, 3.5],
  "qwen/qwen3.7-plus": [0.32, 1.28],
  "deepseek/deepseek-v4-pro": [0.435, 0.87],
  "google/gemini-3.1-flash-lite": [0.25, 1.5],
  "openai/gpt-5-mini": [0.25, 2.0],
  "x-ai/grok-4.3": [1.25, 2.5],
};

// --- Prompts ----------------------------------------------------------------
const MEMBER_SYSTEM =
  `You are one advisor on a council of independent AI models. Answer the user's ` +
  `question directly and concisely on your own — do not speculate about other ` +
  `advisors. Respond with ONLY a JSON object, no markdown fences and no preamble, ` +
  `in exactly this shape:\n` +
  `{"answer": "<your concise answer>", "confidence": <integer 0-100>, ` +
  `"rationale": "<one or two sentences justifying it>"}`;

const ORCHESTRATOR_SYSTEM =
  `You are the orchestrator of a council of AI advisors. You receive the user's ` +
  `question and each advisor's verdict (answer, confidence, rationale). Weigh them, ` +
  `favoring claims multiple advisors independently agree on and treating lone ` +
  `high-confidence outliers skeptically unless their rationale is clearly stronger.\n` +
  `Respond with ONLY a JSON object, no markdown fences and no preamble, in exactly ` +
  `this shape:\n` +
  `{\n` +
  `  "finalAnswer": "<the single best answer for the user>",\n` +
  `  "agreement": <integer 0-100, how strongly the council converged>,\n` +
  `  "consensus": ["<a point most or all advisors agreed on>", ...],\n` +
  `  "dissent": [{"advisor": "<advisor id>", "point": "<where they differed and why it might matter>"}]\n` +
  `}\n` +
  `Use the advisor ids exactly as given. If there was no real disagreement, return an empty dissent array.`;

// --- Types ------------------------------------------------------------------
type Usage = { prompt_tokens?: number; completion_tokens?: number };
type CallResult = { content: string; costUSD: number; usage: Usage };
type Verdict = { answer: string; confidence: number; rationale: string };
type MemberResult = { id: string; model: string; verdict: Verdict; costUSD: number };
type Failure = { id: string; error: string };
type Orchestration = {
  finalAnswer: string;
  agreement: number;
  consensus: string[];
  dissent: { advisor: string; point: string }[];
};

// --- Core: one OpenRouter call ---------------------------------------------
async function callModel(
  apiKey: string,
  cfg: ModelCfg,
  system: string,
  user: string,
): Promise<CallResult> {
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
        // Optional but recommended — used for OpenRouter's app rankings.
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
  const inTok = usage.prompt_tokens ?? 0;
  const outTok = usage.completion_tokens ?? 0;
  return (inTok / 1e6) * inRate + (outTok / 1e6) * outRate;
}

// --- Parse a member's structured verdict (defensively) ----------------------
function parseVerdict(raw: string): Verdict {
  const cleaned = raw.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const slice = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  try {
    const obj = JSON.parse(slice);
    return {
      answer: String(obj.answer ?? "").trim(),
      confidence: clampInt(obj.confidence, 0, 100, 50),
      rationale: String(obj.rationale ?? "").trim(),
    };
  } catch {
    // Model ignored the JSON instruction — keep its voice rather than dropping it.
    return { answer: raw.trim(), confidence: 50, rationale: "(unstructured response)" };
  }
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Math.round(Number(v));
  if (Number.isNaN(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

// --- Parse the orchestrator's structured consensus (defensively) ------------
function parseOrchestration(raw: string): Orchestration {
  const cleaned = raw.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const slice = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  try {
    const obj = JSON.parse(slice);
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
    // Orchestrator ignored the JSON instruction — degrade gracefully.
    return { finalAnswer: raw.trim(), agreement: 50, consensus: [], dissent: [] };
  }
}

// --- Fan-out: all members in parallel --------------------------------------
async function gatherVerdicts(apiKey: string, question: string) {
  const settled = await Promise.allSettled(
    MEMBERS.map(async (m): Promise<MemberResult> => {
      const r = await callModel(apiKey, m, MEMBER_SYSTEM, question);
      return { id: m.id, model: m.model, verdict: parseVerdict(r.content), costUSD: r.costUSD };
    }),
  );

  const verdicts: MemberResult[] = [];
  const failures: Failure[] = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") verdicts.push(s.value);
    else failures.push({ id: MEMBERS[i].id, error: String(s.reason).slice(0, 200) });
  });
  return { verdicts, failures };
}

function buildOrchestratorPrompt(question: string, verdicts: MemberResult[]): string {
  const panel = verdicts
    .map(
      (v, i) =>
        `Advisor ${i + 1} (${v.id}) — confidence ${v.verdict.confidence}/100\n` +
        `Answer: ${v.verdict.answer}\n` +
        `Rationale: ${v.verdict.rationale}`,
    )
    .join("\n\n");
  return `User question:\n${question}\n\nCouncil verdicts:\n${panel}\n\nProduce the final answer for the user.`;
}

// --- Public entrypoint ------------------------------------------------------
export async function runCouncil(apiKey: string, question: string) {
  const { verdicts, failures } = await gatherVerdicts(apiKey, question);

  if (verdicts.length === 0) {
    throw new Error("All council members failed: " + JSON.stringify(failures));
  }

  const orch = await callModel(
    apiKey,
    ORCHESTRATOR,
    ORCHESTRATOR_SYSTEM,
    buildOrchestratorPrompt(question, verdicts),
  );

  const consensus = parseOrchestration(orch.content);
  const memberCost = verdicts.reduce((sum, v) => sum + v.costUSD, 0);
  const totalCost = memberCost + orch.costUSD;

  return {
    finalAnswer: consensus.finalAnswer,
    agreement: consensus.agreement,
    consensus: consensus.consensus,
    dissent: consensus.dissent,
    verdicts: verdicts.map((v) => ({ id: v.id, ...v.verdict })),
    failures,
    cost: {
      members: round6(memberCost),
      orchestrator: round6(orch.costUSD),
      total: round6(totalCost),
      currency: "USD",
    },
  };
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

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
    if (req.method !== "POST") {
      return json({ error: "POST only" }, 405);
    }

    const apiKey = Deno.env.get("OPENROUTER_API_KEY");
    if (!apiKey) return json({ error: "Missing OPENROUTER_API_KEY secret" }, 500);

    try {
      const { question } = await req.json();
      if (!question || typeof question !== "string") {
        return json({ error: "Body must be { question: string }" }, 400);
      }
      const result = await runCouncil(apiKey, question);
      return json(result, 200);
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
// Remove the Deno block above (or ignore it — it's guarded), then:
//
//   import { runCouncil } from "./council.ts";
//   const result = await runCouncil(process.env.OPENROUTER_API_KEY!, "your question");
//   console.log(result.finalAnswer, result.cost);
//
// global fetch / AbortController are built in on Node 18+, so no other changes needed.
