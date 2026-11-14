import test from "node:test";
import assert from "node:assert/strict";
import { isValidYouTubeVideoId, MAX_YOUTUBE_DOWNLOAD_BYTES } from "./youtube-download.mjs";

test("accepts an 11-character YouTube video ID", () => {
  assert.equal(isValidYouTubeVideoId("dQw4w9WgXcQ"), true);
});
test("rejects short, long, URL, and malformed identifiers", () => {
  for (const value of ["abc", "dQw4w9WgXcQx", "https://youtube.com/watch?v=dQw4w9WgXcQ", "abc!defghij", "", null]) {
    assert.equal(isValidYouTubeVideoId(value), false);
  }
});
test("enforces a 250 MB maximum file size", () => {
  assert.equal(MAX_YOUTUBE_DOWNLOAD_BYTES, 250 * 1024 * 1024);
});
