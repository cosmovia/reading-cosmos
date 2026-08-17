export type GatewayTaskType =
  | "book_overview"
  | "note_assistance"
  | "reading_insight";

export type ProviderCircuitState = {
  failures: number;
  openUntil: number;
};

export type ProviderRouteFailure = Error & {
  code: string;
  attempts?: number;
  provider?: string;
  model?: string;
  fallbackIndex?: number;
};

export type ExecutableProviderRoute<T> = {
  provider: string;
  model: string;
  configured: boolean;
  tasks: readonly GatewayTaskType[];
  execute: () => Promise<T & { attempts: number; resolvedModel?: string }>;
};

export type ExecutedProviderRoute<T> = T & {
  attempts: number;
  provider: string;
  model: string;
  fallbackIndex: number;
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

export async function executeTaskProviderRoutes<T>(
  taskType: GatewayTaskType,
  routes: Array<ExecutableProviderRoute<T>>,
): Promise<ExecutedProviderRoute<T>> {
  let totalAttempts = 0;
  let eligibleRoutes = 0;
  let finalFailure: ProviderRouteFailure | null = null;

  for (const [fallbackIndex, route] of routes.entries()) {
    if (!route.configured || !route.tasks.includes(taskType)) continue;
    eligibleRoutes += 1;
    try {
      const result = await route.execute();
      totalAttempts += result.attempts;
      return {
        ...result,
        attempts: totalAttempts,
        provider: route.provider,
        model: result.resolvedModel || route.model,
        fallbackIndex,
      };
    } catch (rawError) {
      const failure = rawError as ProviderRouteFailure;
      if (!failure?.code) throw rawError;
      totalAttempts += failure.attempts ?? 0;
      failure.provider = route.provider;
      failure.model = route.model;
      failure.fallbackIndex = fallbackIndex;
      failure.attempts = totalAttempts;
      finalFailure = failure;
      if (!shouldTryNextProvider(taskType, failure.code)) break;
    }
  }

  if (eligibleRoutes === 0) {
    throw Object.assign(new Error("NOT_CONFIGURED"), {
      code: "NOT_CONFIGURED",
      attempts: 0,
    }) as ProviderRouteFailure;
  }
  throw finalFailure ?? Object.assign(new Error("UNAVAILABLE"), {
    code: "UNAVAILABLE",
    attempts: totalAttempts,
  }) as ProviderRouteFailure;
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
