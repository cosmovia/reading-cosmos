import { isUsableProviderContent } from "./provider-content.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("provider content rejects leaked search tool markup", () => {
  const leaked = `<dots_function_call>\n<invoke name="search">\n<<think>\n<parameter name="query">书籍概要</parameter>\n</invoke>\n</dots_function_call>`;
  assert(!isUsableProviderContent(leaked, true), "tool markup was accepted as overview text");
});

Deno.test("provider content accepts a substantive Chinese overview", () => {
  const overview = "这是一段经过整理的中文书籍概要，介绍作品背景、核心主题、人物关系与思想价值。".repeat(8);
  assert(isUsableProviderContent(overview, true), "substantive overview was rejected");
});

Deno.test("short probe response remains valid", () => {
  assert(isUsableProviderContent("READY"), "short probe response was rejected");
});
