import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { billingHeader, claudeFingerprint, signClaudeBody, xxh64 } from "./cch.js";

describe("claude cch", () => {
  it("matches the xxHash64 empty-input vector", () => {
    assert.equal(xxh64(new Uint8Array(), 0n), 0xEF46DB3751D8E999n);
  });

  it("pins a 3 character build fingerprint", () => {
    assert.equal(claudeFingerprint("hello world this is a sample", "2.1.321"), claudeFingerprint("hello world this is a sample", "2.1.321"));
    assert.match(claudeFingerprint("", "2.1.321"), /^[0-9a-f]{3}$/);
  });

  it("signs the billing header and ignores max_tokens", () => {
    const header = billingHeader("2.1.321", "hello");
    assert.match(header, /^x-anthropic-billing-header: cc_version=2\.1\.321\.[0-9a-f]{3}; cc_entrypoint=cli; cch=00000;$/);
    const first = signed({ max_tokens: 16, text: "hello" });
    const second = signed({ max_tokens: 32, text: "hello" });
    const changed = signed({ max_tokens: 16, text: "hello!" });
    assert.match(textAt(first, "cch="), /^cch=[0-9a-f]{5};$/);
    assert.notEqual(textAt(first, "cch="), "cch=00000;");
    assert.equal(textAt(first, "cch="), textAt(second, "cch="));
    assert.notEqual(textAt(first, "cch="), textAt(changed, "cch="));
    assert.equal(JSON.parse(Buffer.from(first).toString("utf8")).max_tokens, 16);
  });
});

function signed(input: { max_tokens: number; text: string }): Uint8Array {
  const header = billingHeader("2.1.321", input.text);
  return signClaudeBody(Buffer.from(JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: input.max_tokens,
    system: [{ type: "text", text: header }],
    messages: [{ role: "user", content: input.text }],
  })));
}

function textAt(body: Uint8Array, marker: string): string {
  const text = Buffer.from(body).toString("utf8");
  const at = text.indexOf(marker);
  assert.ok(at >= 0);
  return text.slice(at, at + marker.length + 6);
}
