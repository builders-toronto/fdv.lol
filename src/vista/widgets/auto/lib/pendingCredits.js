function pcKey(owner, mint) {
  return `${owner}:${mint}`;
}

export function createPendingCreditManager({
  now,
  log,
  getState,
  rpcBackoffLeft,
  rpcWait,
  markRpcStress,
  getConn,
  getAtaBalanceUi,
  listOwnerSplPositions,
  reconcileFromOwnerScan,
  updatePosCache,
  save,
  getAutoKeypair,
}) {
  const pendingCredits = new Map();

  function clearPendingCredit(owner, mint) {
    try {
      pendingCredits.delete(pcKey(owner, mint));
    } catch {}
  }

  async function getTxWithMeta(sig) {
    try {
      await rpcWait?.("tx-meta", 800);
      const conn = await getConn();
      let tx = await conn.getTransaction(sig, {
        maxSupportedTransactionVersion: 0,
        commitment: "finalized",
      });
      if (!tx) {
        tx = await conn.getTransaction(sig, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        });
      }
      return tx || null;
    } catch (e) {
      markRpcStress?.(e, 1500);
      return null;
    }
  }

  async function reconcileBuyFromTx(sig, ownerPub, expectedMint) {
    const tx = await getTxWithMeta(sig);
    if (!tx?.meta) return null;

    const keys = tx.transaction?.message?.accountKeys || [];
    const post = tx.meta.postTokenBalances || [];

    const pick = (arr, mint) => arr.find((b) => (!mint || b.mint === mint));
    let rec = pick(post, expectedMint);
    if (!rec) rec = post.find((b) => b?.owner === ownerPub) || post[0];

    if (!rec?.mint) return null;
    const mint = rec.mint;
    const dec = Number(rec.uiTokenAmount?.decimals ?? 6);
    const ui = Number(rec.uiTokenAmount?.uiAmount ?? 0);
    if (ui > 0) return { mint, sizeUi: ui, decimals: dec };

    try {
      const ai = Number(rec.accountIndex);
      const pk =
        keys?.[ai]?.pubkey?.toBase58?.() ||
        keys?.[ai]?.toBase58?.() ||
        String(keys?.[ai] || "");
      if (pk) {
        const b = await getAtaBalanceUi(ownerPub, mint, dec);
        if (Number(b.sizeUi || 0) > 0) {
          return {
            mint,
            sizeUi: Number(b.sizeUi),
            decimals: Number.isFinite(b.decimals) ? b.decimals : dec,
          };
        }
      }
    } catch {}
    return null;
  }

  function enqueuePendingCredit({
    owner,
    mint,
    addCostSol = 0,
    decimalsHint = 6,
    basePos = {},
    sig,
  }) {
    if (!owner || !mint) return;
    const state = typeof getState === "function" ? getState() : null;

    const nowTs = now();
    const graceMs = Math.max(5000, Number(state?.pendingGraceMs || 20000));
    const until = nowTs + graceMs;

    const key = pcKey(owner, mint);
    const prev = pendingCredits.get(key);
    const add = Number(addCostSol || 0);

    const baseCostSol = Number(basePos?.costSol || 0);
    const targetCostSol = baseCostSol + add;
    const nextTargetCostSol = Math.max(Number(prev?._targetCostSol || 0), Number.isFinite(targetCostSol) ? targetCostSol : 0);

    pendingCredits.set(key, {
      owner,
      mint,
      sig: sig || prev?.sig || "",
      expectedMint: mint,
      addCostSol: Number(prev?.addCostSol || 0) + add,
      decimalsHint: Number.isFinite(decimalsHint) ? decimalsHint : (prev?.decimalsHint ?? 6),
      basePos: Object.assign({}, basePos || {}, { awaitingSizeSync: true }),
      _targetCostSol: nextTargetCostSol,
      startedAt: prev?.startedAt || nowTs,
      until,
      lastTriedAt: 0,
    });

    try {
      log?.(`Queued pending credit watch for ${mint.slice(0, 4)}… for up to ${(graceMs / 1000) | 0}s.`);
    } catch {}

    startPendingCreditWatchdog();
  }

  async function processPendingCredits() {
    if (pendingCredits.size === 0) return;
    if (rpcBackoffLeft?.() > 0) return;

    const state = typeof getState === "function" ? getState() : null;
    const nowTs = now();

    for (const [key, entry] of Array.from(pendingCredits.entries())) {
      if (!entry?.owner || !entry?.mint) {
        pendingCredits.delete(key);
        continue;
      }
      if (!entry || nowTs > entry.until) {
        pendingCredits.delete(key);
        continue;
      }
      if (entry.lastTriedAt && now() - entry.lastTriedAt < 300) continue;

      try {
        entry.lastTriedAt = nowTs;

        const bal = await getAtaBalanceUi(entry.owner, entry.mint, entry.decimalsHint);
        let sizeUi = Number(bal.sizeUi || 0);
        let dec = Number.isFinite(bal.decimals) ? bal.decimals : (entry.decimalsHint ?? 6);

        if (sizeUi <= 0 && entry.sig) {
          const metaHit = await reconcileBuyFromTx(entry.sig, entry.owner, entry.expectedMint).catch(() => null);
          if (metaHit && metaHit.mint === entry.mint) {
            sizeUi = Number(metaHit.sizeUi || 0);
            if (Number.isFinite(metaHit.decimals)) dec = metaHit.decimals;
            if (sizeUi > 0) {
              log?.(`Buy reconciled via tx meta for ${entry.mint.slice(0, 4)}… size=${sizeUi.toFixed(6)}`);
            }
          }
        }

        if (sizeUi <= 0) {
          try {
            const list = await listOwnerSplPositions(entry.owner);
            const found = list.find((x) => x.mint === entry.mint);
            if (found && Number(found.sizeUi || 0) > 0) {
              sizeUi = Number(found.sizeUi);
              dec = Number.isFinite(found.decimals) ? found.decimals : dec;
            }
          } catch {}
        }

        if (sizeUi > 0) {
          try {
            const seedUi = Number(entry.basePos?.sizeUi || 0);
            const ageMs = now() - Number(entry.startedAt || now());
            const partial = seedUi > 0 && sizeUi < seedUi * 0.5;
            const withinWarmup =
              ageMs <
              Math.min(
                30_000,
                Math.max(10_000, Number(entry.until || now()) - Number(entry.startedAt || now()))
              );
            if (partial && withinWarmup) {
              log?.(
                `Pending-credit: small credit ${sizeUi.toFixed(6)} < seed ${seedUi.toFixed(6)} — waiting to reconcile.`
              );
              entry.until = Math.max(entry.until, now() + 4000);
              continue;
            }
          } catch {}

          const prevPos = state?.positions?.[entry.mint] || entry.basePos || { costSol: 0, hwmSol: 0, acquiredAt: now() };

          const alreadySynced = prevPos.awaitingSizeSync === false && Number(prevPos.sizeUi || 0) > 0;

          const prevCostSol = Number(prevPos.costSol || 0);
          const desiredCostSol = Number(entry._targetCostSol || 0) || (prevCostSol + Number(entry.addCostSol || 0));
          let nextCostSol = prevCostSol;
          if (!alreadySynced && Number.isFinite(desiredCostSol) && desiredCostSol > prevCostSol) {
            nextCostSol = desiredCostSol;
          } else if (alreadySynced && Number.isFinite(desiredCostSol) && desiredCostSol > (prevCostSol + 1e-9)) {
            try {
              log?.(
                `Pending-credit: cost skip ${entry.mint.slice(0, 4)}… already synced cost=${prevCostSol.toFixed(6)} target=${desiredCostSol.toFixed(6)}`
              );
            } catch {}
          }

          const pos = {
            ...prevPos,
            sizeUi,
            decimals: dec,
            costSol: nextCostSol,
            hwmSol: Math.max(Number(prevPos.hwmSol || 0), Number(entry.addCostSol || 0)),
            lastBuyAt: now(),
            lastSeenAt: now(),
            awaitingSizeSync: false,
          };

          if (state?.positions) state.positions[entry.mint] = pos;
          updatePosCache?.(entry.owner, entry.mint, sizeUi, dec);
          save?.();
          log?.(`Credit detected for ${entry.mint.slice(0, 4)}… synced to cache.`);

          pendingCredits.delete(key);
        }
      } catch (e) {
        markRpcStress?.(e, 3000);
        entry.until = Math.max(entry.until, now() + 4000);
      }
    }
  }

  function stopPendingCreditWatchdog() {
    try {
      if (window._fdvPendWatch) clearInterval(window._fdvPendWatch);
    } catch {}
    window._fdvPendWatch = null;
  }

  function startPendingCreditWatchdog() {
    if (window._fdvPendWatch) return;
    let startedAt = now();

    window._fdvPendWatch = setInterval(async () => {
      try {
        if (now() - startedAt > 180_000) {
          stopPendingCreditWatchdog();
          return;
        }
        if (pendingCredits.size === 0) {
          stopPendingCreditWatchdog();
          return;
        }
        if (rpcBackoffLeft?.() > 0) return;

        const kp = await getAutoKeypair?.().catch(() => null);
        if (!kp) return;

        await processPendingCredits().catch(() => {});
        await reconcileFromOwnerScan?.(kp.publicKey.toBase58()).catch(() => {});
      } catch {}
    }, 2200);

    log?.("Pending-credit watchdog running.");
  }

  function hasPendingCredit(owner, mint) {
    try {
      return pendingCredits.has(pcKey(owner, mint));
    } catch {
      return false;
    }
  }

  function pendingCreditsSize() {
    try {
      return pendingCredits.size;
    } catch {
      return 0;
    }
  }

  return {
    clearPendingCredit,
    enqueuePendingCredit,
    processPendingCredits,
    startPendingCreditWatchdog,
    stopPendingCreditWatchdog,
    hasPendingCredit,
    pendingCreditsSize,
  };
}
