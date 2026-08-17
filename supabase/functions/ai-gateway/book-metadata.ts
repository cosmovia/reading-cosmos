const COVER_HOSTS = new Set([
  "books.google.com",
  "books.googleusercontent.com",
  "covers.openlibrary.org",
]);

export function normalizeBookMetadata(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[《》〈〉「」『』“”‘’\s\p{P}\p{S}]/gu, "");
}

export function safeBookCoverUrl(value: unknown): string {
  try {
    const url = new URL(String(value ?? "").replace(/^http:/i, "https:"));
    return url.protocol === "https:" && COVER_HOSTS.has(url.hostname) ? url.toString() : "";
  } catch {
    return "";
  }
}

export function scoreBookMetadataCandidate(
  title: string,
  author: string,
  candidateTitle: unknown,
  candidateAuthors: unknown,
  coverUrl: unknown,
): number {
  if (!safeBookCoverUrl(coverUrl)) return -1;
  const expectedTitle = normalizeBookMetadata(title);
  const expectedAuthor = normalizeBookMetadata(author);
  const actualTitle = normalizeBookMetadata(candidateTitle);
  const authors = (Array.isArray(candidateAuthors) ? candidateAuthors : [])
    .map(normalizeBookMetadata)
    .filter(Boolean);
  let score = 2;
  if (expectedTitle && actualTitle === expectedTitle) score += 8;
  else if (expectedTitle && (actualTitle.includes(expectedTitle) || expectedTitle.includes(actualTitle))) score += 4;
  if (expectedAuthor && authors.some((item) => item === expectedAuthor)) score += 6;
  else if (expectedAuthor && authors.some((item) => item.includes(expectedAuthor) || expectedAuthor.includes(item))) {
    score += 3;
  }
  return score;
}
