import { useState } from "react";
import { DARK, LIGHT, toCssVars } from "./lib/themes";
import { useCouncil, HAS_ENDPOINT, COUNCIL_ENDPOINT } from "./hooks/useCouncil";
import CouncilResult from "./components/CouncilResult";

const MEMBERS = ["kimi", "qwen", "deepseek", "gemini", "gpt"];
const ORCHESTRATOR = "grok";

export default function App() {
  const [dark, setDark] = useState(true);
  const [question, setQuestion] = useState("");
  // Demo defaults on only when there's no configured endpoint.
  const [demo, setDemo] = useState(!HAS_ENDPOINT);
  const { ask, loading, error, result } = useCouncil();

  const rootVars = toCssVars(dark ? DARK : LIGHT);
  const usingDemo = demo || !HAS_ENDPOINT;

  function submit() {
    ask(question, { demo: usingDemo });
  }
  function onKey(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
  }

  return (
    <div className="council-app" style={rootVars}>
      <div className="ca-shell">
        <header className="ca-header">
          <div>
            <div className="ca-title">LLM Council</div>
            <div className="ca-sub">Five advisors deliberate · one orchestrator decides</div>
          </div>
          <button className="ca-theme" onClick={() => setDark((d) => !d)} aria-label="Toggle theme">
            {dark ? "Light" : "Dark"}
          </button>
        </header>

        <div className="ca-roster">
          {MEMBERS.map((m) => <span key={m} className="ca-chip">{m}</span>)}
          <span className="ca-chip ca-chip-orch">{ORCHESTRATOR} · orchestrator</span>
        </div>

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
          {HAS_ENDPOINT && !demo && (
            <p className="ca-note">Live · {COUNCIL_ENDPOINT}</p>
          )}
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
