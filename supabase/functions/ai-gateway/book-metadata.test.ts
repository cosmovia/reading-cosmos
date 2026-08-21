import {
  buildBookSearchQueries,
  buildGoogleBooksSearchParams,
  isLowResolutionGoogleBooksCover,
  normalizeBookMetadata,
  safeBookCoverUrl,
  selectGoogleBooksCover,
  scoreBookMetadataCandidate,
} from "./book-metadata.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("book metadata normalization ignores title marks and punctuation", () => {
  assert(normalizeBookMetadata("《三 体》") === "三体", "title normalization failed");
});

Deno.test("cover URLs are restricted to known HTTPS image hosts", () => {
  assert(
    safeBookCoverUrl("http://books.google.com/books/content?id=1").startsWith("https://"),
    "known HTTP cover was not upgraded",
  );
  assert(
    safeBookCoverUrl("https://books.google.co.kr/books/content?id=1").startsWith("https://"),
    "regional Google Books cover was rejected",
  );
  assert(safeBookCoverUrl("https://example.com/cover.jpg") === "", "unknown cover host was accepted");
  assert(safeBookCoverUrl("javascript:alert(1)") === "", "unsafe cover protocol was accepted");
});

Deno.test("book search falls back from author-filtered to title-only lookup", () => {
  const queries = buildBookSearchQueries("我看见的世界", "李飞飞");
  assert(queries.length === 2, "title-only fallback was not created");
  assert(queries[0].author === "李飞飞", "strict query lost its author");
  assert(!queries[1].author && queries[1].title === "我看见的世界", "fallback query is incorrect");
});

Deno.test("Google Books search identifies the server project when a key is configured", () => {
  const params = buildGoogleBooksSearchParams({ title: "我看见的世界", author: "李飞飞" }, " server-key ");
  assert(params.get("q") === "intitle:我看见的世界 inauthor:李飞飞", "Google query is incorrect");
  assert(params.get("key") === "server-key", "configured API key was not included");
  const anonymousParams = buildGoogleBooksSearchParams({ title: "三体" });
  assert(!anonymousParams.has("key"), "empty API key was included");
});

Deno.test("Google Books cover selection prefers only explicitly available high resolution links", () => {
  const medium = "https://books.google.com/books/content?id=1&zoom=3";
  const selected = selectGoogleBooksCover({
    thumbnail: "https://books.google.com/books/content?id=1&zoom=1",
    medium,
  });
  assert(selected === medium, "medium cover was not preferred over thumbnail");
  const thumbnail = "https://books.google.com/books/content?id=1&zoom=1";
  assert(selectGoogleBooksCover({ thumbnail }) === "", "low resolution thumbnail was accepted as a successful match");
  assert(isLowResolutionGoogleBooksCover("https://books.google.com/books/content?id=1&zoom=1"), "low resolution cache was not detected");
  assert(!isLowResolutionGoogleBooksCover(medium), "high resolution cover was marked as low resolution");
});

Deno.test("exact title and author metadata clears the acceptance threshold", () => {
  const score = scoreBookMetadataCandidate(
    "三体",
    "刘慈欣",
    "《三体》",
    ["刘慈欣"],
    "https://covers.openlibrary.org/b/id/123-L.jpg",
  );
  assert(score === 16, "exact metadata score is incorrect");
});

Deno.test("unrelated metadata cannot be accepted only because it has a cover", () => {
  const score = scoreBookMetadataCandidate(
    "三体",
    "刘慈欣",
    "流浪地球",
    ["其他作者"],
    "https://covers.openlibrary.org/b/id/123-L.jpg",
  );
  assert(score < 10, "unrelated metadata reached the acceptance threshold");
});
