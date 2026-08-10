import "jsr:@supabase/functions-js@2.5.0/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const TASK_TYPES = ["book_overview", "note_assistance"] as const;
type TaskType = typeof TASK_TYPES[number];
const PROMPT_VERSIONS: Record<TaskType, string> = {
  book_overview: "book-overview-v1",
  note_assistance: "note-assistance-v1",
};
const PROVIDER = "zhipu";
const DEFAULT_MODEL = "glm-4.7-flash";
const GLM_ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const DAILY_GENERATION_LIMIT: Record<TaskType, number> = {
  book_overview: 10,
  note_assistance: 20,
};
const REQUEST_TIMEOUT_MS = 55_000;
const PROVIDER_ROUTES = [{ provider: PROVIDER, modelEnv: "GLM_MODEL", defaultModel: DEFAULT_MODEL }] as const;
const NOTE_FIELDS = ["summary", "concepts", "thoughts", "actions"] as const;
const NOTE_OPERATIONS = ["regenerate", "generate", "polish"] as const;
const inFlightRequests = new Map<string, Promise<ProviderResult>>();
const providerCircuit = { failures: 0, openUntil: 0 };

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
};

type UsageStatus = { limit: number; used: number; remaining: number };

type ProviderResult = Awaited<ReturnType<typeof callGlm>> & { attempts: number };

type ProviderFailure = Error & {
  code: string;
  status: number;
  retryable: boolean;
  retryAfterMs: number;
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

async function executeProviderWithReliability(
  key: string,
  apiKey: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
): Promise<ProviderResult> {
  if (providerCircuit.openUntil > Date.now()) throw providerFailure("CIRCUIT_OPEN");
  const existing = inFlightRequests.get(key);
  if (existing) return existing;

  const request = (async () => {
    let finalFailure: ProviderFailure | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await callGlm(apiKey, model, messages);
        providerCircuit.failures = 0;
        providerCircuit.openUntil = 0;
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
      providerCircuit.failures += 1;
      if (providerCircuit.failures >= 3) providerCircuit.openUntil = Date.now() + 5 * 60_000;
    }
    throw failure;
  })();
  inFlightRequests.set(key, request);
  try {
    return await request;
  } finally {
    inFlightRequests.delete(key);
  }
}

async function callGlm(apiKey: string, model: string, messages: Array<{ role: string; content: string }>) {
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
    const webSearch = Array.isArray(payload.web_search) ? payload.web_search : [];
    const sources = webSearch.slice(0, 12).map((item) => {
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
  const glmApiKey = Deno.env.get("GLM_API_KEY") ?? "";
  const model = Deno.env.get("GLM_MODEL") || DEFAULT_MODEL;

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
      const [bookOverview, noteAssistance, settingsResult] = await Promise.all([
        getDailyUsage(adminClient, userData.user.id, "book_overview", dayStart.toISOString()),
        getDailyUsage(adminClient, userData.user.id, "note_assistance", dayStart.toISOString()),
        userClient.from("user_settings").select("ai_note_consent_at").eq("user_id", userData.user.id).maybeSingle(),
      ]);
      if (settingsResult.error) throw settingsResult.error;
      const circuitOpen = providerCircuit.openUntil > Date.now();
      return jsonResponse({
        requestId,
        gateway: {
          status: !glmApiKey ? "not_configured" : circuitOpen ? "cooling_down" : "available",
          activeProvider: PROVIDER,
          activeModel: model,
          fallbackEnabled: PROVIDER_ROUTES.length > 1,
          availableAt: circuitOpen ? new Date(providerCircuit.openUntil).toISOString() : null,
        },
        quota: { bookOverview, noteAssistance, resetsAt: nextUtcDayStart() },
        consent: { noteAssistance: Boolean(settingsResult.data?.ai_note_consent_at) },
      });
    } catch {
      return jsonResponse({ requestId, error: { code: "DATABASE", message: "暂时无法读取平台 AI 状态" } }, 500);
    }
  }
  if (!TASK_TYPES.includes(body.taskType as TaskType) || !body.bookId) {
    return jsonResponse({ requestId, error: { code: "INVALID_REQUEST", message: "不支持的 AI 任务" } }, 400);
  }
  const taskType = body.taskType as TaskType;
  const promptVersion = PROMPT_VERSIONS[taskType];
  if (taskType === "note_assistance" &&
    (!NOTE_FIELDS.includes(body.field as typeof NOTE_FIELDS[number]) ||
      !NOTE_OPERATIONS.includes(body.operation as typeof NOTE_OPERATIONS[number]))) {
    return jsonResponse({ requestId, error: { code: "INVALID_REQUEST", message: "笔记辅助参数无效" } }, 400);
  }

  const { data: book, error: bookError } = await userClient
    .from("books")
    .select("id, user_id, title, author, category, rating, note_method, notes_revision, summary, concepts, thoughts, actions")
    .eq("id", body.bookId)
    .maybeSingle();
  if (bookError) return jsonResponse({ requestId, error: { code: "DATABASE", message: "暂时无法读取书籍" } }, 500);
  if (!book) return jsonResponse({ requestId, error: { code: "NOT_FOUND", message: "未找到这本书" } }, 404);

  if (taskType === "note_assistance") {
    const { data: settings, error: settingsError } = await userClient
      .from("user_settings")
      .select("ai_note_consent_at")
      .eq("user_id", userData.user.id)
      .maybeSingle();
    if (settingsError) return jsonResponse({ requestId, error: { code: "DATABASE", message: "暂时无法确认 AI 授权状态" } }, 500);
    if (!settings?.ai_note_consent_at) {
      return jsonResponse({ requestId, error: { code: "CONSENT_REQUIRED", message: "请先确认笔记 AI 数据处理说明" } }, 403);
    }
  }

  const scopeKey = `book:${book.id}`;
  const sourceRevision = 0;
  const inputHash = await sha256([
    taskType,
    normalizeMetadata(book.title),
    normalizeMetadata(book.author),
    normalizeMetadata(book.category),
    String(sourceRevision),
    promptVersion,
  ].join("|"));

  if (taskType === "book_overview" && !body.forceRefresh) {
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
          content: cached.content?.text ?? "",
          sources: cached.sources ?? [],
          provider: cached.provider,
          model: cached.model,
          generatedAt: cached.generated_at,
          promptVersion: cached.prompt_version,
        },
      });
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
        message: `今日${taskType === "book_overview" ? "概要生成" : "笔记辅助"}已达到 ${dailyLimit} 次`,
        limit: dailyLimit,
        remaining: 0,
        availableAt: nextUtcDayStart(),
      },
    }, 429);
  }
  if (!glmApiKey) {
    return jsonResponse({ requestId, error: { code: "GATEWAY_NOT_CONFIGURED", message: "平台 AI 服务尚未配置" } }, 503);
  }

  const messages = taskType === "book_overview"
    ? buildOverviewMessages(book)
    : buildNoteAssistanceMessages(book, body.field!, body.operation!);
  const dedupeKey = [
    userData.user.id,
    taskType,
    book.id,
    body.field || "",
    body.operation || "",
    String(book.notes_revision || 0),
    inputHash,
  ].join("|");
  try {
    const route = PROVIDER_ROUTES[0];
    const routedModel = Deno.env.get(route.modelEnv) || route.defaultModel;
    const result = await executeProviderWithReliability(dedupeKey, glmApiKey, routedModel, messages);
    const generatedAt = new Date().toISOString();
    let artifactId: string | null = null;
    if (taskType === "book_overview") {
      const { data: artifact, error: artifactError } = await adminClient
        .from("ai_artifacts")
        .upsert({
          user_id: userData.user.id,
          book_id: book.id,
          task_type: taskType,
          scope_key: scopeKey,
          input_hash: inputHash,
          source_revision: sourceRevision,
          prompt_version: promptVersion,
          content: { text: result.content },
          sources: result.sources,
          provider: PROVIDER,
          model: routedModel,
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
        book_id: book.id,
        task_type: taskType,
        provider: PROVIDER,
        model: routedModel,
        status: "succeeded",
        latency_ms: Date.now() - startedAt,
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        cache_hit: false,
        fallback_index: 0,
        prompt_version: promptVersion,
        attempts: result.attempts,
      });
    if (taskType === "note_assistance") {
      return jsonResponse({
        requestId,
        attempts: result.attempts,
        remaining: Math.max(0, dailyLimit - dailyCount - 1),
        suggestion: { content: result.content, provider: PROVIDER, model: routedModel, generatedAt, promptVersion },
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
        provider: PROVIDER,
        model: routedModel,
        generatedAt,
        promptVersion,
      },
    });
  } catch (rawError) {
    const failure = normalizeProviderFailure(rawError);
    await adminClient.from("ai_generations").insert({
      request_id: requestId,
      user_id: userData.user.id,
      book_id: book.id,
      task_type: taskType,
      provider: PROVIDER,
      model,
      status: "failed",
      error_code: failure.code,
      latency_ms: Date.now() - startedAt,
      cache_hit: false,
      fallback_index: 0,
      prompt_version: promptVersion,
      attempts: 1,
    });
    const responseStatus = failure.code === "RATE_LIMIT" ? 429 : failure.code === "TIMEOUT" ? 504 : 503;
    return jsonResponse({
      requestId,
      error: {
        code: failure.code,
        message: safeErrorMessage(failure.code),
        retryAfterSeconds: failure.retryAfterMs > 0 ? Math.ceil(failure.retryAfterMs / 1000) : null,
        availableAt: failure.code === "CIRCUIT_OPEN" && providerCircuit.openUntil > Date.now()
          ? new Date(providerCircuit.openUntil).toISOString()
          : null,
      },
    }, responseStatus);
  }
});

