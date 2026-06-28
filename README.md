# LLM Council

A multi-model "council": five member models answer a question independently and in
parallel via [OpenRouter](https://openrouter.ai), then a single orchestrator model
synthesizes their verdicts into one final answer with an agreement score, points of
consensus, and points of dissent.

Roster (edit in `supabase/functions/council/index.ts`):

| Role | Model |
|------|-------|
| Member | Kimi K2.7 Code |
| Member | DeepSeek V4 Pro |
| Member | Gemini 3.1 Pro |
| Member | GLM 5.2 |
| Anchor (baseline) | Grok 4.3 |
| Orchestrator | GPT-5 |
| Router | GPT-5 Nano |

Six distinct labs, none grading its own lineage: the judge (OpenAI) sees no OpenAI
member, the anchor (xAI) is independent of the members, and the two frontier models
sit in deliberating seats (a member and the judge) while the high-frequency anchor
seat stays moderate and cheap.

The **anchor** answers independently as the baseline the council must beat, and also
handles queries the router judges "simple" (answered alone, no council).

## Architecture

```
Browser (Vite/React)  ──POST { question }──►  Edge Function  ──►  OpenRouter ──► 6 models
        ▲                                          │
        └──────────  { finalAnswer, agreement, consensus, dissent, verdicts, cost }
```

The OpenRouter API key lives **only** inside the Edge Function. The frontend never
sees it — it just calls the function.

## Project layout

```
supabase/functions/council/index.ts   the council: fan-out + orchestration (Deno)
src/hooks/useCouncil.js                fetch wrapper: loading / error / result state
src/hooks/useHistory.js                local history of runs (browser localStorage)
src/components/CouncilResult.jsx       renders the structured verdict
src/lib/themes.js                      dark/light tokens -> CSS variables
src/lib/demoData.js                    sample result for demo mode
src/App.jsx                            the shell (input, roster, result)
```

## 1. Deploy the Edge Function

```bash
supabase functions deploy council
supabase secrets set OPENROUTER_API_KEY=sk-or-...
```

Get an OpenRouter key at https://openrouter.ai/keys and add credits (avoid tiny
top-ups — there's a ~5.5% fee on card purchases with an $0.80 minimum).

Before going live, verify the six model slugs in `index.ts` against
https://openrouter.ai/models — they occasionally pick up date suffixes.

## 2. Run the frontend

```bash
npm install
cp .env.example .env     # fill in your function URL + anon key
npm run dev
```

With no `.env`, the app starts in **demo mode** and renders sample data so you can
see the UI immediately. Set `VITE_COUNCIL_ENDPOINT` to go live; untick "Demo data".

## How the council decides

Each query flows through three mechanisms (tunable in the `CONFIG` block of
`index.ts`):

1. **Router** — a cheap model (GPT-5 Nano) classifies the query. Simple ones are
   answered by a single model (Grok 4.3) and skip the council entirely,
   concentrating spend on hard questions.
2. **Adaptive debate** — after round 1, an objective disagreement score (confidence
   spread + answer divergence) decides whether members run a second "critique &
   revise" round. You pay the ~2× for debate only when the council is split.
3. **Domain-weighted orchestration** — the router's domain tag and each advisor's
   declared strengths are passed to the orchestrator so it weights the relevant
   voices rather than counting votes equally.

The response includes `mode` (solo/council), `route`, `disagreement` (objective,
0-100), `debated`, `rounds`, and a per-stage `cost` breakdown.

## Cost

Roughly **$0.04 per query** at current OpenRouter prices (five members + orchestrator,
with member outputs capped). Every response includes a real cost breakdown computed
from OpenRouter's token usage, so you can watch actual spend.

The orchestrator is the largest single line because it ingests every member's output —
keep member `max_tokens` low (set in `index.ts`) to bound it.

## History

Every successful run is saved locally to `localStorage` (key `council:history`,
capped at 50 entries) — no database, no network. Open the **History** panel in the
header to re-open a past result or delete entries. History is per-browser and clears
if you clear site data; it won't sync across devices (that would need a backend).

## Notes / next steps

- `agreement` is the orchestrator's self-report; `disagreement` is the objective
  metric computed in `index.ts`. Watch both — large gaps between them are a signal
  the orchestrator is mis-reading the panel.
- Members run independently in round 1 (no cross-talk) to preserve diversity; the
  debate round is the only time they see each other, and only when split.
- Tune `CONFIG.debateThreshold` against your own queries — lower means more debates
  (higher quality, higher cost).
- Tighten `Access-Control-Allow-Origin` in `index.ts` from `*` to your domain, and
  set a real `HTTP-Referer`/`X-Title` for OpenRouter's app rankings.
