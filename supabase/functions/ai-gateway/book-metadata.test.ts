import {
  normalizeBookMetadata,
  safeBookCoverUrl,
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
