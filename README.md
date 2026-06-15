# LLM Council

A multi-model "council": five member models answer a question independently and in
parallel via [OpenRouter](https://openrouter.ai), then a single orchestrator model
synthesizes their verdicts into one final answer with an agreement score, points of
consensus, and points of dissent.

Roster (edit in `supabase/functions/council/index.ts`):

| Role | Model |
|------|-------|
| Member | Kimi K2.7 Code |
| Member | Qwen 3.7 Plus |
| Member | DeepSeek V4 Pro |
| Member | Gemini 3.1 Flash Lite |
| Member | GPT-5 Mini |
| Orchestrator | Grok 4.3 |

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

## Cost

Roughly **$0.04 per query** at current OpenRouter prices (five members + orchestrator,
with member outputs capped). Every response includes a real cost breakdown computed
from OpenRouter's token usage, so you can watch actual spend.

The orchestrator is the largest single line because it ingests every member's output —
keep member `max_tokens` low (set in `index.ts`) to bound it.

## Notes / next steps

- `agreement` is the orchestrator's own judgment, not a computed metric. For an
  objective number, derive it from the spread of member confidences and answer
  similarity in `index.ts`.
- Members run independently (no cross-talk) to preserve diversity. A "debate" round
  where members see each other roughly doubles cost.
- Tighten `Access-Control-Allow-Origin` in `index.ts` from `*` to your domain, and
  set a real `HTTP-Referer`/`X-Title` for OpenRouter's app rankings.
