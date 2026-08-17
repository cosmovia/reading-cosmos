export type GatewayTaskType =
  | "book_overview"
  | "note_assistance"
  | "reading_insight";

export type ProviderCircuitState = {
  failures: number;
  openUntil: number;
};

const RECOVERABLE_FAILURES = new Set([
  "RATE_LIMIT",
  "TIMEOUT",
  "NETWORK",
  "UNAVAILABLE",
  "CIRCUIT_OPEN",
]);

export function allowsCrossProviderFallback(
  taskType: GatewayTaskType,
): boolean {
  return taskType === "book_overview";
}

export function shouldTryNextProvider(
  taskType: GatewayTaskType,
  failureCode: string,
): boolean {
  return allowsCrossProviderFallback(taskType) &&
    RECOVERABLE_FAILURES.has(failureCode);
}

export class ProviderCircuitRegistry {
  readonly #states = new Map<string, ProviderCircuitState>();

  get(provider: string): ProviderCircuitState {
    const existing = this.#states.get(provider);
    if (existing) return existing;
    const state = { failures: 0, openUntil: 0 };
    this.#states.set(provider, state);
    return state;
  }

  recordSuccess(provider: string): void {
    const state = this.get(provider);
    state.failures = 0;
    state.openUntil = 0;
  }

  recordRetryableFailure(
    provider: string,
    now = Date.now(),
    failureThreshold = 3,
    cooldownMs = 5 * 60_000,
  ): ProviderCircuitState {
    const state = this.get(provider);
    state.failures += 1;
    if (state.failures >= failureThreshold) state.openUntil = now + cooldownMs;
    return state;
  }

  isOpen(provider: string, now = Date.now()): boolean {
    return this.get(provider).openUntil > now;
  }
}
