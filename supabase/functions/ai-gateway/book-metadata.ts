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

export function buildGoogleBooksSearchParams(
  query: { title: string; author?: string },
  apiKey?: string,
): URLSearchParams {
  const q = query.author ? `intitle:${query.title} inauthor:${query.author}` : `intitle:${query.title}`;
  const params = new URLSearchParams({
    q,
    maxResults: "10",
    printType: "books",
    projection: "lite",
  });
  const normalizedApiKey = String(apiKey ?? "").trim();
  if (normalizedApiKey) params.set("key", normalizedApiKey);
  return params;
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

export function isLowResolutionGoogleBooksCover(value: unknown): boolean {
  const safeUrl = safeBookCoverUrl(value);
  if (!safeUrl) return false;
  const url = new URL(safeUrl);
  return isGoogleBooksHost(url.hostname) && Number(url.searchParams.get("zoom") ?? "1") <= 1;
}

export function selectGoogleBooksCover(imageLinks: unknown): string {
  if (!imageLinks || typeof imageLinks !== "object") return "";
  const links = imageLinks as Record<string, unknown>;
  for (const size of ["extraLarge", "large", "medium", "small", "thumbnail", "smallThumbnail"]) {
    const coverUrl = safeBookCoverUrl(links[size]);
    if (!coverUrl) continue;
    if (size === "thumbnail" || size === "smallThumbnail") {
      const url = new URL(coverUrl);
      if (isGoogleBooksHost(url.hostname)) url.searchParams.set("zoom", "2");
      return url.toString();
    }
    return coverUrl;
  }
  return "";
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
