import "jsr:@supabase/functions-js@2.5.0/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  executeTaskProviderRoutes,
  ProviderCircuitRegistry,
} from "./provider-routing.ts";
import {
  buildBookSearchQueries,
  buildGoogleBooksSearchParams,
  isManagedBookCoverUrl,
  isLowResolutionGoogleBooksCover,
  safeBookCoverUrl,
  selectGoogleBooksCover,
  scoreBookMetadataCandidate,
} from "./book-metadata.ts";
import { isUsableProviderContent } from "./provider-content.ts";

const TASK_TYPES = ["book_overview", "note_assistance", "reading_insight"] as const;
type TaskType = typeof TASK_TYPES[number];
const PROMPT_VERSIONS: Record<TaskType, string> = {
  book_overview: "book-overview-v1",
  note_assistance: "note-assistance-v1",
  reading_insight: "reading-insight-v1",
};
const PROVIDER = "zhipu";
const DEFAULT_MODEL = "glm-4.7-flash";
const GLM_ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_DEFAULT_MODEL = "openrouter/free";
const DAILY_GENERATION_LIMIT: Record<TaskType, number> = {
  book_overview: 10,
  note_assistance: 20,
  reading_insight: 3,
};
const REQUEST_TIMEOUT_MS = 55_000;
const PROVIDER_PROBE_COOLDOWN_MS = 5 * 60_000;
type ProviderRoute = {
  provider: string;
  apiKeyEnv: string;
  modelEnv: string;
  defaultModel: string;
  tasks: readonly TaskType[];
  call: (
    apiKey: string,
    model: string,
    messages: Array<{ role: string; content: string }>,
    webSearch?: boolean,
  ) => Promise<ProviderCallOutput>;
};
const PROVIDER_ROUTES: ProviderRoute[] = [
  {
    provider: PROVIDER,
    apiKeyEnv: "GLM_API_KEY",
    modelEnv: "GLM_MODEL",
    defaultModel: DEFAULT_MODEL,
    tasks: TASK_TYPES,
    call: callGlm,
  },
  {
    provider: "openrouter",
    apiKeyEnv: "OPENROUTER_API_KEY",
    modelEnv: "OPENROUTER_MODEL",
    defaultModel: OPENROUTER_DEFAULT_MODEL,
    tasks: ["book_overview"],
    call: callOpenRouter,
  },
];
const NOTE_FIELDS = ["summary", "concepts", "thoughts", "actions"] as const;
const NOTE_OPERATIONS = ["regenerate", "generate", "polish"] as const;
type ProviderCallOutput = Awaited<ReturnType<typeof callGlm>> & { resolvedModel?: string };
type ProviderCallResult = ProviderCallOutput & { attempts: number };
const inFlightRequests = new Map<string, Promise<ProviderCallResult>>();
const providerProbeTimes = new Map<string, number>();
const providerCircuits = new ProviderCircuitRegistry();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type GatewayBody = {
  taskType?: string;
  bookId?: string;
  forceRefresh?: boolean;
  field?: string;
  operation?: string;
  year?: number;
  cacheOnly?: boolean;
};

type UsageStatus = { limit: number; used: number; remaining: number };

type ProviderResult = ProviderCallOutput & {
  attempts: number;
  provider: string;
  model: string;
  fallbackIndex: number;
};

type ProviderFailure = Error & {
  code: string;
  status: number;
  retryable: boolean;
  retryAfterMs: number;
  attempts?: number;
  provider?: string;
  model?: string;
  fallbackIndex?: number;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function safeErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    AUTH: "平台 AI 服务暂时无法授权，请稍后重试",
    RATE_LIMIT: "AI 服务当前繁忙，请稍后重试",
    TIMEOUT: "AI 服务响应超时，请稍后重试",
    NETWORK: "暂时无法连接 AI 服务，请稍后重试",
    UNAVAILABLE: "AI 服务暂时不可用，请稍后重试",
    INVALID_RESPONSE: "AI 返回内容无法识别，本次结果未保存",
    BUDGET: "平台 AI 额度暂时不可用，请稍后重试",
    NOT_CONFIGURED: "平台 AI 服务尚未配置",
    CIRCUIT_OPEN: "AI 服务连续失败，已暂时进入冷却状态，请稍后重试",
    REQUEST: "AI 请求暂时无法处理，请稍后重试",
  };
  return messages[code] ?? "内容概要生成失败，请稍后重试";
}

function providerFailure(
  code: string,
  status = 0,
  retryable = false,
  retryAfterMs = 0,
): ProviderFailure {
  return Object.assign(new Error(code), { code, status, retryable, retryAfterMs });
}

function nextUtcDayStart(): string {
  const next = new Date();
  next.setUTCDate(next.getUTCDate() + 1);
  next.setUTCHours(0, 0, 0, 0);
  return next.toISOString();
}

async function getDailyUsage(
  adminClient: SupabaseClient<any, "public", any>,
  userId: string,
  taskType: TaskType,
  dayStart: string,
): Promise<UsageStatus> {
  const { count, error } = await adminClient
    .from("ai_generations")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("task_type", taskType)
    .eq("cache_hit", false)
    .gte("created_at", dayStart);
  if (error) throw error;
  const used = count ?? 0;
  const limit = DAILY_GENERATION_LIMIT[taskType];
  return { limit, used, remaining: Math.max(0, limit - used) };
}

function classifyProviderResponse(response: Response, payload: Record<string, unknown>): ProviderFailure {
  const status = response.status;
  const rawError = payload.error as { message?: unknown } | undefined;
  const message = String(rawError?.message ?? payload.message ?? "").toLocaleLowerCase();
  const retryAfterSeconds = Number(response.headers.get("retry-after") ?? 0);
  const retryAfterMs = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : 0;

  if (status === 401 || status === 403) return providerFailure("AUTH", status);
  if (/insufficient.*(credit|quota)|quota exceeded|余额不足|额度不足/.test(message)) {
    return providerFailure("BUDGET", status);
  }
  if (status === 429 || /rate.?limit|too many|繁忙|过多|限流/.test(message)) {
    return providerFailure("RATE_LIMIT", status, true, retryAfterMs);
  }
  if (status === 408) return providerFailure("TIMEOUT", status, true);
  if (status >= 500) return providerFailure("UNAVAILABLE", status, true);
  return providerFailure("REQUEST", status);
}

function normalizeProviderFailure(error: unknown): ProviderFailure {
  if (error && typeof error === "object" && "code" in error && "retryable" in error) {
    return error as ProviderFailure;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return providerFailure("TIMEOUT", 0, true);
  }
  if (error instanceof TypeError) return providerFailure("NETWORK", 0, true);
  return providerFailure("UNAVAILABLE", 0, false);
}

function normalizeMetadata(value: unknown): string {
  return String(value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

async function fetchBookMetadata(url: URL): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6_500);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "ReadingCosmos/1.0 (https://github.com/cosmovia/reading-cosmos)" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`BOOK_METADATA_HTTP_${response.status}`);
    return await response.json() as Record<string, unknown>;
  } finally {
    clearTimeout(timeout);
  }
}

async function findOpenLibraryCover(title: string, author: string): Promise<string> {
  for (const query of buildBookSearchQueries(title, author)) {
    const url = new URL("https://openlibrary.org/search.json");
    url.search = new URLSearchParams({
      ...query,
      limit: "10",
      fields: "title,author_name,cover_i",
    }).toString();
    const payload = await fetchBookMetadata(url);
    const docs = Array.isArray(payload.docs) ? payload.docs as Array<Record<string, unknown>> : [];
    const candidates = docs.map((item) => {
      const coverId = Number(item.cover_i ?? 0);
      const coverUrl = coverId > 0 ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg` : "";
      return {
        coverUrl,
        score: scoreBookMetadataCandidate(title, author, item.title, item.author_name, coverUrl),
      };
    }).sort((a, b) => b.score - a.score);
    if (candidates[0]?.score >= 10) return safeBookCoverUrl(candidates[0].coverUrl);
  }
  return "";
}

async function findGoogleBooksCover(title: string, author: string): Promise<string> {
  const apiKey = Deno.env.get("GOOGLE_BOOKS_API_KEY")?.trim();
  for (const query of buildBookSearchQueries(title, author)) {
    const url = new URL("https://www.googleapis.com/books/v1/volumes");
    url.search = buildGoogleBooksSearchParams(query, apiKey).toString();
    const payload = await fetchBookMetadata(url);
    const items = Array.isArray(payload.items) ? payload.items as Array<Record<string, unknown>> : [];
    const candidates = items.map((item) => {
      const info = item.volumeInfo as Record<string, unknown> | undefined;
      const coverUrl = selectGoogleBooksCover(info?.imageLinks);
      return {
        coverUrl,
        score: scoreBookMetadataCandidate(title, author, info?.title, info?.authors, coverUrl),
      };
    }).sort((a, b) => b.score - a.score);
    if (candidates[0]?.score >= 10) return candidates[0].coverUrl;
  }
  return "";
}

async function findBookCover(title: string, author: string): Promise<{ url: string; source: string } | null> {
  for (const source of [
    { name: "openlibrary", lookup: findOpenLibraryCover },
    { name: "google_books", lookup: findGoogleBooksCover },
  ]) {
    try {
      const url = await source.lookup(title, author);
      if (url) return { url, source: source.name };
    } catch (error) {
      console.warn(`book cover source failed: ${source.name}`, error);
    }
  }
  return null;
}

function readRasterDimensions(bytes: Uint8Array, contentType: string): { width: number; height: number } | null {
  if (contentType === "image/png" && bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (contentType === "image/jpeg" && bytes.length >= 10 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
      const length = (bytes[offset + 2] << 8) + bytes[offset + 3];
      if (length < 2 || offset + 2 + length > bytes.length) break;
      if (sofMarkers.has(marker)) {
        return {
          height: (bytes[offset + 5] << 8) + bytes[offset + 6],
          width: (bytes[offset + 7] << 8) + bytes[offset + 8],
        };
      }
      offset += 2 + length;
    }
  }
  return null;
}

async function storeVerifiedBookCover(
  adminClient: SupabaseClient<any, "public", any>,
  userId: string,
  bookId: string,
  sourceUrl: string,
  sourceName: string,
  requestId: string,
): Promise<string> {
  const logRejection = (reason: string, details: Record<string, unknown> = {}) => {
    console.warn("book cover rejected", { requestId, bookId, source: sourceName, reason, ...details });
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(sourceUrl, {
      headers: { "User-Agent": "ReadingCosmos/1.0 (https://github.com/cosmovia/reading-cosmos)" },
      signal: controller.signal,
    });
    if (!response.ok) {
      logRejection("source_http", { status: response.status });
      return "";
    }
    const contentType = String(response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!new Set(["image/jpeg", "image/png"]).has(contentType)) {
      logRejection("content_type", { contentType });
      return "";
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length < 4096 || bytes.length > 5 * 1024 * 1024) {
      logRejection("file_size", { bytes: bytes.length });
      return "";
    }
    const dimensions = readRasterDimensions(bytes, contentType);
    if (!dimensions) {
      logRejection("dimensions_unreadable", { contentType, bytes: bytes.length });
      return "";
    }
    if (dimensions.width < 240 || dimensions.height < 300) {
      logRejection("dimensions_too_small", dimensions);
      return "";
    }
    const extension = contentType === "image/png" ? "png" : "jpg";
    const objectPath = `${userId}/${bookId}.${extension}`;
    const { error } = await adminClient.storage.from("book-covers").upload(objectPath, bytes, {
      contentType,
      cacheControl: "31536000",
      upsert: true,
    });
    if (error) {
      logRejection("storage_upload", { message: error.message });
      return "";
    }
    return adminClient.storage.from("book-covers").getPublicUrl(objectPath).data.publicUrl;
  } catch (error) {
    logRejection("fetch_exception", { message: error instanceof Error ? error.message : String(error) });
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function buildOverviewMessages(book: { title: string; author: string | null; category: string | null }) {
  return [
    {
      role: "system",
      content: "你是 Reading Cosmos 的书籍内容编辑。请先使用联网搜索核对可靠的书籍资料，再生成供已读完本书的用户长期回看使用的完整内容概要。概要属于独立书籍资料层，禁止使用、推断或提及用户笔记。不得虚构情节、观点、章节、引文或作者立场；资料冲突时要明确说明。",
    },
    {
      role: "user",
      content: `请联网检索并精炼《${book.title}》（作者：${book.author || "未知"}，分类：${book.category || "未分类"}）的内容概要。\n\n用户已经读完本书，可以包含完整论述、关键情节与结局，不需要避免剧透。请以 500–900 字中文覆盖：\n1. 写作背景与核心主题；\n2. 全书结构、主要论述或故事发展；\n3. 关键概念、人物与转折；\n4. 最终结论、结局及全书价值。\n\n只输出概要正文，不引用或猜测用户笔记；不要把搜索摘要原样拼接。若存在同名书或版本差异，先依据作者消歧，并在正文中简短说明。`,
    },
  ];
}

function buildNoteAssistanceMessages(
  book: {
    title: string;
    author: string | null;
    category: string | null;
    rating: number | null;
    note_method: string | null;
    notes_revision: number | null;
    summary: string | null;
    concepts: string | null;
    thoughts: string | null;
    actions: string | null;
  },
  field: string,
  operation: string,
) {
  const fieldLabels: Record<string, string> = {
    summary: "全书摘要",
    concepts: "核心问题或角色线索",
    thoughts: "核心概念或阅读共鸣",
    actions: "底层原理或行动启发",
  };
  const operationInstructions: Record<string, string> = {
    regenerate: "给出一份独立的 AI 建议，不冒充用户结论。",
    generate: "补充新的分析视角，指出它与用户原笔记的关系。",
    polish: "只提出结构、表达与论证的修改建议，不直接改写或覆盖用户笔记。",
  };
  const notes = NOTE_FIELDS
    .map((key) => `${fieldLabels[key]}：${String(book[key] ?? "").trim() || "（用户尚未记录）"}`)
    .join("\n");
  return [
    {
      role: "system",
      content: "你是 Reading Cosmos 的阅读思考助手。用户笔记永远高于 AI 输出。你必须明确区分事实、用户观点与 AI 建议；不得虚构书中内容，不得声称已读过未提供的原文；用简洁中文回答。",
    },
    {
      role: "user",
      content: `请处理“${fieldLabels[field]}”模块。\n任务：${operationInstructions[operation]}\n\n书籍：${book.title}\n作者：${book.author || "未知"}\n分类：${book.category || "未分类"}\n评分：${book.rating || 0}/5\n笔记方法：${book.note_method || "未设置"}\n笔记版本：${Number(book.notes_revision || 0)}\n\n用户保存的笔记：\n${notes}\n\n请输出只供当前编辑会话参考的 AI 建议，不要复述系统规则。`,
    },
  ];
}

function buildReadingInsightMessages(
  books: Array<{
    title: string;
    author: string | null;
    category: string | null;
    rating: number | null;
    timestamp: number | null;
    note_method: string | null;
    summary: string | null;
    concepts: string | null;
    thoughts: string | null;
    actions: string | null;
  }>,
  year: number,
) {
  const readingContext = books.map((book) => ({
    title: book.title,
    author: book.author,
    category: book.category,
    rating: book.rating,
    addedAt: book.timestamp ? new Date(book.timestamp).toISOString().slice(0, 10) : null,
    noteMethod: book.note_method,
    notes: {
      summary: book.summary,
      concepts: book.concepts,
      thoughts: book.thoughts,
      actions: book.actions,
    },
  }));
  return [
    {
      role: "system",
      content: "你是 Reading Cosmos 的阅读数据分析助手。用户笔记是最高优先级证据。只根据提供的书籍与笔记识别阅读特征，不虚构阅读经历、书中内容或用户观点。推荐路线要解释与现有阅读结构的关系。只输出合法 JSON，不要使用 Markdown。",
    },
    {
      role: "user",
      content: `请分析 ${year} 年及当前累计阅读宇宙。输出 JSON：{"personaTitle":"不超过18字","personaDescription":"80-140字","cognitiveFocus":"80-140字","readingRoute":[{"title":"书名","reason":"50-100字"}],"annualReport":"160-260字"}。readingRoute 给出 2-3 本延伸书籍；若证据不足应明确使用“初步”措辞。\n\n阅读数据：\n${JSON.stringify(readingContext)}`,
    },
  ];
}

function parseReadingInsight(content: string): Record<string, unknown> {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    throw providerFailure("INVALID_RESPONSE", 0, true);
  }
  const route = Array.isArray(parsed.readingRoute) ? parsed.readingRoute.slice(0, 3) : [];
  const normalizedRoute = route.map((item) => {
    const entry = item as Record<string, unknown>;
    return { title: String(entry.title ?? "").trim(), reason: String(entry.reason ?? "").trim() };
  }).filter((item) => item.title && item.reason);
  const result = {
    personaTitle: String(parsed.personaTitle ?? "").trim(),
    personaDescription: String(parsed.personaDescription ?? "").trim(),
    cognitiveFocus: String(parsed.cognitiveFocus ?? "").trim(),
    readingRoute: normalizedRoute,
    annualReport: String(parsed.annualReport ?? "").trim(),
  };
  if (!result.personaTitle || !result.personaDescription || !result.cognitiveFocus ||
    !result.annualReport || result.readingRoute.length < 2) {
    throw providerFailure("INVALID_RESPONSE", 0, true);
  }
  return result;
}

function getProviderCircuit(provider: string) {
  return providerCircuits.get(provider);
}

async function executeRouteWithReliability(
  key: string,
  route: ProviderRoute,
  apiKey: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  webSearch = false,
): Promise<ProviderCallResult> {
  const providerCircuit = getProviderCircuit(route.provider);
  if (providerCircuit.openUntil > Date.now()) throw providerFailure("CIRCUIT_OPEN");
  const existing = inFlightRequests.get(key);
  if (existing) return existing;

  const request = (async () => {
    let finalFailure: ProviderFailure | null = null;
    let attemptCount = 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      attemptCount += 1;
      try {
        const result = await route.call(apiKey, model, messages, webSearch);
        providerCircuits.recordSuccess(route.provider);
        return { ...result, attempts: attempt + 1 };
      } catch (rawError) {
        finalFailure = normalizeProviderFailure(rawError);
        if (!finalFailure.retryable || attempt === 1) break;
        const jitterMs = 650 + Math.floor(Math.random() * 550);
        const delayMs = Math.min(5_000, Math.max(jitterMs, finalFailure.retryAfterMs));
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    const failure = finalFailure ?? providerFailure("UNAVAILABLE");
    if (failure.retryable) {
      providerCircuits.recordRetryableFailure(route.provider);
    }
    failure.attempts = attemptCount;
    throw failure;
  })();
  inFlightRequests.set(key, request);
  try {
    return await request;
  } finally {
    inFlightRequests.delete(key);
  }
}

async function executeProviderRoutes(
  key: string,
  taskType: TaskType,
  messages: Array<{ role: string; content: string }>,
  webSearch = false,
): Promise<ProviderResult> {
  const routes = PROVIDER_ROUTES.map((route) => {
    const apiKey = Deno.env.get(route.apiKeyEnv) ?? "";
    const model = Deno.env.get(route.modelEnv) || route.defaultModel;
    return {
      provider: route.provider,
      model,
      configured: Boolean(apiKey),
      tasks: route.tasks,
      execute: () => executeRouteWithReliability(
        `${key}|${route.provider}|${model}`,
        route,
        apiKey,
        model,
        messages,
        webSearch,
      ),
    };
  });
  return await executeTaskProviderRoutes(taskType, routes);
}

async function callGlm(
  apiKey: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  webSearch = false,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(GLM_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.35,
        stream: false,
        ...(webSearch
          ? {
            tools: [{
              type: "web_search",
              web_search: {
                enable: true,
                search_engine: "search_std",
                search_result: true,
                count: 8,
                search_recency_filter: "noLimit",
                content_size: "high",
              },
            }],
            tool_choice: "auto",
          }
          : {}),
      }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw classifyProviderResponse(response, payload);

    const choices = payload.choices as Array<{ message?: { content?: unknown } }> | undefined;
    const content = choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw providerFailure("INVALID_RESPONSE", response.status, true);
    }
    const webSearchResults = Array.isArray(payload.web_search) ? payload.web_search : [];
    const sources = webSearchResults.slice(0, 12).map((item) => {
      const source = item as Record<string, unknown>;
      return {
        title: String(source.title ?? ""),
        link: String(source.link ?? ""),
        media: String(source.media ?? ""),
        publishDate: String(source.publish_date ?? ""),
      };
    });
    const usage = payload.usage as Record<string, unknown> | undefined;
    return {
      content: content.trim(),
      sources,
      inputTokens: Number(usage?.prompt_tokens ?? 0) || null,
      outputTokens: Number(usage?.completion_tokens ?? 0) || null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function callOpenRouter(
  apiKey: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  webSearch = false,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const fallbackMessages = [
      {
        role: "system",
        content: "当前备用模型不保证具备实时联网检索能力。不得声称已经联网或引用未经核验的来源；只使用可靠的通用知识，无法确认的版本、情节或事实必须明确说明不确定。",
      },
      ...messages,
      ...(webSearch
        ? [{
          role: "system",
          content: "本次请求没有可用的搜索或函数工具。禁止输出思考过程、搜索指令、函数调用或任何 XML 标记；请直接输出完整的最终中文概要正文。",
        }]
        : []),
    ];
    const response = await fetch(OPENROUTER_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://cosmovia.github.io/reading-cosmos/",
        "X-OpenRouter-Title": "Reading Cosmos",
      },
      body: JSON.stringify({
        model,
        messages: fallbackMessages,
        temperature: 0.35,
        max_tokens: 1_800,
        stream: false,
        provider: { allow_fallbacks: true },
      }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw classifyProviderResponse(response, payload);

    const choices = payload.choices as Array<{ message?: { content?: unknown } }> | undefined;
    const content = choices?.[0]?.message?.content;
    if (!isUsableProviderContent(content, webSearch)) {
      throw providerFailure("INVALID_RESPONSE", response.status, true);
    }
    const usage = payload.usage as Record<string, unknown> | undefined;
    return {
      content: content.trim(),
      sources: [],
      inputTokens: Number(usage?.prompt_tokens ?? 0) || null,
      outputTokens: Number(usage?.completion_tokens ?? 0) || null,
      resolvedModel: String(payload.model ?? model),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildTaskServiceStatus(
  taskType: TaskType,
  configuredRoutes: ProviderRoute[],
  now = Date.now(),
) {
  const taskRoutes = configuredRoutes.filter((route) => route.tasks.includes(taskType));
  const routeStates = taskRoutes.map((route) => ({
    route,
    circuit: getProviderCircuit(route.provider),
  }));
  const availableRouteState = routeStates.find(({ circuit }) => circuit.openUntil <= now);
  const statusRoute = availableRouteState?.route ?? taskRoutes[0] ?? null;
  const allCircuitsOpen = routeStates.length > 0 && !availableRouteState;
  return {
    status: taskRoutes.length === 0 ? "not_configured" : allCircuitsOpen ? "cooling_down" : "available",
    activeProvider: statusRoute?.provider ?? null,
    activeModel: statusRoute ? Deno.env.get(statusRoute.modelEnv) || statusRoute.defaultModel : null,
    fallbackEnabled: taskRoutes.length > 1,
    availableAt: allCircuitsOpen
      ? new Date(Math.min(...routeStates.map(({ circuit }) => circuit.openUntil))).toISOString()
      : null,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: { code: "METHOD_NOT_ALLOWED" } }, 405);

  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return jsonResponse({ requestId, error: { code: "UNAUTHORIZED", message: "请先登录" } }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const configuredRoutes = PROVIDER_ROUTES.filter((route) => Boolean(Deno.env.get(route.apiKeyEnv)));
  const activeRoute = configuredRoutes[0] ?? PROVIDER_ROUTES[0];

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const token = authHeader.slice("Bearer ".length);
  const { data: userData, error: userError } = await userClient.auth.getUser(token);
  if (userError || !userData.user) {
    return jsonResponse({ requestId, error: { code: "UNAUTHORIZED", message: "登录状态已失效" } }, 401);
  }

  let body: GatewayBody;
  try {
    body = await req.json() as GatewayBody;
  } catch {
    return jsonResponse({ requestId, error: { code: "INVALID_REQUEST", message: "请求格式无效" } }, 400);
  }
  if (body.taskType === "service_status") {
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    try {
      const [bookOverview, noteAssistance, readingInsight, settingsResult] = await Promise.all([
        getDailyUsage(adminClient, userData.user.id, "book_overview", dayStart.toISOString()),
        getDailyUsage(adminClient, userData.user.id, "note_assistance", dayStart.toISOString()),
        getDailyUsage(adminClient, userData.user.id, "reading_insight", dayStart.toISOString()),
        userClient.from("user_settings").select("ai_note_consent_at, ai_insight_consent_at").eq("user_id", userData.user.id).maybeSingle(),
      ]);
      if (settingsResult.error) throw settingsResult.error;
      const taskStatus = {
        bookOverview: buildTaskServiceStatus("book_overview", configuredRoutes),
        noteAssistance: buildTaskServiceStatus("note_assistance", configuredRoutes),
        readingInsight: buildTaskServiceStatus("reading_insight", configuredRoutes),
      };
      return jsonResponse({
        requestId,
        gateway: {
          status: taskStatus.bookOverview.status,
          activeProvider: taskStatus.bookOverview.activeProvider,
          activeModel: taskStatus.bookOverview.activeModel,
          fallbackEnabled: taskStatus.bookOverview.fallbackEnabled,
          configuredProviders: configuredRoutes.map((route) => route.provider),
          availableAt: taskStatus.bookOverview.availableAt,
          tasks: taskStatus,
        },
        quota: { bookOverview, noteAssistance, readingInsight, resetsAt: nextUtcDayStart() },
        consent: {
          noteAssistance: Boolean(settingsResult.data?.ai_note_consent_at),
          readingInsight: Boolean(settingsResult.data?.ai_insight_consent_at),
        },
      });
    } catch {
      return jsonResponse({ requestId, error: { code: "DATABASE", message: "暂时无法读取平台 AI 状态" } }, 500);
    }
  }
  if (body.taskType === "provider_probe") {
    const route = configuredRoutes.find((item) => item.provider === "openrouter");
    if (!route) {
      return jsonResponse({
        requestId,
        error: { code: "NOT_CONFIGURED", message: "OpenRouter 备用路由尚未配置" },
      }, 503);
    }
    const previousProbeAt = providerProbeTimes.get(userData.user.id) ?? 0;
    const retryAfterMs = previousProbeAt + PROVIDER_PROBE_COOLDOWN_MS - Date.now();
    if (retryAfterMs > 0) {
      return jsonResponse({
        requestId,
        error: {
          code: "PROBE_COOLDOWN",
          message: "备用路由刚刚验证过，请稍后再试",
          retryAfterSeconds: Math.ceil(retryAfterMs / 1_000),
        },
      }, 429);
    }
    providerProbeTimes.set(userData.user.id, Date.now());
    const apiKey = Deno.env.get(route.apiKeyEnv) ?? "";
    const model = Deno.env.get(route.modelEnv) || route.defaultModel;
    try {
      const result = await executeRouteWithReliability(
        `probe|${userData.user.id}|${route.provider}|${model}`,
        route,
        apiKey,
        model,
        [
          { role: "system", content: "这是服务连通性检查。不得索取或推断用户信息。" },
          { role: "user", content: "请只回复 READY。" },
        ],
      );
      return jsonResponse({
        requestId,
        probe: {
          status: "available",
          provider: route.provider,
          model: result.resolvedModel || model,
          attempts: result.attempts,
        },
      });
    } catch (rawError) {
      const failure = normalizeProviderFailure(rawError);
      return jsonResponse({
        requestId,
        error: { code: failure.code, message: safeErrorMessage(failure.code) },
      }, failure.status || 503);
    }
  }
  if (body.taskType === "book_cover") {
    if (!body.bookId) {
      return jsonResponse({ requestId, error: { code: "INVALID_REQUEST", message: "缺少书籍标识" } }, 400);
    }
    const { data: book, error: bookError } = await userClient
      .from("books")
      .select("id, title, author, cover_url")
      .eq("id", body.bookId)
      .maybeSingle();
    if (bookError) {
      return jsonResponse({ requestId, error: { code: "DATABASE", message: "暂时无法读取书籍" } }, 500);
    }
    if (!book) return jsonResponse({ requestId, error: { code: "NOT_FOUND", message: "未找到这本书" } }, 404);
    const cachedUrl = safeBookCoverUrl(book.cover_url);
    if (cachedUrl && isManagedBookCoverUrl(cachedUrl)) {
      return jsonResponse({ requestId, cover: { url: cachedUrl, source: "cache", cacheHit: true } });
    }
    const cover = await findBookCover(String(book.title ?? ""), String(book.author ?? ""));
    if (!cover) {
      return jsonResponse({ requestId, cover: { url: null, source: null, cacheHit: false } });
    }
    const storedCoverUrl = await storeVerifiedBookCover(
      adminClient,
      userData.user.id,
      String(book.id),
      cover.url,
      cover.source,
      requestId,
    );
    if (!storedCoverUrl) {
      return jsonResponse({ requestId, cover: { url: null, source: cover.source, cacheHit: false } });
    }
    const { error: updateError } = await userClient
      .from("books")
      .update({ cover_url: storedCoverUrl, updated_at: new Date().toISOString() })
      .eq("id", book.id);
    if (updateError) {
      return jsonResponse({ requestId, error: { code: "DATABASE", message: "暂时无法保存书籍封面" } }, 500);
    }
    return jsonResponse({ requestId, cover: { url: storedCoverUrl, source: cover.source, cacheHit: false } });
  }
  if (!TASK_TYPES.includes(body.taskType as TaskType)) {
    return jsonResponse({ requestId, error: { code: "INVALID_REQUEST", message: "不支持的 AI 任务" } }, 400);
  }
  const taskType = body.taskType as TaskType;
  const taskPrimaryRoute = configuredRoutes.find((route) => route.tasks.includes(taskType)) ??
    PROVIDER_ROUTES.find((route) => route.tasks.includes(taskType)) ?? activeRoute;
  const taskPrimaryModel = Deno.env.get(taskPrimaryRoute.modelEnv) || taskPrimaryRoute.defaultModel;
  if (taskType !== "reading_insight" && !body.bookId) {
    return jsonResponse({ requestId, error: { code: "INVALID_REQUEST", message: "缺少书籍标识" } }, 400);
  }
  const promptVersion = PROMPT_VERSIONS[taskType];
  if (taskType === "note_assistance" &&
    (!NOTE_FIELDS.includes(body.field as typeof NOTE_FIELDS[number]) ||
      !NOTE_OPERATIONS.includes(body.operation as typeof NOTE_OPERATIONS[number]))) {
    return jsonResponse({ requestId, error: { code: "INVALID_REQUEST", message: "笔记辅助参数无效" } }, 400);
  }

  if (taskType === "note_assistance" || taskType === "reading_insight") {
    const { data: settings, error: settingsError } = await userClient
      .from("user_settings")
      .select("ai_note_consent_at, ai_insight_consent_at")
      .eq("user_id", userData.user.id)
      .maybeSingle();
    if (settingsError) return jsonResponse({ requestId, error: { code: "DATABASE", message: "暂时无法确认 AI 授权状态" } }, 500);
    const consented = taskType === "note_assistance"
      ? Boolean(settings?.ai_note_consent_at)
      : Boolean(settings?.ai_insight_consent_at);
    if (!consented) {
      return jsonResponse({
        requestId,
        error: {
          code: "CONSENT_REQUIRED",
          message: taskType === "note_assistance" ? "请先确认笔记 AI 数据处理说明" : "请先确认阅读洞察 AI 数据处理说明",
        },
      }, 403);
    }
  }

  let book: Record<string, any> | null = null;
  let insightBooks: Array<Record<string, any>> = [];
  if (taskType === "reading_insight") {
    const { data, error } = await userClient
      .from("books")
      .select("id, title, author, category, rating, timestamp, note_method, notes_revision, summary, concepts, thoughts, actions, updated_at")
      .order("id", { ascending: true });
    if (error) return jsonResponse({ requestId, error: { code: "DATABASE", message: "暂时无法读取阅读数据" } }, 500);
    insightBooks = data ?? [];
    if (insightBooks.length === 0) {
      return jsonResponse({ requestId, error: { code: "INSUFFICIENT_DATA", message: "至少添加一本书后才能生成阅读洞察" } }, 400);
    }
  } else {
    const { data, error } = await userClient
      .from("books")
      .select("id, user_id, title, author, category, rating, note_method, notes_revision, summary, concepts, thoughts, actions")
      .eq("id", body.bookId)
      .maybeSingle();
    if (error) return jsonResponse({ requestId, error: { code: "DATABASE", message: "暂时无法读取书籍" } }, 500);
    if (!data) return jsonResponse({ requestId, error: { code: "NOT_FOUND", message: "未找到这本书" } }, 404);
    book = data;
  }

  const insightYear = Number.isInteger(body.year) && Number(body.year) >= 2000 && Number(body.year) <= 2100
    ? Number(body.year)
    : new Date().getUTCFullYear();
  const sourceRevision = taskType === "reading_insight"
    ? insightBooks.reduce((sum, item) => sum + Number(item.notes_revision || 0), insightBooks.length)
    : 0;
  const scopeKey = taskType === "reading_insight" ? `reading:annual:${insightYear}` : `book:${book!.id}`;
  const inputHash = taskType === "reading_insight"
    ? await sha256(JSON.stringify({
      taskType,
      year: insightYear,
      promptVersion,
      books: insightBooks.map((item) => ({
        id: item.id,
        title: normalizeMetadata(item.title),
        author: normalizeMetadata(item.author),
        category: normalizeMetadata(item.category),
        rating: Number(item.rating || 0),
        timestamp: Number(item.timestamp || 0),
        notesRevision: Number(item.notes_revision || 0),
        summary: normalizeMetadata(item.summary),
        concepts: normalizeMetadata(item.concepts),
        thoughts: normalizeMetadata(item.thoughts),
        actions: normalizeMetadata(item.actions),
      })),
    }))
    : await sha256([
      taskType,
      normalizeMetadata(book!.title),
      normalizeMetadata(book!.author),
      normalizeMetadata(book!.category),
      String(sourceRevision),
      promptVersion,
    ].join("|"));

  if ((taskType === "book_overview" || taskType === "reading_insight") && !body.forceRefresh) {
    const { data: cached } = await userClient
      .from("ai_artifacts")
      .select("id, content, sources, provider, model, generated_at, prompt_version")
      .eq("task_type", taskType)
      .eq("scope_key", scopeKey)
      .eq("input_hash", inputHash)
      .eq("prompt_version", promptVersion)
      .maybeSingle();
    if (cached) {
      return jsonResponse({
        requestId,
        cacheHit: true,
        attempts: 0,
        artifact: {
          id: cached.id,
          content: taskType === "reading_insight" ? cached.content : cached.content?.text ?? "",
          sources: cached.sources ?? [],
          provider: cached.provider,
          model: cached.model,
          generatedAt: cached.generated_at,
          promptVersion: cached.prompt_version,
        },
      });
    }
    if (taskType === "reading_insight" && body.cacheOnly) {
      return jsonResponse({ requestId, cacheHit: false, cacheMiss: true });
    }
  }

  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  let dailyUsage: UsageStatus;
  try {
    dailyUsage = await getDailyUsage(adminClient, userData.user.id, taskType, dayStart.toISOString());
  } catch {
    return jsonResponse({ requestId, error: { code: "DATABASE", message: "暂时无法检查 AI 额度" } }, 500);
  }
  const dailyLimit = dailyUsage.limit;
  const dailyCount = dailyUsage.used;
  if (dailyUsage.remaining <= 0) {
    return jsonResponse({
      requestId,
      error: {
        code: "DAILY_LIMIT",
        message: `今日${taskType === "book_overview" ? "概要生成" : taskType === "note_assistance" ? "笔记辅助" : "阅读洞察重新分析"}已达到 ${dailyLimit} 次`,
        limit: dailyLimit,
        remaining: 0,
        availableAt: nextUtcDayStart(),
      },
    }, 429);
  }
  if (configuredRoutes.length === 0) {
    return jsonResponse({ requestId, error: { code: "GATEWAY_NOT_CONFIGURED", message: "平台 AI 服务尚未配置" } }, 503);
  }

  const messages = taskType === "book_overview"
    ? buildOverviewMessages(book! as any)
    : taskType === "note_assistance"
    ? buildNoteAssistanceMessages(book! as any, body.field!, body.operation!)
    : buildReadingInsightMessages(insightBooks as any, insightYear);
  const dedupeKey = [
    userData.user.id,
    taskType,
    book?.id || scopeKey,
    body.field || "",
    body.operation || "",
    String(book?.notes_revision || sourceRevision),
    inputHash,
  ].join("|");
  try {
    const result = await executeProviderRoutes(
      dedupeKey,
      taskType,
      messages,
      taskType === "book_overview",
    );
    const generatedAt = new Date().toISOString();
    const insightContent = taskType === "reading_insight" ? parseReadingInsight(result.content) : null;
    let artifactId: string | null = null;
    if (taskType === "book_overview" || taskType === "reading_insight") {
      const { data: artifact, error: artifactError } = await adminClient
        .from("ai_artifacts")
        .upsert({
          user_id: userData.user.id,
          book_id: book?.id || null,
          task_type: taskType,
          scope_key: scopeKey,
          input_hash: inputHash,
          source_revision: sourceRevision,
          prompt_version: promptVersion,
          content: taskType === "reading_insight" ? insightContent : { text: result.content },
          sources: taskType === "reading_insight" ? [] : result.sources,
          provider: result.provider,
          model: result.model,
          generated_at: generatedAt,
          expires_at: null,
        }, { onConflict: "user_id,task_type,scope_key,input_hash,prompt_version" })
        .select("id")
        .single();
      if (artifactError) throw providerFailure("UNAVAILABLE");
      artifactId = artifact.id;
    }

    await adminClient.from("ai_generations").insert({
        request_id: requestId,
        user_id: userData.user.id,
        book_id: book?.id || null,
        task_type: taskType,
        provider: result.provider,
        model: result.model,
        status: "succeeded",
        latency_ms: Date.now() - startedAt,
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        cache_hit: false,
        fallback_index: result.fallbackIndex,
        prompt_version: promptVersion,
        attempts: result.attempts,
      });
    if (taskType === "note_assistance") {
      return jsonResponse({
        requestId,
        attempts: result.attempts,
        remaining: Math.max(0, dailyLimit - dailyCount - 1),
        suggestion: { content: result.content, provider: result.provider, model: result.model, generatedAt, promptVersion },
      });
    }
    if (taskType === "reading_insight") {
      return jsonResponse({
        requestId,
        cacheHit: false,
        attempts: result.attempts,
        remaining: Math.max(0, dailyLimit - dailyCount - 1),
        artifact: {
          id: artifactId,
          content: insightContent,
          sources: [],
          provider: result.provider,
          model: result.model,
          generatedAt,
          promptVersion,
        },
      });
    }
    return jsonResponse({
      requestId,
      cacheHit: false,
      attempts: result.attempts,
      remaining: Math.max(0, dailyLimit - dailyCount - 1),
      artifact: {
        id: artifactId,
        content: result.content,
        sources: result.sources,
        provider: result.provider,
        model: result.model,
        generatedAt,
        promptVersion,
      },
    });
  } catch (rawError) {
    const failure = normalizeProviderFailure(rawError);
    const failedProvider = failure.provider || taskPrimaryRoute.provider;
    const failedModel = failure.model || taskPrimaryModel;
    const failedCircuit = getProviderCircuit(failedProvider);
    await adminClient.from("ai_generations").insert({
      request_id: requestId,
      user_id: userData.user.id,
      book_id: book?.id || null,
      task_type: taskType,
      provider: failedProvider,
      model: failedModel,
      status: "failed",
      error_code: failure.code,
      latency_ms: Date.now() - startedAt,
      cache_hit: false,
      fallback_index: failure.fallbackIndex ?? 0,
      prompt_version: promptVersion,
      attempts: failure.attempts ?? 0,
    });
    const responseStatus = failure.code === "RATE_LIMIT" ? 429 : failure.code === "TIMEOUT" ? 504 : 503;
    return jsonResponse({
      requestId,
      error: {
        code: failure.code,
        message: safeErrorMessage(failure.code),
        retryAfterSeconds: failure.retryAfterMs > 0 ? Math.ceil(failure.retryAfterMs / 1000) : null,
        availableAt: failure.code === "CIRCUIT_OPEN" && failedCircuit.openUntil > Date.now()
          ? new Date(failedCircuit.openUntil).toISOString()
          : null,
      },
    }, responseStatus);
  }
});

