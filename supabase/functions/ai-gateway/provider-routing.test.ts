import {
  allowsCrossProviderFallback,
  ProviderCircuitRegistry,
  shouldTryNextProvider,
} from "./provider-routing.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("only book overviews allow automatic cross-provider fallback", () => {
  assert(
    allowsCrossProviderFallback("book_overview"),
    "book overview should allow fallback",
  );
  assert(
    !allowsCrossProviderFallback("note_assistance"),
    "private note assistance must stay on its primary provider",
  );
  assert(
    !allowsCrossProviderFallback("reading_insight"),
    "full-library insights must stay on their primary provider",
  );
});

Deno.test("only recoverable failures advance a book overview route", () => {
  for (
    const code of [
      "RATE_LIMIT",
      "TIMEOUT",
      "NETWORK",
      "UNAVAILABLE",
      "CIRCUIT_OPEN",
    ]
  ) {
    assert(
      shouldTryNextProvider("book_overview", code),
      `${code} should allow fallback`,
    );
  }
  for (const code of ["AUTH", "BUDGET", "REQUEST", "INVALID_RESPONSE"]) {
    assert(
      !shouldTryNextProvider("book_overview", code),
      `${code} must not allow fallback`,
    );
  }
});

Deno.test("private tasks do not cross providers even on recoverable failures", () => {
  assert(
    !shouldTryNextProvider("note_assistance", "RATE_LIMIT"),
    "note assistance crossed providers",
  );
  assert(
    !shouldTryNextProvider("reading_insight", "TIMEOUT"),
    "reading insight crossed providers",
  );
});

Deno.test("provider circuit states remain isolated", () => {
  const registry = new ProviderCircuitRegistry();
  registry.recordRetryableFailure("zhipu", 1_000, 1, 5_000);
  assert(registry.isOpen("zhipu", 2_000), "zhipu circuit should be open");
  assert(
    !registry.isOpen("openrouter", 2_000),
    "openrouter circuit should remain closed",
  );
});

Deno.test("a successful request resets only its provider circuit", () => {
  const registry = new ProviderCircuitRegistry();
  registry.recordRetryableFailure("zhipu", 1_000, 1, 5_000);
  registry.recordRetryableFailure("openrouter", 1_000, 1, 5_000);
  registry.recordSuccess("zhipu");
  assert(!registry.isOpen("zhipu", 2_000), "zhipu circuit should be reset");
  assert(
    registry.isOpen("openrouter", 2_000),
    "openrouter circuit should remain open",
  );
});
