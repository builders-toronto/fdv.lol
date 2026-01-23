export function createLeaderModePolicy({ log, getRugSignalForMint } = {}) {
  const _log = typeof log === "function" ? log : () => {};

  return function leaderModePolicy(ctx) {
    if (!ctx.leaderMode) return { stop: false };

    const sig0 = typeof getRugSignalForMint === "function" ? getRugSignalForMint(ctx.mint) : null;

    if (!(sig0?.rugged)) {
      _log(`Leader-hold: holding ${ctx.mint.slice(0, 4)}… (no rug).`);
      return { stop: true };
    }

    if (sig0?.rugged) {
      _log(
        `Leader-hold: RUG detected for ${ctx.mint.slice(0, 4)}… sev=${Number(sig0.sev || 0).toFixed(2)}. Forcing sell.`
      );
    }

    return { stop: false };
  };
}
