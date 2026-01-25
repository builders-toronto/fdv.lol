// This file is kept as a compatibility shim.
// The anomaly/sentry agent implementation now lives under src/agents and uses the shared driver call path.

export { createAgentGarySentry } from "../agents/sentry.js";
export { GARY_SENTRY_SYSTEM_PROMPT as AGENT_GARY_SENTRY_SYSTEM } from "../agents/personas/agent.gary.sentry.js";