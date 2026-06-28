import { useState } from "react";
import { DARK, LIGHT, toCssVars } from "./lib/themes";
import { useCouncil, HAS_ENDPOINT, COUNCIL_ENDPOINT } from "./hooks/useCouncil";
import { useHistory } from "./hooks/useHistory";
import CouncilResult from "./components/CouncilResult";

const MEMBERS = ["kimi", "deepseek", "gemini 3.1 pro", "glm 5.2"];
const ANCHOR = "grok 4.3";
const ORCHESTRATOR = "gpt-5";

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function App() {
  const [dark, setDark] = useState(true);
  const [question, setQuestion] = useState("");
  const [demo, setDemo] = useState(!HAS_ENDPOINT);
  const [showHistory, setShowHistory] = useState(false);
  const { ask, show, loading, error, result } = useCouncil();
  const history = useHistory();

  const rootVars = toCssVars(dark ? DARK : LIGHT);
  const usingDemo = demo || !HAS_ENDPOINT;

  async function submit() {
    const q = question.trim();
    if (!q) return;
    const r = await ask(q, { demo: usingDemo });
    if (r) history.add(q, r); // persist successful runs locally
  }
  function onKey(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
  }
  function openEntry(entry) {
    setQuestion(entry.question);
    show(entry.result);
    setShowHistory(false);
  }

  return (
    <div className="council-app" style={rootVars}>
      <div className="ca-shell">
        <header className="ca-header">
          <div>
            <div className="ca-title">LLM Council</div>
            <div className="ca-sub">Three advisors deliberate · an anchor sets the baseline · one orchestrator decides</div>
          </div>
          <div className="ca-header-actions">
            <button className="ca-theme" onClick={() => setShowHistory((s) => !s)} aria-pressed={showHistory}>
              History{history.entries.length ? ` (${history.entries.length})` : ""}
            </button>
            <button className="ca-theme" onClick={() => setDark((d) => !d)} aria-label="Toggle theme">
              {dark ? "Light" : "Dark"}
            </button>
          </div>
        </header>

        <div className="ca-roster">
          {MEMBERS.map((m) => <span key={m} className="ca-chip">{m}</span>)}
          <span className="ca-chip ca-chip-anchor">{ANCHOR} · anchor</span>
          <span className="ca-chip ca-chip-orch">{ORCHESTRATOR} · orchestrator</span>
        </div>

        {showHistory && (
          <div className="ca-history">
            <div className="ca-history-head">
              <span className="ca-history-title">History</span>
              {history.entries.length > 0 && (
                <button className="ca-history-clear" onClick={history.clear}>Clear all</button>
              )}
            </div>
            {history.entries.length === 0 ? (
              <p className="ca-history-empty">No past questions yet. Saved locally in your browser.</p>
            ) : (
              <ul className="ca-history-list">
                {history.entries.map((e) => (
                  <li key={e.id} className="ca-history-item">
                    <button className="ca-history-open" onClick={() => openEntry(e)}>
                      <span className="ca-history-q">{e.question}</span>
                      <span className="ca-history-meta">
                        {e.result?.mode === "solo" ? "solo" : "council"} · {timeAgo(e.ts)}
                      </span>
                    </button>
                    <button className="ca-history-del" onClick={() => history.remove(e.id)} aria-label="Delete">✕</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="ca-ask">
          <textarea
            className="ca-input"
            placeholder="Ask the council a question…"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={onKey}
            rows={3}
          />
          <div className="ca-ask-row">
            <div className="ca-status">
              {HAS_ENDPOINT ? (
                <label className="ca-check">
                  <input type="checkbox" checked={demo} onChange={(e) => setDemo(e.target.checked)} />
                  <span>Demo data</span>
                </label>
              ) : (
                <span className="ca-status-note">No endpoint set · demo data</span>
              )}
            </div>
            <button className="ca-ask-btn" onClick={submit} disabled={loading || !question.trim()}>
              {loading ? "Deliberating…" : "Ask"}
            </button>
          </div>
          {HAS_ENDPOINT && !demo && <p className="ca-note">Live · {COUNCIL_ENDPOINT}</p>}
        </div>

        {error && <div className="ca-error">{error}</div>}

        {(loading || result) && (
          <div className="ca-result">
            <CouncilResult result={result} loading={loading} />
          </div>
        )}
      </div>
    </div>
  );
}
