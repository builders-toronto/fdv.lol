import { TRAINING_CAPTURE } from "../config/env.js";

function now() {
	return Date.now();
}

const DB_NAME = "fdv_training_v1";
const DB_STORE = "captures";
const DB_VERSION = 1;

function _hasIndexedDb() {
	try {
		return typeof indexedDB !== "undefined" && !!indexedDB;
	} catch {
		return false;
	}
}

function _openDb() {
	return new Promise((resolve, reject) => {
		try {
			if (!_hasIndexedDb()) return resolve(null);
			const req = indexedDB.open(DB_NAME, DB_VERSION);
			req.onupgradeneeded = () => {
				try {
					const db = req.result;
					if (!db.objectStoreNames.contains(DB_STORE)) {
						const store = db.createObjectStore(DB_STORE, { keyPath: "id", autoIncrement: true });
						store.createIndex("by_storageKey_ts", ["storageKey", "ts"], { unique: false });
						store.createIndex("by_storageKey", "storageKey", { unique: false });
						store.createIndex("by_ts", "ts", { unique: false });
					}
				} catch {}
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error || new Error("indexedDB open failed"));
		} catch (e) {
			reject(e);
		}
	});
}

async function _idbAddCapture(rec) {
	const db = await _openDb();
	if (!db) return { ok: false, skipped: true, why: "no_indexeddb" };
	return await new Promise((resolve) => {
		try {
			const tx = db.transaction(DB_STORE, "readwrite");
			const store = tx.objectStore(DB_STORE);
			store.add(rec);
			tx.oncomplete = () => {
				try { db.close(); } catch {}
				resolve({ ok: true });
			};
			tx.onerror = () => {
				try { db.close(); } catch {}
				resolve({ ok: false, err: String(tx.error || "idb_tx_error") });
			};
		} catch (e) {
			try { db.close(); } catch {}
			resolve({ ok: false, err: String(e?.message || e || "idb_error") });
		}
	});
}

async function _idbGetAllByKey(storageKey) {
	const db = await _openDb();
	if (!db) return null;
	return await new Promise((resolve) => {
		try {
			const tx = db.transaction(DB_STORE, "readonly");
			const store = tx.objectStore(DB_STORE);
			const idx = store.index("by_storageKey");
			const req = idx.getAll(IDBKeyRange.only(storageKey));
			req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
			req.onerror = () => resolve([]);
			tx.oncomplete = () => { try { db.close(); } catch {} };
			tx.onerror = () => { try { db.close(); } catch {} };
		} catch {
			try { db.close(); } catch {}
			resolve([]);
		}
	});
}

async function _idbDeleteOldestOverLimit(storageKey, limit) {
	const db = await _openDb();
	if (!db) return { ok: false, skipped: true };
	return await new Promise((resolve) => {
		let nDeleted = 0;
		try {
			const tx = db.transaction(DB_STORE, "readwrite");
			const store = tx.objectStore(DB_STORE);
			const idx = store.index("by_storageKey_ts");
			const range = IDBKeyRange.bound([storageKey, 0], [storageKey, Number.MAX_SAFE_INTEGER]);

			let nSeen = 0;
			const cursorReq = idx.openCursor(range, "next");
			cursorReq.onsuccess = () => {
				const cursor = cursorReq.result;
				if (!cursor) return;
				nSeen++;
				// keep the newest `limit`, so delete while older than (nSeen - limit)
				// This cursor is oldest->newest; we don't know total count cheaply, so we do a two-pass strategy.
				cursor.continue();
			};

			tx.oncomplete = async () => {
				try { db.close(); } catch {}
				// Two-pass: if we might be over, fetch all and delete oldest.
				try {
					const all = await _idbGetAllByKey(storageKey);
					if (!all || all.length <= limit) return resolve({ ok: true, nDeleted: 0 });
					all.sort((a, b) => (Number(a?.ts || 0) - Number(b?.ts || 0)));
					const toDelete = all.slice(0, Math.max(0, all.length - limit));
					const db2 = await _openDb();
					if (!db2) return resolve({ ok: false, skipped: true });
					const tx2 = db2.transaction(DB_STORE, "readwrite");
					const store2 = tx2.objectStore(DB_STORE);
					for (const r of toDelete) {
						try { if (r && r.id != null) store2.delete(r.id); nDeleted++; } catch {}
					}
					tx2.oncomplete = () => { try { db2.close(); } catch {}; resolve({ ok: true, nDeleted }); };
					tx2.onerror = () => { try { db2.close(); } catch {}; resolve({ ok: false, nDeleted }); };
				} catch {
					resolve({ ok: true, nDeleted: 0 });
				}
			};
			tx.onerror = () => {
				try { db.close(); } catch {}
				resolve({ ok: false, err: String(tx.error || "idb_tx_error") });
			};
		} catch (e) {
			try { db.close(); } catch {}
			resolve({ ok: false, err: String(e?.message || e || "idb_error") });
		}
	});
}

async function _idbClearByKey(storageKey) {
	const db = await _openDb();
	if (!db) return { ok: false, skipped: true };
	return await new Promise((resolve) => {
		try {
			const tx = db.transaction(DB_STORE, "readwrite");
			const store = tx.objectStore(DB_STORE);
			const idx = store.index("by_storageKey");
			const req = idx.openCursor(IDBKeyRange.only(storageKey));
			req.onsuccess = () => {
				const cursor = req.result;
				if (!cursor) return;
				try { cursor.delete(); } catch {}
				cursor.continue();
			};
			tx.oncomplete = () => { try { db.close(); } catch {}; resolve({ ok: true }); };
			tx.onerror = () => { try { db.close(); } catch {}; resolve({ ok: false, err: String(tx.error || "idb_tx_error") }); };
		} catch (e) {
			try { db.close(); } catch {}
			resolve({ ok: false, err: String(e?.message || e || "idb_error") });
		}
	});
}

function _safeJsonParse(s, fallback = null) {
	try {
		return JSON.parse(String(s || ""));
	} catch {
		return fallback;
	}
}

function _lsGet(key, fallback = "") {
	try {
		if (typeof localStorage === "undefined") return fallback;
		return String(localStorage.getItem(String(key || "")) || fallback);
	} catch {
		return fallback;
	}
}

function _lsSet(key, val) {
	try {
		if (typeof localStorage === "undefined") return false;
		localStorage.setItem(String(key || ""), String(val ?? ""));
		return true;
	} catch {
		return false;
	}
}

function _autoUploadCfgFromLocalStorage() {
	try {
		if (typeof localStorage === "undefined") return null;
		const baseUrl = String(localStorage.getItem("fdv_gary_base_url") || "").trim();
		const apiKey = String(localStorage.getItem("fdv_gary_key") || "").trim();
		const hmacSecret = String(localStorage.getItem("fdv_gary_hmac_secret") || "").trim();
		if (!baseUrl || !apiKey) return null;
		const u = baseUrl.toLowerCase();
		if (!(u.startsWith("http://") || u.startsWith("https://"))) return null;
		return { provider: "gary", baseUrl, apiKey, hmacSecret };
	} catch {
		return null;
	}
}

async function getTrainingStorageInfo() {
	try {
		const nav = (typeof navigator !== "undefined") ? navigator : null;
		const storage = nav && nav.storage ? nav.storage : null;
		const out = { ok: true };
		try {
			if (storage && typeof storage.estimate === "function") {
				const est = await storage.estimate();
				out.usageBytes = Number(est?.usage || 0) || 0;
				out.quotaBytes = Number(est?.quota || 0) || 0;
			}
		} catch {}
		try {
			if (storage && typeof storage.persisted === "function") {
				out.persisted = !!(await storage.persisted());
			}
		} catch {}
		return out;
	} catch (e) {
		return { ok: false, err: String(e?.message || e || "storage_info_error") };
	}
}

async function requestTrainingStoragePersistence() {
	try {
		const nav = (typeof navigator !== "undefined") ? navigator : null;
		const storage = nav && nav.storage ? nav.storage : null;
		if (!storage || typeof storage.persist !== "function") return { ok: false, skipped: true, why: "no_storage_persist" };
		const granted = !!(await storage.persist());
		return { ok: true, granted };
	} catch (e) {
		return { ok: false, err: String(e?.message || e || "persist_error") };
	}
}

let _persistProbeDone = false;
async function _bestEffortPersistOnce() {
	try {
		if (_persistProbeDone) return;
		_persistProbeDone = true;
		// Only attempt when capture is enabled; avoids doing this for normal users.
		if (!isTrainingCaptureEnabled()) return;
		await requestTrainingStoragePersistence();
	} catch {}
}

function _downloadTextFile(filename, text, mime = "application/json;charset=utf-8") {
	try {
		if (typeof document === "undefined") return false;
		const blob = new Blob([String(text ?? "")], { type: mime });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = String(filename || "download.txt");
		a.style.display = "none";
		document.body.appendChild(a);
		a.click();
		setTimeout(() => {
			try { URL.revokeObjectURL(url); } catch {}
			try { a.remove(); } catch {}
		}, 150);
		return true;
	} catch {
		return false;
	}
}

function _trimSlash(s) {
	try {
		return String(s || "").trim().replace(/\/+$/, "");
	} catch {
		return "";
	}
}

function _hexFromBytes(bytes) {
	let out = "";
	for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
	return out;
}

async function _hmacSha256Hex(secret, bodyStr) {
	try {
		const s = String(secret || "");
		if (!s) return "";
		const cryptoObj = (typeof globalThis !== "undefined") ? globalThis.crypto : null;
		const subtle = cryptoObj && cryptoObj.subtle ? cryptoObj.subtle : null;
		if (!subtle) return "";
		const enc = new TextEncoder();
		const key = await subtle.importKey(
			"raw",
			enc.encode(s),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const sig = await subtle.sign("HMAC", key, enc.encode(String(bodyStr || "")));
		return _hexFromBytes(new Uint8Array(sig));
	} catch {
		return "";
	}
}

let _garyUploadQueue = [];
let _garyUploadTimer = null;
let _garyUploadInFlight = false;
let _garyUploadAuthOkUntil = 0;
let _garyUploadAuthFailUntil = 0;
let _garyUploadLastKey = "";

async function _garyPostJson({ baseUrl, apiKey, path, bodyObj, hmacSecret = "", timeoutMs = 12_000 } = {}) {
	const urlBase = _trimSlash(baseUrl) || "";
	const key = String(apiKey || "").trim();
	if (!urlBase || !key) throw new Error("missing_gary_auth");
	const bodyStr = JSON.stringify(bodyObj ?? {});
	const headers = {
		"Content-Type": "application/json",
		"Authorization": `Bearer ${key}`,
	};
	try {
		const sig = await _hmacSha256Hex(hmacSecret, bodyStr);
		if (sig) headers["X-FDV-Signature"] = sig;
	} catch {}

	const controller = (typeof AbortController !== "undefined") ? new AbortController() : null;
	let timer = null;
	if (controller) {
		timer = setTimeout(() => {
			try { controller.abort(); } catch {}
		}, Math.max(1500, Math.floor(Number(timeoutMs) || 12_000)));
	}
	try {
		const res = await fetch(`${urlBase}${path}`, {
			method: "POST",
			headers,
			body: bodyStr,
			signal: controller ? controller.signal : undefined,
		});
		const txt = await res.text();
		let js = null;
		try { js = JSON.parse(txt || "{}"); } catch { js = null; }
		if (!res.ok) {
			const detail = (js && (js.detail || js.err)) ? String(js.detail || js.err) : String(txt || res.statusText || "request_failed");
			const e = new Error(detail);
			e.status = res.status;
			throw e;
		}
		// Safety: these endpoints are expected to return JSON. If they don't, treat the target as invalid.
		if (!js || typeof js !== "object") {
			const e = new Error("bad_json_response");
			e.status = res.status;
			throw e;
		}
		return js;
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function _queueGaryUpload(entry, uploadCfg) {
	try {
		const cfg = uploadCfg && typeof uploadCfg === "object" ? uploadCfg : null;
		if (!cfg || String(cfg.provider || "").toLowerCase() !== "gary") return;
		const baseUrl = String(cfg.baseUrl || "").trim();
		const apiKey = String(cfg.apiKey || "").trim();
		if (!baseUrl || !apiKey) return;
		// Safety: only allow explicit http(s) URLs.
		const u = baseUrl.toLowerCase();
		if (!(u.startsWith("http://") || u.startsWith("https://"))) return;

		const keySig = `${baseUrl}::${apiKey.slice(0, 8)}`;
		if (_garyUploadLastKey && _garyUploadLastKey !== keySig) {
			// New target; drop pending uploads to avoid cross-contamination.
			_garyUploadQueue = [];
		}
		_garyUploadLastKey = keySig;

		_garyUploadQueue.push(entry);
		if (_garyUploadQueue.length > 2000) _garyUploadQueue = _garyUploadQueue.slice(_garyUploadQueue.length - 2000);
		if (_garyUploadTimer) return;
		_garyUploadTimer = setTimeout(() => {
			_garyUploadTimer = null;
			_flushGaryUploads(cfg).catch(() => {});
		}, 1200);
	} catch {}
}

async function _flushGaryUploads(cfg) {
	if (_garyUploadInFlight) return;
	const nowMs = Date.now();
	if (_garyUploadAuthFailUntil && nowMs < _garyUploadAuthFailUntil) return;
	if (!_garyUploadQueue.length) return;

	_garyUploadInFlight = true;
	try {
		// Always verify the target before uploading (users can accidentally paste bad domains/keys).
		const needAuthProbe = !_garyUploadAuthOkUntil || nowMs >= _garyUploadAuthOkUntil;
		if (needAuthProbe) {
			try {
				const info = await _garyPostJson({
					baseUrl: cfg.baseUrl,
					apiKey: cfg.apiKey,
					path: "/v1/captures/info",
					bodyObj: {},
					hmacSecret: cfg.hmacSecret || "",
					timeoutMs: 8000,
				});
				if (!info || info.ok !== true) throw new Error("bad_model_info");
				_garyUploadAuthOkUntil = nowMs + 5 * 60 * 1000;
			} catch (e) {
				const status = Number(e?.status || 0);
				if (status === 401 || status === 403) {
					_garyUploadAuthFailUntil = nowMs + 10 * 60 * 1000;
					_garyUploadQueue = [];
					return;
				}
				// Don't upload unless the probe succeeded. Keep queued entries and retry later.
				_garyUploadAuthFailUntil = nowMs + 2 * 60 * 1000;
				return;
			}
		}

		// Send up to 50 captures per request.
		const batch = _garyUploadQueue.splice(0, Math.min(50, _garyUploadQueue.length));
		await _garyPostJson({
			baseUrl: cfg.baseUrl,
			apiKey: cfg.apiKey,
			path: "/v1/captures/append",
			bodyObj: { entries: batch },
			hmacSecret: cfg.hmacSecret || "",
			timeoutMs: 12_000,
		});
		_garyUploadAuthOkUntil = nowMs + 5 * 60 * 1000;
	} catch (e) {
		const status = Number(e?.status || 0);
		if (status === 401 || status === 403) {
			_garyUploadAuthFailUntil = Date.now() + 10 * 60 * 1000;
			_garyUploadQueue = [];
		}
	} finally {
		_garyUploadInFlight = false;
		// If more queued, schedule another flush.
		if (_garyUploadQueue.length && !_garyUploadTimer) {
			_garyUploadTimer = setTimeout(() => {
				_garyUploadTimer = null;
				_flushGaryUploads(cfg).catch(() => {});
			}, 900);
		}
	}
}

export function isTrainingCaptureEnabled() {
	try {
		return !!(TRAINING_CAPTURE && TRAINING_CAPTURE.enabled);
	} catch {
		return false;
	}
}

export async function getTrainingCaptures({ storageKey } = {}) {
	try {
		const key = String(storageKey || TRAINING_CAPTURE?.storageKey || "fdv_gary_training_captures_v1");
		const idb = await _idbGetAllByKey(key);
		if (Array.isArray(idb) && idb.length) return idb;
	} catch {}
	try {
		const key = String(storageKey || TRAINING_CAPTURE?.storageKey || "fdv_gary_training_captures_v1");
		const raw = _lsGet(key, "");
		if (!raw) return [];
		const arr = _safeJsonParse(raw, []);
		return Array.isArray(arr) ? arr : [];
	} catch {
		return [];
	}
}

export async function clearTrainingCaptures({ storageKey } = {}) {
	try {
		const key = String(storageKey || TRAINING_CAPTURE?.storageKey || "fdv_gary_training_captures_v1");
		const r = await _idbClearByKey(key);
		if (r && r.ok) return true;
	} catch {}
	try {
		const key = String(storageKey || TRAINING_CAPTURE?.storageKey || "fdv_gary_training_captures_v1");
		return _lsSet(key, "[]");
	} catch {
		return false;
	}
}

export async function appendTrainingCapture(entry, { storageKey, maxEntries, uploadToGary } = {}) {
	try {
		if (!isTrainingCaptureEnabled()) return { ok: false, skipped: true };
		try { await _bestEffortPersistOnce(); } catch {}
		// If caller didn't pass upload cfg, auto-enable from user-supplied Gary settings.
		const uploadCfg = (uploadToGary && typeof uploadToGary === "object")
			? uploadToGary
			: _autoUploadCfgFromLocalStorage();
		const key = String(storageKey || TRAINING_CAPTURE?.storageKey || "fdv_gary_training_captures_v1");
		const limit = Math.max(
			25,
			Math.min(
				250_000,
				Number.isFinite(Number(maxEntries)) ? Math.floor(Number(maxEntries)) : (TRAINING_CAPTURE?.maxEntries || 750),
			),
		);

		const rec = (entry && typeof entry === "object") ? { ...entry } : { value: entry };
		rec.ts = Number.isFinite(Number(rec.ts)) ? Number(rec.ts) : now();
		rec.storageKey = key;

		// Prefer IndexedDB for volume.
		const r = await _idbAddCapture(rec);
		if (r && r.ok) {
			// best-effort pruning
			try { await _idbDeleteOldestOverLimit(key, limit); } catch {}
			try { _queueGaryUpload(rec, uploadCfg); } catch {}
			return { ok: true, backend: "idb" };
		}
	} catch {}

	// Fallback to localStorage (small).
	try {
		const key = String(storageKey || TRAINING_CAPTURE?.storageKey || "fdv_gary_training_captures_v1");
		const maxLs = TRAINING_CAPTURE?.maxEntriesLocalStorage || 750;
		const limit = Math.max(25, Math.min(5000, Number.isFinite(Number(maxEntries)) ? Math.floor(Number(maxEntries)) : maxLs));

		const prev = await getTrainingCaptures({ storageKey: key });
		const rec = (entry && typeof entry === "object") ? { ...entry } : { value: entry };
		rec.ts = Number.isFinite(Number(rec.ts)) ? Number(rec.ts) : now();

		prev.push(rec);
		const sliced = prev.length > limit ? prev.slice(prev.length - limit) : prev;
		const raw = JSON.stringify(sliced);
		if (_lsSet(key, raw)) {
			try { _queueGaryUpload(rec, uploadCfg); } catch {}
			return { ok: true, backend: "localStorage", n: sliced.length };
		}

		const shrunk = sliced.slice(Math.max(0, sliced.length - Math.max(50, Math.floor(limit / 2))));
		if (_lsSet(key, JSON.stringify(shrunk))) {
			try { _queueGaryUpload(rec, uploadCfg); } catch {}
			return { ok: true, backend: "localStorage", n: shrunk.length, truncated: true };
		}

		return { ok: false, err: "localStorage_write_failed" };
	} catch (e) {
		return { ok: false, err: String(e?.message || e || "error") };
	}
}

export function trainingCapturesToJsonl(entries) {
	try {
		const arr = Array.isArray(entries) ? entries : [];
		return arr.map((e) => {
			try { return JSON.stringify(e); } catch { return "{}"; }
		}).join("\n") + (arr.length ? "\n" : "");
	} catch {
		return "";
	}
}

export async function downloadTrainingCapturesJsonl({ filenamePrefix = "fdv-gary-captures", storageKey } = {}) {
	try {
		const entries = await getTrainingCaptures({ storageKey });
		const jsonl = trainingCapturesToJsonl(entries);
		const name = `${String(filenamePrefix || "fdv-gary-captures")}-${Date.now()}.jsonl`;
		return _downloadTextFile(name, jsonl, "application/jsonl;charset=utf-8");
	} catch {
		return false;
	}
}

export function installTrainingDebugGlobal({ force = false } = {}) {
	try {
		const g = (typeof window !== "undefined") ? window : globalThis;
		if (!g) return false;
		if (g.__fdvTraining && !force) {
			// If another module (e.g. the agent driver) already installed it, don't clobber.
			return true;
		}
		g.__fdvTraining = {
			enabled: () => isTrainingCaptureEnabled(),
			get: () => getTrainingCaptures(),
			clear: () => clearTrainingCaptures(),
			downloadJsonl: () => downloadTrainingCapturesJsonl({ filenamePrefix: "fdv-gary-captures" }),
			storage: () => getTrainingStorageInfo(),
			persist: () => requestTrainingStoragePersistence(),
			cfg: () => {
				try { return TRAINING_CAPTURE || {}; } catch { return {}; }
			},
		};
		return true;
	} catch {
		return false;
	}
}
