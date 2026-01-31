import { createEvolveRulesStore } from "./evolveRules.js";

function _safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function _safeStr(v, fallback = "") {
  const s = String(v ?? "").trim();
  return s ? s : fallback;
}

function _normRisk(v) {
  const s = String(v ?? "safe").trim().toLowerCase();
  return (s === "safe" || s === "medium" || s === "degen") ? s : "safe";
}

export function createAgentOutcomesStore({
  storageKey = "fdv_agent_outcomes_v1",
  summaryKey = "fdv_agent_evolve_summary_v1",
  rulesKey = "fdv_agent_evolve_rules_v1",
  rulesPromoteEveryMs = 10 * 60_000,
  rulesMinRepeats = 3,
  rulesMaxPromote = 2,
  rulesMaxLines = 6,
  summaryWindow = 30,
  maxEntries = 120,
  cacheMs = 5000,
  nowFn = () => Date.now(),
  getSessionPnlSol = () => null,
  getAgentRisk = () => "safe",
} = {}) {
  const key = _safeStr(storageKey, "fdv_agent_outcomes_v1");
  const sumKey = _safeStr(summaryKey, "fdv_agent_evolve_summary_v1");
  const rulesStoreKey = _safeStr(rulesKey, "fdv_agent_evolve_rules_v1");
  const sumWindow = Math.max(10, Math.min(200, Math.floor(_safeNum(summaryWindow, 30))));
  const cap = Math.max(10, Math.min(1000, Math.floor(_safeNum(maxEntries, 120))));
  const cacheTtl = Math.max(250, Math.min(60_000, Math.floor(_safeNum(cacheMs, 5000))));
  const promoteEveryMs = Math.max(0, Math.min(7 * 24 * 60 * 60_000, Math.floor(_safeNum(rulesPromoteEveryMs, 10 * 60_000))));
  const promoteMinRepeats = Math.max(2, Math.min(10, Math.floor(_safeNum(rulesMinRepeats, 3))));
  const promoteMaxN = Math.max(1, Math.min(5, Math.floor(_safeNum(rulesMaxPromote, 2))));
  const promptMaxLines = Math.max(0, Math.min(12, Math.floor(_safeNum(rulesMaxLines, 6))));

  const rules = createEvolveRulesStore({ storageKey: rulesStoreKey });
  const rulesPromoteAtKey = `fdv_agent_evolve_rules_promote_at_v1:${rulesStoreKey}`;

  let _cache = { ts: 0, list: [] };

  function _readPromoteAt() {
    try {
      const raw = localStorage.getItem(rulesPromoteAtKey);
      return _safeNum(raw, 0);
    } catch {
      return 0;
    }
  }

  function _writePromoteAt(ts) {
    try {
      localStorage.setItem(rulesPromoteAtKey, String(_safeNum(ts, 0)));
    } catch {}
  }

  function _readRaw() {
    const ts = nowFn();
    if (_cache && (ts - _safeNum(_cache.ts, 0)) < cacheTtl) return Array.isArray(_cache.list) ? _cache.list : [];

    try {
      const raw = localStorage.getItem(key);
      if (!raw) {
        _cache = { ts, list: [] };
        return [];
      }
      const json = JSON.parse(raw);
      const list = Array.isArray(json) ? json : [];
      _cache = { ts, list };
      return list;
    } catch {
      _cache = { ts, list: [] };
      return [];
    }
  }

  function _writeRaw(list) {
    try {
      const arr = Array.isArray(list) ? list : [];
      const capped = arr.slice(0, cap);
      localStorage.setItem(key, JSON.stringify(capped));
      _cache = { ts: nowFn(), list: capped };
    } catch {}
  }

  function _writeSummary(obj) {
    try {
      localStorage.setItem(sumKey, JSON.stringify(obj));
    } catch {}
  }

  function _buildRollingSummary(list, rulesText = "") {
    try {
      const arr = Array.isArray(list) ? list : [];
      const win = (x) => {
        try { return Number(x?.pnlSol ?? 0) > 0; } catch { return false; }
      };
      const take = arr.slice(0, sumWindow);
      const n = take.length;
      if (!n) {
        return {
          ts: Date.now(),
          n: 0,
          winRate: null,
          avgPnlSol: null,
          text: "EVOLVE: no outcomes recorded yet.",
          payload: {
            v: 1,
            stats: { n: 0, winRate: null, avgPnlSol: null, best: null, worst: null, pendingCritiques: 0 },
            todo: null,
            rules: [],
          },
        };
      }

      let wins = 0;
      let sum = 0;
      let best = -Infinity;
      let worst = Infinity;
      const crits = [];
      const lessons = [];
      let todo = null;
      let todoCount = 0;
      for (const it of take) {
        const pnl = _safeNum(it?.pnlSol, 0);
        sum += pnl;
        if (win(it)) wins++;
        if (pnl > best) best = pnl;
        if (pnl < worst) worst = pnl;
        const sc = _safeStr(it?.selfCritique, "");
        if (sc) crits.push(sc);

        const ls = _safeStr(it?.lesson, "");
        if (ls) lessons.push(ls);

        // Pick ONE concrete reflection TODO to avoid per-trade reflection cost.
        // This is intentionally biased toward negative agent outcomes.
        const needsCritique = (
          _safeStr(it?.decisionSource, "") === "agent" &&
          !sc &&
          _safeNum(it?.pnlSol, 0) < 0
        );
        if (needsCritique) {
          todoCount++;
          if (!todo) {
            todo = {
              outcomeTs: _safeNum(it?.ts, 0),
              mint: _safeStr(it?.mint, ""),
              kind: _safeStr(it?.kind, ""),
              pnlSol: _safeNum(it?.pnlSol, 0),
              decisionAction: _safeStr(it?.decisionAction, ""),
              reason: _safeStr(it?.reason, ""),
            };
          }
        }
      }
      const winRate = wins / Math.max(1, n);
      const avgPnlSol = sum / Math.max(1, n);


      const todoObj = todo
        ? {
          outcomeTs: _safeNum(todo.outcomeTs, 0) || null,
          mint: _safeStr(todo.mint, "").slice(0, 44) || null,
          mint8: _safeStr(todo.mint, "").slice(0, 8) || null,
          kind: _safeStr(todo.kind, "").slice(0, 24) || null,
          pnlSol: _safeNum(todo.pnlSol, 0),
          decisionAction: _safeStr(todo.decisionAction, "").slice(0, 24) || null,
          reason: _safeStr(todo.reason, "").slice(0, 160) || null,
        }
        : null;

      // Provide BOTH a structured payload (preferred) and a tiny prompt string (compat/debug).
      const prompt = (
        `EVOLVE stats n=${n} winRate=${(100 * winRate).toFixed(0)}% avgPnlSol=${avgPnlSol.toFixed(4)} ` +
        `best=${Number.isFinite(best) ? best.toFixed(4) : "0.0000"} worst=${Number.isFinite(worst) ? worst.toFixed(4) : "0.0000"} ` +
        `pendingCritiques=${todoCount}` +
        (todoObj ? ` todo={outcomeTs:${todoObj.outcomeTs},mint:'${todoObj.mint8}',kind:'${todoObj.kind}',pnlSol:${todoObj.pnlSol.toFixed(4)}}` : "")
      ).slice(0, 520);

      const text = [
        `EVOLVE: last ${n} outcomes: winRate=${(100 * winRate).toFixed(0)}% avgPnlSol=${avgPnlSol.toFixed(4)} best=${Number.isFinite(best) ? best.toFixed(4) : "0.0000"} worst=${Number.isFinite(worst) ? worst.toFixed(4) : "0.0000"}`,
        (todoCount > 0) ? `EVOLVE: pendingCritiques=${todoCount} (batch; do not reflect every trade)` : `EVOLVE: pendingCritiques=0`,
        todoObj ? `EVOLVE TODO: outcomeTs=${todoObj.outcomeTs} mint=${todoObj.mint8}… kind=${todoObj.kind} pnlSol=${todoObj.pnlSol.toFixed(4)} action=${todoObj.decisionAction || "?"} reason=${String(todoObj.reason || "").slice(0, 120)}` : "EVOLVE TODO: none",
        rulesText ? String(rulesText) : "EVOLVE RULES: none yet (auto-promotes from repeated lessons).",
      ].join("\n");

      return {
        ts: Date.now(),
        n,
        winRate,
        avgPnlSol,
        best,
        worst,
        pendingCritiques: todoCount,
        todo: todoObj,
        prompt,
        text: String(text || "").slice(0, 1600),
        payload: {
          v: 1,
          stats: {
            n,
            winRate,
            avgPnlSol,
            best: Number.isFinite(best) ? best : null,
            worst: Number.isFinite(worst) ? worst : null,
            pendingCritiques: todoCount,
          },
          todo: todoObj,
        },
      };
    } catch {
      return { ts: Date.now(), n: 0, winRate: null, avgPnlSol: null, text: "EVOLVE: summary unavailable." };
    }
  }

  function refreshSummary() {
    try {
      const list = _readRaw();

      // Local-only: periodically promote repeated lessons into stable rules.
      try {
        const t = nowFn();
        if (promoteEveryMs > 0) {
          const last = _readPromoteAt();
          if (!last || (t - last) >= promoteEveryMs) {
            rules.promoteFromOutcomes(list, { minRepeats: promoteMinRepeats, maxPromote: promoteMaxN });
            _writePromoteAt(t);
          }
        }
      } catch {}

      const rulesText = rules.toPromptText({ maxLines: promptMaxLines });
      const summary = _buildRollingSummary(list, rulesText);

      // Also attach structured rules (for better LLM consumption).
      try {
        const ruleList = rules.readAll().slice(0, promptMaxLines).map((r) => ({
          text: _safeStr(r?.text, "").slice(0, 180),
          hits: _safeNum(r?.hitCount, 0),
          updatedAt: _safeNum(r?.updatedAt, 0) || null,
        })).filter((r) => r.text);
        if (summary && typeof summary === "object") {
          if (!summary.payload || typeof summary.payload !== "object") summary.payload = { v: 1 };
          summary.payload.rules = ruleList;
        }
      } catch {}

      _writeSummary(summary);
      return summary;
    } catch {
      const summary = { ts: Date.now(), n: 0, winRate: null, avgPnlSol: null, text: "EVOLVE: summary unavailable." };
      _writeSummary(summary);
      return summary;
    }
  }

  function annotateByTs(ts, patch = {}) {
    try {
      const t = _safeNum(ts, 0);
      if (!t) return false;
      const list0 = _readRaw();
      const list = Array.isArray(list0) ? list0.slice() : [];
      let changed = false;
      for (let i = 0; i < list.length; i++) {
        const it = list[i];
        if (!it || typeof it !== "object") continue;
        if (_safeNum(it.ts, 0) !== t) continue;
        const next = { ...it };
        if ("selfCritique" in patch) next.selfCritique = String(patch.selfCritique || "").slice(0, 220);
        if ("lesson" in patch) next.lesson = String(patch.lesson || "").slice(0, 220);
        next.critiqueAt = Date.now();
        list[i] = next;
        changed = true;
        break;
      }
      if (changed) {
        _writeRaw(list);
        refreshSummary();
      }
      return changed;
    } catch {
      return false;
    }
  }

  function applyEvolve(evolve) {
    try {
      if (!evolve || typeof evolve !== "object") return false;
      const outcomeTs = _safeNum(evolve.outcomeTs, 0);
      if (!outcomeTs) return false;
      const patch = {
        selfCritique: ("selfCritique" in evolve) ? String(evolve.selfCritique || "") : undefined,
        lesson: ("lesson" in evolve) ? String(evolve.lesson || "") : undefined,
      };
      // Only keep known keys; avoid writing undefined.
      const clean = {};
      if (typeof patch.selfCritique === "string") clean.selfCritique = patch.selfCritique;
      if (typeof patch.lesson === "string") clean.lesson = patch.lesson;
      return annotateByTs(outcomeTs, clean);
    } catch {
      return false;
    }
  }

  function summarize(limit = 8) {
    try {
      const list = _readRaw();
      const out = [];
      const take = Math.max(1, Math.min(50, limit | 0));
      for (const it of list) {
        if (!it || typeof it !== "object") continue;
        out.push({
          ts: _safeNum(it.ts, 0),
          mint: _safeStr(it.mint, ""),
          kind: _safeStr(it.kind, ""),
          pnlSol: _safeNum(it.pnlSol, 0),
          proceedsSol: _safeNum(it.proceedsSol, 0),
          costSold: _safeNum(it.costSold, 0),
          decisionSource: _safeStr(it.decisionSource, ""),
          decisionAction: _safeStr(it.decisionAction, ""),
          reason: String(it.reason || "").slice(0, 160),
        });
        if (out.length >= take) break;
      }
      return out;
    } catch {
      return [];
    }
  }

  function lastForMint(mint) {
    try {
      const m = _safeStr(mint, "");
      if (!m) return null;
      const list = _readRaw();
      for (const it of list) {
        if (it && _safeStr(it.mint, "") === m) return it;
      }
    } catch {}
    return null;
  }

  function record(evt) {
    try {
      const mint = _safeStr(evt?.mint, "");
      if (!mint) return;

      const proceedsSol = _safeNum(evt?.proceedsSol, 0);
      const costSold = _safeNum(evt?.costSold, 0);
      const pnlSol = _safeNum(("pnlSol" in (evt || {})) ? evt.pnlSol : (proceedsSol - costSold), proceedsSol - costSold);
      const kind = _safeStr(evt?.kind, "sell");
      const label = _safeStr(evt?.label, "");

      const d = evt?.decision || null;
      const decisionAction = _safeStr(d?.action, "");
      const reason = _safeStr(d?.reason, "");
      const decisionSource = /^agent-/i.test(reason) ? "agent" : "system";

      const entry = {
        ts: Date.now(),
        nowTs: _safeNum(evt?.nowTs, 0),
        mint,
        kind,
        label,
        proceedsSol,
        costSold,
        pnlSol,
        pnlPct: (costSold > 0) ? (100 * (pnlSol / costSold)) : null,
        decisionSource,
        decisionAction,
        reason,
        agentRisk: _normRisk(getAgentRisk()),
        selfCritique: null,
        lesson: null,
        sessionPnlSol: (() => {
          try {
            const v = getSessionPnlSol();
            const n = Number(v);
            return Number.isFinite(n) ? n : null;
          } catch {
            return null;
          }
        })(),
      };

      const list0 = _readRaw();
      const list = Array.isArray(list0) ? list0.slice() : [];
      list.unshift(entry);
      _writeRaw(list);
      refreshSummary();
      return entry;
    } catch {}
    return null;
  }

  function clear() {
    try {
      localStorage.removeItem(key);
    } catch {}
    _cache = { ts: nowFn(), list: [] };
  }

  return {
    key,
    summaryKey: sumKey,
    record,
    summarize,
    lastForMint,
    annotateByTs,
    applyEvolve,
    readAll: _readRaw,
    refreshSummary,
    clear,
  };
}
