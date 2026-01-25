function _safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function _safeStr(v, fallback = "") {
  const s = String(v ?? "").trim();
  return s ? s : fallback;
}

function _canonLesson(s) {
  try {
    let t = _safeStr(s, "");
    if (!t) return "";

    t = t.toLowerCase();

    // Normalize common noise: mints/addresses + numbers/amounts.
    t = t.replace(/[1-9a-hj-np-z]{32,44}/gi, "<MINT>");
    t = t.replace(/\b\d+(?:\.\d+)?\s*(?:sol|usd|bps|%|pct|seconds?|secs?|ms|mins?|minutes?)\b/gi, "<NUM>");
    t = t.replace(/\b\d+(?:\.\d+)?\b/g, "<NUM>");

    // Normalize punctuation/whitespace.
    t = t.replace(/[^a-z0-9<>\s-]/g, " ");
    t = t.replace(/\s+/g, " ").trim();

    return t.slice(0, 220);
  } catch {
    return "";
  }
}

function _formatRuleTextFromLesson(lesson) {
  const t = _safeStr(lesson, "").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, 180) : "";
}

export function createEvolveRulesStore({
  storageKey = "fdv_agent_evolve_rules_v1",
  maxRules = 12,
  cacheMs = 5000,
  nowFn = () => Date.now(),
} = {}) {
  const key = _safeStr(storageKey, "fdv_agent_evolve_rules_v1");
  const cap = Math.max(3, Math.min(50, Math.floor(_safeNum(maxRules, 12))));
  const cacheTtl = Math.max(250, Math.min(60_000, Math.floor(_safeNum(cacheMs, 5000))));

  let _cache = { ts: 0, list: [] };

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

  function readAll() {
    return _readRaw();
  }

  function clear() {
    try { localStorage.removeItem(key); } catch {}
    _cache = { ts: nowFn(), list: [] };
  }

  function _upsertRule({ canonKey, text, outcomeTs = 0, hitInc = 1 } = {}) {
    try {
      const ck = _safeStr(canonKey, "");
      const tx = _safeStr(text, "");
      if (!ck || !tx) return false;

      const list0 = _readRaw();
      const list = Array.isArray(list0) ? list0.slice() : [];
      const at = nowFn();

      const idx = list.findIndex((r) => r && typeof r === "object" && _safeStr(r.canonKey, "") === ck);
      if (idx >= 0) {
        const prev = list[idx] || {};
        list[idx] = {
          ...prev,
          canonKey: ck,
          text: tx,
          hitCount: _safeNum(prev.hitCount, 0) + Math.max(1, _safeNum(hitInc, 1)),
          updatedAt: at,
          lastOutcomeTs: Math.max(_safeNum(prev.lastOutcomeTs, 0), _safeNum(outcomeTs, 0)),
        };
      } else {
        list.unshift({
          canonKey: ck,
          text: tx,
          hitCount: Math.max(1, _safeNum(hitInc, 1)),
          createdAt: at,
          updatedAt: at,
          lastOutcomeTs: _safeNum(outcomeTs, 0),
        });
      }

      list.sort((a, b) => {
        const ah = _safeNum(a?.hitCount, 0);
        const bh = _safeNum(b?.hitCount, 0);
        if (ah !== bh) return bh - ah;
        return _safeNum(b?.updatedAt, 0) - _safeNum(a?.updatedAt, 0);
      });

      _writeRaw(list);
      return true;
    } catch {
      return false;
    }
  }

  function promoteFromOutcomes(outcomes, {
    minRepeats = 3,
    maxPromote = 2,
  } = {}) {
    try {
      const arr = Array.isArray(outcomes) ? outcomes : [];
      if (!arr.length) return { promoted: 0 };

      const minN = Math.max(2, Math.min(10, Math.floor(_safeNum(minRepeats, 3))));
      const maxN = Math.max(1, Math.min(5, Math.floor(_safeNum(maxPromote, 2))));

      const counts = new Map();
      const exemplar = new Map();
      const lastTs = new Map();

      for (const it of arr) {
        const lesson = _safeStr(it?.lesson, "");
        if (!lesson) continue;

        const canon = _canonLesson(lesson);
        if (!canon) continue;

        counts.set(canon, _safeNum(counts.get(canon), 0) + 1);
        if (!exemplar.has(canon)) exemplar.set(canon, lesson);
        lastTs.set(canon, Math.max(_safeNum(lastTs.get(canon), 0), _safeNum(it?.ts, 0)));
      }

      const ranked = Array.from(counts.entries())
        .filter(([, c]) => c >= minN)
        .sort((a, b) => b[1] - a[1])
        .slice(0, maxN);

      let promoted = 0;
      for (const [canonKey, c] of ranked) {
        const txt = _formatRuleTextFromLesson(exemplar.get(canonKey));
        if (!txt) continue;

        // Avoid promoting ultra-short / low signal rules.
        if (txt.length < 18) continue;

        if (_upsertRule({ canonKey, text: txt, outcomeTs: _safeNum(lastTs.get(canonKey), 0), hitInc: c })) promoted++;
      }

      return { promoted };
    } catch {
      return { promoted: 0 };
    }
  }

  function toPromptText({ maxLines = 6 } = {}) {
    try {
      const n = Math.max(0, Math.min(12, Math.floor(_safeNum(maxLines, 6))));
      const list = _readRaw();
      const take = list.slice(0, n);
      if (!take.length) return "";

      const lines = take.map((r) => {
        const text = _safeStr(r?.text, "").slice(0, 160);
        const hc = _safeNum(r?.hitCount, 0);
        return `- ${text}${hc > 0 ? ` (hits=${hc})` : ""}`;
      });

      return [
        "EVOLVE RULES (stable; follow these):",
        ...lines,
      ].join("\n");
    } catch {
      return "";
    }
  }

  return {
    key,
    readAll,
    clear,
    promoteFromOutcomes,
    toPromptText,
  };
}
