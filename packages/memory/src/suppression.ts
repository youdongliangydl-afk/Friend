/**
 * M03 suppression families: a deterministic, tokenizer-injected identity for
 * content the user forgot/corrected, plus the "is this candidate merely a
 * revived rewrite?" check.
 *
 * Pure functions only: no controller import, no database, no network. The caller
 * injects the tokenizer (the Memory controller passes its CJK-bigram
 * `searchTokens`) so the family shares the same lexical space as search.
 *
 * Family identity is broader than the exact content hash on purpose:
 * - a candidate whose tokens are token-for-token identical is a punctuation /
 *   quote rewrite and must stay suppressed (cross-fork re-quote);
 * - a candidate with Jaccard ≥ 0.8 against the family and identical ASCII /
 *   numeric literals is a synonym rewrite of the same fact;
 * - a candidate that is a sub-quote covering ≥ 90% of the family is the same
 *   fact with a shortened tail;
 * - a candidate that contains the complete family token set and only adds a
 *   boundedly sized tail/surrounding sentence is a re-assertion of the same
 *   forgotten fact (Jaccard alone would miss short facts with an added clause).
 * Literals carry the "hard" identity (names, versions, paths): if they differ the
 * candidate is a different fact even when the surrounding words overlap, so
 * unrelated memories are never suppressed by generic wording (用户/项目/必须).
 */
import { createHash } from 'node:crypto';

export const FAMILY_JACCARD_THRESHOLD = 0.8;
export const FAMILY_SUBSET_THRESHOLD = 0.9;
/** Bounded superset rule: a re-assertion may add at most ratio+allowance tokens. */
export const FAMILY_EXTENSION_RATIO = 1.6;
export const FAMILY_EXTENSION_TOKEN_ALLOWANCE = 4;
export const SUPPRESSION_FAMILY_VERSION = 1;

/** ASCII words, dotted numbers and file-like names; normalized to NFKC/lowercase. */
const LITERAL_PATTERN = /[A-Za-z][A-Za-z0-9_.\/-]{1,}|[0-9]+(?:\.[0-9]+)+/g;

export interface SuppressionFamily {
  /** sha256 over the canonical family payload (stable across processes). */
  hash: string;
  /** Unique, sorted token set from the injected tokenizer. */
  tokens: string[];
  /** Unique, sorted ASCII/numeric literals (NFKC, lowercase). */
  literals: string[];
  /** NFKC, lowercase, whitespace-collapsed content. */
  normalized: string;
}

export interface RevivedRewrite {
  revived: boolean;
  familyHash?: string;
  /** Jaccard (or family coverage for the subset rule) that matched. */
  overlap?: number;
}

const normalize = (value: string): string => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.map(value => typeof value === 'string' ? value : String(value)).filter(value => value.length > 0))].sort();
}

function literalsOf(content: string): string[] {
  return uniqueSorted((content.match(LITERAL_PATTERN) || []).map(normalize));
}

/** Canonical family payload; the hash must not depend on map iteration order. */
function familyHash(normalized: string, tokens: string[], literals: string[]): string {
  return createHash('sha256')
    .update(JSON.stringify({ v: SUPPRESSION_FAMILY_VERSION, normalized, tokens, literals }))
    .digest('hex');
}

/**
 * Build the suppression family for forgotten/corrected content.
 * `tokenize` receives the normalized content and must return string tokens.
 */
export function buildSuppressionFamily(content: string, tokenize: (value: string) => string[]): SuppressionFamily {
  if (typeof content !== 'string') throw new TypeError('suppression family content 必须是字符串');
  if (typeof tokenize !== 'function') throw new TypeError('suppression family 需要注入 tokenizer');
  const normalized = normalize(content);
  const tokens = uniqueSorted(tokenize(normalized) || []);
  const literals = literalsOf(content);
  return { hash: familyHash(normalized, tokens, literals), tokens, literals, normalized };
}

function sameLiterals(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function intersectionSize(left: string[], right: string[]): number {
  const smaller = left.length <= right.length ? left : right;
  const larger = new Set(left.length <= right.length ? right : left);
  let size = 0;
  for (const token of smaller) if (larger.has(token)) size++;
  return size;
}

/**
 * Deterministic revival check against a set of suppression families.
 * Returns the matching family hash/overlap so callers can audit why a candidate
 * was refused (memory_suppression kind='family' rows stay traceable).
 */
export function isRevivedRewrite(
  candidate: { content: string },
  families: readonly SuppressionFamily[],
  tokenize: (value: string) => string[],
): RevivedRewrite {
  if (!candidate || typeof candidate.content !== 'string') return { revived: false };
  if (!Array.isArray(families) || !families.length) return { revived: false };
  if (typeof tokenize !== 'function') throw new TypeError('revival check 需要注入 tokenizer');
  const normalized = normalize(candidate.content);
  const tokens = uniqueSorted((tokenize(normalized) || []));
  // A content that tokenizes to nothing (pure punctuation/emoji) cannot revive.
  if (!tokens.length) return { revived: false };
  const literals = literalsOf(candidate.content);
  for (const family of families) {
    if (!family || typeof family.hash !== 'string' || !Array.isArray(family.tokens) || !Array.isArray(family.literals)) continue;
    if (!family.tokens.length) continue;
    // Literals are the hard identity: different names/versions/paths are a
    // different fact, even if the generic wording is identical.
    if (!sameLiterals(literals, family.literals)) continue;
    const intersection = intersectionSize(tokens, family.tokens);
    if (!intersection) continue;
    const union = tokens.length + family.tokens.length - intersection;
    const jaccard = union > 0 ? intersection / union : 0;
    // 1) identical token sets: punctuation / quote / whitespace rewrite.
    if (intersection === tokens.length && tokens.length === family.tokens.length) {
      return { revived: true, familyHash: family.hash, overlap: 1 };
    }
    // 2) synonym rewrite: ≥ 80% token overlap with identical literals.
    if (jaccard >= FAMILY_JACCARD_THRESHOLD) {
      return { revived: true, familyHash: family.hash, overlap: jaccard };
    }
    // 3) sub-quote: every candidate token is a family token and the candidate
    //    covers ≥ 90% of the family (a shortened tail truncation).
    const familyCoverage = intersection / family.tokens.length;
    if (intersection === tokens.length && familyCoverage >= FAMILY_SUBSET_THRESHOLD) {
      return { revived: true, familyHash: family.hash, overlap: familyCoverage };
    }
    // 4) bounded re-assertion: the candidate contains the complete forgotten
    //    token set and adds only a bounded tail/surrounding sentence. Without
    //    this, short facts diluted by one added clause (Jaccard < 0.8) would
    //    revive: e.g. 数据库写操作必须串行执行 → 数据库写操作必须串行执行，避免并发冲突.
    //    The ratio guard stops a long unrelated paragraph that merely embeds the
    //    forgotten sentence from being treated as the same fact.
    if (intersection === family.tokens.length && tokens.length <= family.tokens.length * FAMILY_EXTENSION_RATIO + FAMILY_EXTENSION_TOKEN_ALLOWANCE) {
      return { revived: true, familyHash: family.hash, overlap: 1 };
    }
  }
  return { revived: false };
}
