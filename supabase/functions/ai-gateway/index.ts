import "jsr:@supabase/functions-js@2.5.0/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";

const TASK_TYPE = "book_overview";
const PROMPT_VERSION = "book-overview-v1";
const PROVIDER = "zhipu";
const DEFAULT_MODEL = "glm-4.7-flash";
const GLM_ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const DAILY_GENERATION_LIMIT = 10;
const REQUEST_TIMEOUT_MS = 55_000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type GatewayBody = {
  taskType?: string;
  bookId?: string;
  forceRefresh?: boolean;
};

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
  if (body.taskType !== TASK_TYPE || !body.bookId) {
    return jsonResponse({ requestId, error: { code: "INVALID_REQUEST", message: "当前只支持书籍内容概要" } }, 400);
  }

  const { data: book, error: bookError } = await userClient
    .from("books")
    .select("id, user_id, title, author, category, notes_revision")
    .eq("id", body.bookId)
    .maybeSingle();
  if (bookError) return jsonResponse({ requestId, error: { code: "DATABASE", message: "暂时无法读取书籍" } }, 500);
  if (!book) return jsonResponse({ requestId, error: { code: "NOT_FOUND", message: "未找到这本书" } }, 404);

  const scopeKey = `book:${book.id}`;
  const sourceRevision = 0;
  const inputHash = await sha256([
    TASK_TYPE,
    normalizeMetadata(book.title),
    normalizeMetadata(book.author),
    normalizeMetadata(book.category),
    String(sourceRevision),
    PROMPT_VERSION,
  ].join("|"));

  if (!body.forceRefresh) {
    const { data: cached } = await userClient
      .from("ai_artifacts")
      .select("id, content, sources, provider, model, generated_at, prompt_version")
      .eq("task_type", TASK_TYPE)
      .eq("scope_key", scopeKey)
      .eq("input_hash", inputHash)
      .eq("prompt_version", PROMPT_VERSION)
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
  const { count: dailyCount, error: quotaError } = await adminClient
    .from("ai_generations")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userData.user.id)
    .eq("task_type", TASK_TYPE)
    .eq("cache_hit", false)
    .gte("created_at", dayStart.toISOString());
  if (quotaError) return jsonResponse({ requestId, error: { code: "DATABASE", message: "暂时无法检查 AI 额度" } }, 500);
  if ((dailyCount ?? 0) >= DAILY_GENERATION_LIMIT) {
    return jsonResponse({
      requestId,
      error: { code: "DAILY_LIMIT", message: `今日平台概要生成已达到 ${DAILY_GENERATION_LIMIT} 次，请明天再试` },
    }, 429);
  }
  if (!glmApiKey) {
    return jsonResponse({ requestId, error: { code: "GATEWAY_NOT_CONFIGURED", message: "平台 AI 服务尚未配置" } }, 503);
  }

  let attempts = 0;
  let finalFailure: ProviderFailure | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    attempts = attempt + 1;
    try {
      const result = await callGlm(glmApiKey, model, buildOverviewMessages(book));
      const generatedAt = new Date().toISOString();
      const { data: artifact, error: artifactError } = await adminClient
        .from("ai_artifacts")
        .upsert({
          user_id: userData.user.id,
          book_id: book.id,
          task_type: TASK_TYPE,
          scope_key: scopeKey,
          input_hash: inputHash,
          source_revision: sourceRevision,
          prompt_version: PROMPT_VERSION,
          content: { text: result.content },
          sources: result.sources,
          provider: PROVIDER,
          model,
          generated_at: generatedAt,
          expires_at: null,
        }, { onConflict: "user_id,task_type,scope_key,input_hash,prompt_version" })
        .select("id")
        .single();
      if (artifactError) throw providerFailure("UNAVAILABLE");

      await adminClient.from("ai_generations").insert({
        request_id: requestId,
        user_id: userData.user.id,
        book_id: book.id,
        task_type: TASK_TYPE,
        provider: PROVIDER,
        model,
        status: "succeeded",
        latency_ms: Date.now() - startedAt,
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        cache_hit: false,
        fallback_index: 0,
        prompt_version: PROMPT_VERSION,
        attempts,
      });
      return jsonResponse({
        requestId,
        cacheHit: false,
        attempts,
        artifact: {
          id: artifact.id,
          content: result.content,
          sources: result.sources,
          provider: PROVIDER,
          model,
          generatedAt,
          promptVersion: PROMPT_VERSION,
        },
      });
    } catch (rawError) {
      finalFailure = normalizeProviderFailure(rawError);
      if (!finalFailure.retryable || attempt === 1) break;
      const jitterMs = 650 + Math.floor(Math.random() * 550);
      const delayMs = Math.min(5_000, Math.max(jitterMs, finalFailure.retryAfterMs));
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  const failure = finalFailure ?? providerFailure("UNAVAILABLE");
  await adminClient.from("ai_generations").insert({
    request_id: requestId,
    user_id: userData.user.id,
    book_id: book.id,
    task_type: TASK_TYPE,
    provider: PROVIDER,
    model,
    status: "failed",
    error_code: failure.code,
    latency_ms: Date.now() - startedAt,
    cache_hit: false,
    fallback_index: 0,
    prompt_version: PROMPT_VERSION,
    attempts,
  });
  const responseStatus = failure.code === "RATE_LIMIT" ? 429 : failure.code === "TIMEOUT" ? 504 : 503;
  return jsonResponse({
    requestId,
    error: { code: failure.code, message: safeErrorMessage(failure.code) },
  }, responseStatus);
});

