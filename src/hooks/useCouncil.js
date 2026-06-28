import { useState, useCallback } from "react";
import { DEMO_RESULT } from "../lib/demoData";

// Config comes from Vite env vars (see .env.example). The OpenRouter key is NOT here
// — it lives only inside the Edge Function. These just point the app at that function.
const ENDPOINT = import.meta.env.VITE_COUNCIL_ENDPOINT || "";
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "";

export const HAS_ENDPOINT = Boolean(ENDPOINT);
export const COUNCIL_ENDPOINT = ENDPOINT;

export function useCouncil() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const ask = useCallback(async (question, { demo = false } = {}) => {
    const q = (question || "").trim();
    if (!q) return;

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      if (demo || !ENDPOINT) {
        await new Promise((r) => setTimeout(r, 1100)); // simulate latency
        setResult(DEMO_RESULT);
        return DEMO_RESULT;
      }

      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(ANON_KEY ? { Authorization: `Bearer ${ANON_KEY}` } : {}),
        },
        body: JSON.stringify({ question: q }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Council endpoint returned ${res.status}: ${text.slice(0, 160)}`);
      }

      const data = await res.json();
      if (data?.error) throw new Error(data.error);
      setResult(data);
      return data;
    } catch (e) {
      setError(String(e?.message || e));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  // Display a result we already have (e.g. one selected from history).
  const show = useCallback((r) => {
    setResult(r);
    setError(null);
    setLoading(false);
  }, []);

  const reset = useCallback(() => {
    setResult(null);
    setError(null);
  }, []);

  return { ask, reset, show, loading, error, result };
}
