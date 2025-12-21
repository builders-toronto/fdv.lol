export async function runPipeline(ctx, steps = []) {
  for (const step of steps) {
    if (typeof step !== "function") continue;
    const res = await step(ctx);
    if (res && (res.stop || res.returned)) return res;
  }
  return null;
}
