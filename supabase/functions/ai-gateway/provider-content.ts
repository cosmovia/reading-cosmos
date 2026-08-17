const INTERNAL_PROTOCOL_MARKUP = /(?:<\/?(?:dots_function_call|invoke|parameter|tool_call|function_call)\b|<<\s*think\s*>|<\|(?:assistant|tool|function)[^>]*\|>)/i;

export function isUsableProviderContent(value: unknown, longForm = false): value is string {
  if (typeof value !== "string") return false;
  const content = value.trim();
  if (!content || INTERNAL_PROTOCOL_MARKUP.test(content)) return false;
  if (!longForm) return true;

  const chineseCharacterCount = content.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  return content.length >= 220 && chineseCharacterCount >= 100;
}
