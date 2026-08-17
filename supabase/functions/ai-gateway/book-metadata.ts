const COVER_HOSTS = new Set([
  "books.google.com",
  "books.googleusercontent.com",
  "covers.openlibrary.org",
]);

function isGoogleBooksHost(hostname: string): boolean {
  return hostname === "books.google.com" ||
    /^books\.google\.(?:[a-z]{2,3}|co\.[a-z]{2}|com\.[a-z]{2})$/i.test(hostname);
}

export function normalizeBookMetadata(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[《》〈〉「」『』“”‘’\s\p{P}\p{S}]/gu, "");
}

export function buildBookSearchQueries(title: string, author: string): Array<{ title: string; author?: string }> {
  const normalizedTitle = String(title ?? "").trim();
  const normalizedAuthor = String(author ?? "").trim();
  if (!normalizedTitle) return [];
  return normalizedAuthor
    ? [{ title: normalizedTitle, author: normalizedAuthor }, { title: normalizedTitle }]
    : [{ title: normalizedTitle }];
}

export function safeBookCoverUrl(value: unknown): string {
  try {
    const url = new URL(String(value ?? "").replace(/^http:/i, "https:"));
    return url.protocol === "https:" &&
        (COVER_HOSTS.has(url.hostname) || isGoogleBooksHost(url.hostname))
      ? url.toString()
      : "";
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
