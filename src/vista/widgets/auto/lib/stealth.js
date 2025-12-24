export function createStealthTools({
  now,
  log,
  save,
  getState,
  getAutoKeypair,
  loadDeps,
  getConn,
  unwrapWsolIfAny,
  confirmSig,
  SOL_MINT,
  TX_FEE_BUFFER_LAMPORTS,
} = {}) {
  const _now = typeof now === "function" ? now : () => Date.now();
  const _log = typeof log === "function" ? log : () => {};
  const _save = typeof save === "function" ? save : () => {};
  const _getState = typeof getState === "function" ? getState : () => ({});

  function addOldWalletRecord(rec = {}) {
    try {
      const state = _getState();
      if (!Array.isArray(state.oldWallets)) state.oldWallets = [];
      const item = {
        pub: String(rec.pub || ""),
        secret: String(rec.secret || ""),
        tag: String(rec.tag || ""),
        movedLamports: Number(rec.movedLamports || 0) | 0,
        txSig: String(rec.txSig || ""),
        at: _now(),
      };
      state.oldWallets.unshift(item);
      const CAP = 10;
      if (state.oldWallets.length > CAP) state.oldWallets.length = CAP;
      _save();
      _log(`Stealth archive: saved old wallet ${item.pub.slice(0, 4)}… (tag="${item.tag || "rotate"}")`);
    } catch {}
  }

  async function maybeStealthRotate(tag = "sell") {
    try {
      const state = _getState();
      if (!state.stealthMode) return false;

      const kp = (typeof getAutoKeypair === "function") ? await getAutoKeypair() : null;
      if (!kp) return false;

      const openPosCount = Object.entries(state.positions || {})
        .filter(([m, p]) => m !== SOL_MINT && Number(p?.sizeUi || 0) > 0).length;
      if (openPosCount > 0) {
        _log(`Stealth: deferring wallet rotation (open positions=${openPosCount}).`);
        return false;
      }

      const { Keypair, bs58, SystemProgram, Transaction } = await loadDeps();
      const conn = await getConn();
      const oldSigner = kp;
      const oldPubStr = oldSigner.publicKey.toBase58();
      const oldSecretStr = String(state.autoWalletSecret || bs58.default.encode(oldSigner.secretKey));

      const newKp = Keypair.generate();
      const newPubStr = newKp.publicKey.toBase58();
      const newSecretStr = bs58.default.encode(newKp.secretKey);

      try { await unwrapWsolIfAny(oldSigner); } catch {}

      let balL = 0;
      try { balL = await conn.getBalance(oldSigner.publicKey, "processed"); } catch {}
      const bufL = Math.max(50_000, Number(TX_FEE_BUFFER_LAMPORTS || 0));
      const sendLamports = Math.max(0, balL - bufL);
      let transferSig = "";

      if (sendLamports <= 0) {
        _log("Stealth: balance too low to transfer; rotating key only.");
      } else {
        try {
          const tx = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: oldSigner.publicKey,
              toPubkey: newKp.publicKey,
              lamports: sendLamports,
            })
          );
          tx.feePayer = oldSigner.publicKey;
          tx.recentBlockhash = (await conn.getLatestBlockhash("processed")).blockhash;
          tx.sign(oldSigner);
          const sig = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: "processed", maxRetries: 2 });
          transferSig = sig;
          _log(`Stealth: SOL moved to new wallet (${newPubStr.slice(0, 4)}…) tx=${sig}`);
          try { await confirmSig(sig, { commitment: "confirmed", timeoutMs: 12000 }); } catch {}
        } catch (e) {
          // Archive even on failure so user can recover
          addOldWalletRecord({
            pub: oldPubStr,
            secret: oldSecretStr,
            tag: `transfer-failed:${tag}`,
            movedLamports: sendLamports,
            txSig: "",
          });
          _log(`Stealth: transfer failed: ${e?.message || e}`);
          _log(`WARNING: Stealth archive (old wallet): pub=${oldPubStr} secret=${oldSecretStr}`);
          try { console.log(`WARNING: Stealth new wallet: pub=${newPubStr} secret=${newSecretStr}`); } catch {}
          return false;
        }
      }

      addOldWalletRecord({ pub: oldPubStr, secret: oldSecretStr, tag, movedLamports: sendLamports, txSig: transferSig });

      _log(`WARNING: Stealth archive (old wallet): pub=${oldPubStr} secret=${oldSecretStr}`);
      _log(`WARNING: Stealth new wallet: pub=${newPubStr} secret=${newSecretStr}`);
      try { console.log(`WARNING: Stealth archive (old wallet): pub=${oldPubStr} secret=${oldSecretStr}`); } catch {}

      state.autoWalletPub = newPubStr;
      state.autoWalletSecret = newSecretStr;
      _save();

      _log(`Stealth: rotated wallet (${tag}). New wallet: ${newPubStr.slice(0, 4)}…`);
      return true;
    } catch (e) {
      try { _log(`Stealth: rotation error: ${e?.message || e}`, "err"); } catch {}
      return false;
    }
  }

  return {
    addOldWalletRecord,
    maybeStealthRotate,
  };
}
