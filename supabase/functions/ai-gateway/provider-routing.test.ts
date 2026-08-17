import {
  allowsCrossProviderFallback,
  executeTaskProviderRoutes,
  ProviderCircuitRegistry,
  shouldTryNextProvider,
} from "./provider-routing.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function routeFailure(code: string, attempts: number) {
  return Object.assign(new Error(code), { code, attempts });
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

Deno.test("book overview can use an authorized fallback when the primary key is missing", async () => {
  const result = await executeTaskProviderRoutes("book_overview", [
    {
      provider: "zhipu",
      model: "glm",
      configured: false,
      tasks: ["book_overview", "note_assistance", "reading_insight"],
      execute: async () => ({ content: "primary", attempts: 1 }),
    },
    {
      provider: "openrouter",
      model: "free-a",
      configured: true,
      tasks: ["book_overview"],
      execute: async () => ({ content: "fallback", attempts: 1 }),
    },
  ]);
  assert(
    result.content === "fallback",
    "overview did not use the configured fallback",
  );
  assert(
    result.fallbackIndex === 1,
    "fallback index should preserve route order",
  );
});

Deno.test("private tasks cannot use an overview-only provider when the primary key is missing", async () => {
  let fallbackCalls = 0;
  try {
    await executeTaskProviderRoutes("note_assistance", [
      {
        provider: "zhipu",
        model: "glm",
        configured: false,
        tasks: ["book_overview", "note_assistance", "reading_insight"],
        execute: async () => ({ content: "primary", attempts: 1 }),
      },
      {
        provider: "openrouter",
        model: "free-a",
        configured: true,
        tasks: ["book_overview"],
        execute: async () => {
          fallbackCalls += 1;
          return { content: "private", attempts: 1 };
        },
      },
    ]);
    throw new Error("private task unexpectedly succeeded");
  } catch (error) {
    assert(
      (error as { code?: string }).code === "NOT_CONFIGURED",
      "wrong private-task failure",
    );
    assert(
      fallbackCalls === 0,
      "private content reached the overview-only provider",
    );
  }
});

Deno.test("recoverable overview failure records total attempts and the actual fallback", async () => {
  const result = await executeTaskProviderRoutes("book_overview", [
    {
      provider: "zhipu",
      model: "glm",
      configured: true,
      tasks: ["book_overview"],
      execute: async () => {
        throw routeFailure("RATE_LIMIT", 2);
      },
    },
    {
      provider: "openrouter",
      model: "free-a",
      configured: true,
      tasks: ["book_overview"],
      execute: async () => ({ content: "ok", attempts: 1 }),
    },
  ]);
  assert(
    result.provider === "openrouter",
    "actual fallback provider was not returned",
  );
  assert(
    result.attempts === 3,
    "attempts were not accumulated across providers",
  );
  assert(result.fallbackIndex === 1, "successful fallback index is incorrect");
});

Deno.test("router records the model actually selected by an aggregated provider", async () => {
  const result = await executeTaskProviderRoutes("book_overview", [{
    provider: "openrouter",
    model: "openrouter/free",
    configured: true,
    tasks: ["book_overview"],
    execute: async () => ({
      content: "ok",
      attempts: 1,
      resolvedModel: "example/free-model:free",
    }),
  }]);
  assert(
    result.model === "example/free-model:free",
    "resolved OpenRouter model was not recorded",
  );
});

Deno.test("non-recoverable provider failure stops routing", async () => {
  let fallbackCalls = 0;
  try {
    await executeTaskProviderRoutes("book_overview", [
      {
        provider: "zhipu",
        model: "glm",
        configured: true,
        tasks: ["book_overview"],
        execute: async () => {
          throw routeFailure("AUTH", 1);
        },
      },
      {
        provider: "openrouter",
        model: "free-a",
        configured: true,
        tasks: ["book_overview"],
        execute: async () => {
          fallbackCalls += 1;
          return { content: "unexpected", attempts: 1 };
        },
      },
    ]);
  } catch (error) {
    const failure = error as {
      code?: string;
      provider?: string;
      attempts?: number;
    };
    assert(failure.code === "AUTH", "wrong terminal failure code");
    assert(failure.provider === "zhipu", "wrong terminal failure provider");
    assert(failure.attempts === 1, "wrong terminal attempt count");
  }
  assert(
    fallbackCalls === 0,
    "authentication failure incorrectly advanced routing",
  );
});

Deno.test("final failure identifies the exhausted fallback route", async () => {
  try {
    await executeTaskProviderRoutes("book_overview", [
      {
        provider: "zhipu",
        model: "glm",
        configured: true,
        tasks: ["book_overview"],
        execute: async () => {
          throw routeFailure("RATE_LIMIT", 2);
        },
      },
      {
        provider: "openrouter",
        model: "free-a",
        configured: true,
        tasks: ["book_overview"],
        execute: async () => {
          throw routeFailure("UNAVAILABLE", 2);
        },
      },
    ]);
    throw new Error("all-provider failure unexpectedly succeeded");
  } catch (error) {
    const failure = error as {
      code?: string;
      provider?: string;
      fallbackIndex?: number;
      attempts?: number;
    };
    assert(failure.code === "UNAVAILABLE", "wrong final error code");
    assert(failure.provider === "openrouter", "wrong final provider");
    assert(failure.fallbackIndex === 1, "wrong final fallback index");
    assert(failure.attempts === 4, "wrong accumulated failure attempts");
  }
});
