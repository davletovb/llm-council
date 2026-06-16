import { useState } from "react";

/**
 * Renders the structured output of runCouncil():
 *   { finalAnswer, agreement, consensus[], dissent[], verdicts[], failures[], cost }
 * Reads CSS variables set on an ancestor (see App.jsx -> toCssVars).
 */

function agreementHue(score) {
  if (score >= 75) return { color: "#4ec9a8", label: "Strong consensus" };
  if (score >= 50) return { color: "#d8b46a", label: "Leaning aligned" };
  if (score >= 25) return { color: "#d98a5b", label: "Divided" };
  return { color: "#d96a6a", label: "No consensus" };
}

export default function CouncilResult({ result, loading = false }) {
  const [openVerdicts, setOpenVerdicts] = useState(false);

  if (loading) {
    return <div className="council-card council-pulse" aria-busy="true">Council deliberating…</div>;
  }
  if (!result) return null;

  const {
    finalAnswer, agreement = 0, consensus = [], dissent = [], verdicts = [], failures = [], cost,
    mode, route, disagreement, debated, rounds, anchor,
  } = result;
  const hue = agreementHue(agreement);
  const isSolo = mode === "solo";

  return (
    <div className="council">
      {(mode || route) && (
        <div className="council-meta">
          {mode && <span className={`council-tag ${isSolo ? "council-tag-solo" : "council-tag-council"}`}>{isSolo ? "solo model" : "full council"}</span>}
          {route?.domain && <span className="council-tag">{route.domain}</span>}
          {debated && <span className="council-tag">debated · {rounds} rounds</span>}
        </div>
      )}

      <div className="council-card">
        <div className="council-eyebrow">{isSolo ? "Answer" : "Council verdict"}</div>
        <div className="council-answer">{finalAnswer}</div>
      </div>

      {!isSolo && (
        <div className="council-meter-row">
          <div className="council-meter-head">
            <span className="council-meter-label" style={{ color: hue.color }}>{hue.label}</span>
            <span className="council-meter-value">{agreement}<span className="council-meter-pct">/100</span></span>
          </div>
          <div className="council-meter-track" role="meter" aria-valuenow={agreement} aria-valuemin={0} aria-valuemax={100} aria-label="Council agreement">
            <div className="council-meter-fill" style={{ width: `${agreement}%`, background: hue.color }} />
          </div>
          {typeof disagreement === "number" && (
            <div className="council-meter-sub">
              objective disagreement {disagreement}/100 — {debated ? "triggered a debate round" : "below debate threshold"}
            </div>
          )}
        </div>
      )}

      {!isSolo && anchor && (
        <div className="council-baseline">
          <span className="council-baseline-tag">anchor baseline · {anchor.id}</span>
          <span className="council-baseline-text">{anchor.answer}</span>
        </div>
      )}

      {consensus.length > 0 && (
        <div className="council-block">
          <h4 className="council-block-title">Agreed on</h4>
          <ul className="council-list">
            {consensus.map((point, i) => <li key={i} className="council-li council-li-agree">{point}</li>)}
          </ul>
        </div>
      )}

      {dissent.length > 0 && (
        <div className="council-block">
          <h4 className="council-block-title">Diverged</h4>
          <ul className="council-list">
            {dissent.map((d, i) => (
              <li key={i} className="council-li council-li-dissent">
                <span className="council-advisor">{d.advisor}</span>{d.point}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="council-block">
        <button className="council-toggle" onClick={() => setOpenVerdicts((v) => !v)} aria-expanded={openVerdicts}>
          {openVerdicts ? "Hide" : "Show"} advisor verdicts ({verdicts.length})
        </button>
        {openVerdicts && (
          <div className="council-verdicts">
            {verdicts.map((v) => (
              <div key={v.id} className="council-verdict">
                <div className="council-verdict-head">
                  <span className="council-verdict-id">{v.id}</span>
                  <span className="council-verdict-conf">{v.confidence}/100</span>
                </div>
                <div className="council-verdict-answer">{v.answer}</div>
                {v.rationale && <div className="council-verdict-rationale">{v.rationale}</div>}
              </div>
            ))}
          </div>
        )}
      </div>

      {failures.length > 0 && (
        <div className="council-failures">
          {failures.length} advisor{failures.length > 1 ? "s" : ""} didn't respond ({failures.map((f) => f.id).join(", ")}) — verdict drawn from the rest.
        </div>
      )}

      {cost && (
        <div className="council-cost">
          {typeof cost.router === "number" && <span>router ${cost.router.toFixed(4)}</span>}
          <span>members ${cost.members.toFixed(4)}</span>
          {typeof cost.anchor === "number" && <span>anchor ${cost.anchor.toFixed(4)}</span>}
          <span>orchestrator ${cost.orchestrator.toFixed(4)}</span>
          <span className="council-cost-total">total ${cost.total.toFixed(4)}</span>
        </div>
      )}
    </div>
  );
}
