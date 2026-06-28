import { useState, useCallback, useEffect } from "react";

// Local-only history of council runs, persisted to browser localStorage.
// No database, no network. Capped so it can't grow unbounded.

const KEY = "council:history";
const MAX_ENTRIES = 50;

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // private mode, corrupt data, etc. — start empty
  }
}

export function useHistory() {
  const [entries, setEntries] = useState(load);

  // Persist on every change. Failures (quota / private mode) are non-fatal —
  // history just won't survive a reload.
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(entries));
    } catch {
      /* ignore */
    }
  }, [entries]);

  const add = useCallback((question, result) => {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      question,
      result,
      ts: Date.now(),
    };
    setEntries((prev) => [entry, ...prev].slice(0, MAX_ENTRIES));
  }, []);

  const remove = useCallback((id) => setEntries((prev) => prev.filter((e) => e.id !== id)), []);
  const clear = useCallback(() => setEntries([]), []);

  return { entries, add, remove, clear };
}
