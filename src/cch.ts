import { createHash } from "node:crypto";

/** Claude Code 2.1.220 CCH seed. The hash is xxHash64 of the normalized body. */
const CCH_SEED = 0x4D659218E32A3268n;
const CCH_ZERO = "00000";
const FINGERPRINT_SALT = "59cf53e54c78";
const MASK64 = (1n << 64n) - 1n;
const PRIME1 = 0x9E3779B185EBCA87n;
const PRIME2 = 0xC2B2AE3D27D4EB4Fn;
const PRIME3 = 0x165667B19E3779F9n;
const PRIME4 = 0x85EBCA77C2B2AE63n;
const PRIME5 = 0x27D4EB2F165667C5n;

const EXCLUDED_KEYS = new Set(["max_tokens", "fallbacks", "fallback_credit_token"]);

type Edit = { start: number; end: number };
type Member = { start: number; end: number; commaBefore: number; commaAfter: number; excluded: boolean };

export function billingHeader(version: string, messageText: string): string {
  const fingerprint = claudeFingerprint(messageText, version);
  return `x-anthropic-billing-header: cc_version=${version}.${fingerprint}; cc_entrypoint=cli; cch=${CCH_ZERO};`;
}

export function claudeFingerprint(messageText: string, version: string): string {
  const sampled = [4, 7, 20].map((index) => (index < messageText.length ? messageText[index]! : "0")).join("");
  return createHash("sha256").update(FINGERPRINT_SALT + sampled + version).digest("hex").slice(0, 3);
}

export function signClaudeBody(body: Uint8Array): Uint8Array {
  const marker = Buffer.from("cc_entrypoint=cli; cch=");
  const bytes = Buffer.from(body);
  const at = bytes.indexOf(marker);
  if (at < 0) return bytes;
  const digits = at + marker.length;
  if (digits + 5 >= bytes.length || bytes[digits + 5] !== 0x3b) return bytes;
  bytes.set(Buffer.from(CCH_ZERO), digits);
  const hash = xxh64(normalizeClaudeBody(bytes), CCH_SEED) & 0xFFFFFn;
  bytes.set(Buffer.from(hash.toString(16).padStart(5, "0")), digits);
  return bytes;
}

export function xxh64(data: Uint8Array, seed: bigint): bigint {
  const length = data.length;
  let hash: bigint;
  let offset = 0;
  if (length >= 32) {
    let v1 = (seed + PRIME1 + PRIME2) & MASK64;
    let v2 = (seed + PRIME2) & MASK64;
    let v3 = seed & MASK64;
    let v4 = (seed - PRIME1) & MASK64;
    while (offset + 32 <= length) {
      v1 = round(v1, readU64(data, offset));
      v2 = round(v2, readU64(data, offset + 8));
      v3 = round(v3, readU64(data, offset + 16));
      v4 = round(v4, readU64(data, offset + 24));
      offset += 32;
    }
    hash = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & MASK64;
    hash = merge(hash, v1);
    hash = merge(hash, v2);
    hash = merge(hash, v3);
    hash = merge(hash, v4);
  } else {
    hash = (seed + PRIME5) & MASK64;
  }
  hash = (hash + BigInt(length)) & MASK64;
  while (offset + 8 <= length) {
    hash = hash ^ round(0n, readU64(data, offset));
    hash = (rotl(hash, 27n) * PRIME1 + PRIME4) & MASK64;
    offset += 8;
  }
  if (offset + 4 <= length) {
    hash = hash ^ ((readU32(data, offset) * PRIME1) & MASK64);
    hash = (rotl(hash, 23n) * PRIME2 + PRIME3) & MASK64;
    offset += 4;
  }
  while (offset < length) {
    hash = hash ^ ((BigInt(data[offset]!) * PRIME5) & MASK64);
    hash = (rotl(hash, 11n) * PRIME1) & MASK64;
    offset += 1;
  }
  hash ^= hash >> 33n;
  hash = (hash * PRIME2) & MASK64;
  hash ^= hash >> 29n;
  hash = (hash * PRIME3) & MASK64;
  hash ^= hash >> 32n;
  return hash;
}

function normalizeClaudeBody(body: Uint8Array): Uint8Array {
  const edits: Edit[] = [];
  const pos = { at: 0 };
  parseValue(body, pos, true, edits);
  skipSpace(body, pos);
  if (pos.at !== body.length) {
    throw new Error(`unexpected JSON data at byte ${pos.at}`);
  }
  edits.sort((left, right) => left.start - right.start);
  const out: number[] = [];
  let last = 0;
  for (const edit of edits) {
    if (edit.start < last || edit.end > body.length) {
      throw new Error(`overlapping CCH normalization edit at byte ${edit.start}`);
    }
    for (let i = last; i < edit.start; i += 1) out.push(body[i]!);
    last = edit.end;
  }
  for (let i = last; i < body.length; i += 1) out.push(body[i]!);
  return Uint8Array.from(out);
}

function parseValue(body: Uint8Array, pos: { at: number }, collect: boolean, edits: Edit[]): void {
  skipSpace(body, pos);
  const byte = body[pos.at];
  if (byte === 0x7b) {
    parseObject(body, pos, collect, edits);
    return;
  }
  if (byte === 0x5b) {
    parseArray(body, pos, collect, edits);
    return;
  }
  if (byte === 0x22) {
    parseString(body, pos);
    return;
  }
  const start = pos.at;
  while (pos.at < body.length && !",}] \t\r\n".includes(String.fromCharCode(body[pos.at]!))) pos.at += 1;
  if (pos.at === start) throw new Error(`missing JSON value at byte ${start}`);
}

function parseObject(body: Uint8Array, pos: { at: number }, collect: boolean, edits: Edit[]): void {
  pos.at += 1;
  skipSpace(body, pos);
  if (consume(body, pos, 0x7d)) return;
  const members: Member[] = [];
  let commaBefore = -1;
  for (;;) {
    skipSpace(body, pos);
    const memberStart = pos.at;
    const key = parseString(body, pos);
    skipSpace(body, pos);
    if (!consume(body, pos, 0x3a)) throw new Error(`missing object colon at byte ${pos.at}`);
    skipSpace(body, pos);
    const excluded = collect && EXCLUDED_KEYS.has(key);
    if (collect && key === "model" && body[pos.at] === 0x22) {
      const [valueStart, valueEnd] = parseStringBounds(body, pos);
      edits.push({ start: valueStart + 1, end: valueEnd - 1 });
    } else {
      parseValue(body, pos, collect && !excluded, edits);
    }
    const memberEnd = pos.at;
    skipSpace(body, pos);
    let commaAfter = -1;
    if (consume(body, pos, 0x2c)) commaAfter = pos.at - 1;
    members.push({ start: memberStart, end: memberEnd, commaBefore, commaAfter, excluded });
    if (commaAfter >= 0) {
      commaBefore = commaAfter;
      continue;
    }
    if (!consume(body, pos, 0x7d)) throw new Error(`missing object end at byte ${pos.at}`);
    break;
  }
  if (collect) addExcludedEdits(members, edits);
}

function parseArray(body: Uint8Array, pos: { at: number }, collect: boolean, edits: Edit[]): void {
  pos.at += 1;
  skipSpace(body, pos);
  if (consume(body, pos, 0x5d)) return;
  for (;;) {
    parseValue(body, pos, collect, edits);
    skipSpace(body, pos);
    if (consume(body, pos, 0x2c)) continue;
    if (!consume(body, pos, 0x5d)) throw new Error(`missing array end at byte ${pos.at}`);
    return;
  }
}

function parseString(body: Uint8Array, pos: { at: number }): string {
  const [start, end] = parseStringBounds(body, pos);
  return Buffer.from(body.subarray(start + 1, end - 1)).toString("utf8");
}

function parseStringBounds(body: Uint8Array, pos: { at: number }): [number, number] {
  if (body[pos.at] !== 0x22) throw new Error(`missing JSON string at byte ${pos.at}`);
  const start = pos.at;
  pos.at += 1;
  while (pos.at < body.length) {
    if (body[pos.at] === 0x5c) {
      pos.at += 2;
      continue;
    }
    if (body[pos.at] === 0x22) {
      pos.at += 1;
      return [start, pos.at];
    }
    pos.at += 1;
  }
  throw new Error(`unterminated JSON string at byte ${start}`);
}

function addExcludedEdits(members: Member[], edits: Edit[]): void {
  for (let start = 0; start < members.length;) {
    if (!members[start]?.excluded) {
      start += 1;
      continue;
    }
    let end = start;
    while (end + 1 < members.length && members[end + 1]?.excluded) end += 1;
    const first = members[start]!;
    const last = members[end]!;
    if (end + 1 < members.length) edits.push({ start: first.start, end: last.commaAfter + 1 });
    else if (start > 0 && end > start) edits.push({ start: first.start, end: last.end });
    else if (start > 0) edits.push({ start: first.commaBefore, end: last.end });
    else edits.push({ start: first.start, end: last.end });
    start = end + 1;
  }
}

function skipSpace(body: Uint8Array, pos: { at: number }): void {
  while (pos.at < body.length && (body[pos.at] === 0x20 || body[pos.at] === 0x09 || body[pos.at] === 0x0d || body[pos.at] === 0x0a)) {
    pos.at += 1;
  }
}

function consume(body: Uint8Array, pos: { at: number }, character: number): boolean {
  if (body[pos.at] !== character) return false;
  pos.at += 1;
  return true;
}

function round(acc: bigint, input: bigint): bigint {
  acc = (acc + input * PRIME2) & MASK64;
  acc = rotl(acc, 31n);
  return (acc * PRIME1) & MASK64;
}

function merge(acc: bigint, value: bigint): bigint {
  return ((acc ^ round(0n, value)) * PRIME1 + PRIME4) & MASK64;
}

function rotl(value: bigint, bits: bigint): bigint {
  return ((value << bits) | (value >> (64n - bits))) & MASK64;
}

function readU64(data: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 0; i < 8; i += 1) value |= BigInt(data[offset + i]!) << BigInt(i * 8);
  return value;
}

function readU32(data: Uint8Array, offset: number): bigint {
  return BigInt(
    data[offset]! |
      (data[offset + 1]! << 8) |
      (data[offset + 2]! << 16) |
      (data[offset + 3]! << 24),
  ) & 0xFFFFFFFFn;
}
