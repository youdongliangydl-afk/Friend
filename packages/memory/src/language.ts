/**
 * M01 language rules: one versioned rule table for explicit-remember, negation,
 * correction, stable-preference and quoted/task cues.
 *
 * These are pure lexical predicates. Callers inject the surrounding evidence
 * (current user turn vs. quoted material) exactly as `index.ts` does; the module
 * deliberately imports nothing from the controller so it can be tested and
 * reused by the learning pipeline without opening a database.
 *
 * Semantic contract (P0 §5.1):
 * - `LANGUAGE_RULES` holds regular-expression *source strings* only (no
 *   delimiters). Every rule is compiled with the `iu` flags so behaviour is
 *   identical to the regexes formerly inlined in `index.ts`.
 * - `hasCorrectionMarker` / `hasStablePreferenceCue` / `isTaskOrQuotedCue`
 *   reproduce those inlined regexes exactly (equivalence is asserted by tests
 *   and by the existing controller suite after wiring).
 * - `hasExplicitRemember` is the single source of truth for the explicit
 *   remember/personal-preference path, with slightly broader polite prefixes
 *   (劳驾/拜托/帮忙/请帮我 …) and 记下来/记下 coverage (M01).
 * - Negation is checked separately and must win: `isExplicitUserRemember` is
 *   false whenever the same text carries a negated-remember cue.
 */

export const LANGUAGE_RULE_VERSION = 1;
export const LANGUAGE_RULE_FLAGS = 'iu';
export const MAX_LANGUAGE_RULE_LENGTH = 200;
export const MAX_LANGUAGE_RULES = 32;

export interface LanguageRuleSet {
  /** Explicit remember / personal-preference phrases, including polite prefixes. */
  remember: string[];
  /** Negative remember protection: 不要记住 / 别记住 / 不用记 / 不必记 / don't remember. */
  negatedRemember: string[];
  /** User correction markers (更正/改为/不再/instead …). */
  correction: string[];
  /** Stable long-term preference cues (偏好/以后/默认/always …). */
  preference: string[];
  /** Quoted, hypothetical, task-scoped or read-instruction cues. */
  quoted: string[];
}

/**
 * Rule table. Alternatives are split so every source string stays well below
 * `MAX_LANGUAGE_RULE_LENGTH`; the predicates OR the rules of their family, so a
 * split is semantically identical to the single inlined alternation.
 */
export const LANGUAGE_RULES: LanguageRuleSet = {
  remember: [
    // Polite prefix followed directly by a remember verb (M01 positive-prefix coverage).
    '(?:请|请帮我|帮我|帮忙|麻烦|劳驾|拜托|请麻烦|能否|可以|please|kindly)[\\s,，:：]*(?:记住|记一下|记下来|记下)',
    // Bare remember verbs: unanchored, matching the original inline regex.
    '记住|记一下|记下来|记下',
    'remember\\b',
    'save (?:this|my|that|it)\\b[\\s\\S]*?(?:memory|preference)',
    'save as (?:a )?(?:long[\\s-]?term )?(?:memory|preference)',
  ],
  negatedRemember: [
    '不要记住|别记住|不用记(?:住)?|不必记(?:住)?|不要记(?:住)?',
    // Mirrors the previous `不(?:要|用).*记` protection (e.g. 不要忘记记下来).
    '不(?:要|用).{0,40}记',
    "do not remember|don't remember",
    'do not save (?:this|it|that) (?:as|to) memory',
  ],
  correction: [
    '更正|纠正|改为|改用|改成|换成|调整为|不再|取消|instead|change|no longer|correct',
  ],
  preference: [
    '偏好|更喜欢|我.*习惯|以后|今后|默认|总是|always|prefer|usually',
  ],
  quoted: [
    // `^\s*` is preserved on every rule so splitting the original anchored
    // alternation cannot change matching semantics.
    '^\\s*(?:>+|原文|摘录|转述|当前目标|本次|此次|这次|本轮|当前任务|假设|假如|如果|若\\b)',
    '^\\s*(?:示例|例如|引用|文档(?:写道|说明))',
    '^\\s*(?:请|先|请先)?(?:读取|查看|阅读|检查|搜索|打开)',
    '^\\s*(?:read|inspect|open|search)\\b',
    '^\\s*(?:for this task|if|example)\\b',
  ],
};

type RuleFamily = keyof LanguageRuleSet;
interface CompiledRuleSet {set: LanguageRuleSet;compiled:Record<RuleFamily,RegExp[]>}

const FAMILIES:RuleFamily[] = ['remember','negatedRemember','correction','preference','quoted'];

function validationError(message:string):Error {
  const error=new Error(message) as Error&{code:string};
  error.code='VALIDATION_ERROR';
  return error;
}

function compileRule(source:string):RegExp {
  try { return new RegExp(source,LANGUAGE_RULE_FLAGS); }
  catch (error) { throw validationError(`语言规则无法编译：${source}（${error instanceof Error?error.message:String(error)}）`); }
}

function compileSet(rules:LanguageRuleSet):CompiledRuleSet {
  const compiled=Object.fromEntries(FAMILIES.map(family=>[family,rules[family].map(compileRule)])) as Record<RuleFamily,RegExp[]>;
  return {set:rules,compiled};
}

function validateRuleSet(rules:LanguageRuleSet):LanguageRuleSet {
  for (const family of FAMILIES) {
    const list=rules[family];
    if (!Array.isArray(list)||!list.every(rule=>typeof rule==='string')) throw validationError(`语言规则 ${family} 必须是非空正则源码数组`);
    if (list.length>MAX_LANGUAGE_RULES) throw validationError(`语言规则 ${family} 数量超过 ${MAX_LANGUAGE_RULES}`);
    for (const rule of list) {
      if (!rule.length) throw validationError(`语言规则 ${family} 不能包含空规则`);
      if (rule.length>MAX_LANGUAGE_RULE_LENGTH) throw validationError(`语言规则长度超过 ${MAX_LANGUAGE_RULE_LENGTH}：${rule.slice(0,40)}…`);
      compileRule(rule);
    }
  }
  return rules;
}

let cached:CompiledRuleSet|undefined;
function active():CompiledRuleSet {
  if (!cached) cached=compileSet(validateRuleSet(LANGUAGE_RULES));
  return cached;
}

/**
 * Validate rule overrides and return a complete rule set. Intended for future
 * configurable language rules; the P0 predicates consume `LANGUAGE_RULES`.
 * Invalid rules throw a plain `Error` with `code === 'VALIDATION_ERROR'`
 * (the module intentionally does not import core's CapabilityError).
 */
export function compileLanguageRules(overrides:Partial<LanguageRuleSet>={}):LanguageRuleSet {
  if (overrides===null||typeof overrides!=='object'||Array.isArray(overrides)) throw validationError('语言规则覆盖必须是对象');
  for (const key of Object.keys(overrides)) if (!FAMILIES.includes(key as RuleFamily)) throw validationError(`未知语言规则族：${key}`);
  for (const family of FAMILIES) {
    const override=overrides[family];
    if (override===undefined) continue;
    if (!Array.isArray(override)||!override.length) throw validationError(`语言规则 ${family} 覆盖必须是非空数组`);
  }
  const merged:LanguageRuleSet={...LANGUAGE_RULES,...overrides};
  for (const family of FAMILIES) merged[family]=[...merged[family]];
  return validateRuleSet(merged);
}

const matches=(rules:RegExp[],text:string):boolean=>rules.some(rule=>rule.test(text));

/** True when the text carries an explicit remember/personal-preference request. */
export function hasExplicitRemember(text:string):boolean {
  return typeof text==='string' && matches(active().compiled.remember,text);
}

/** True when the text protects against remembering (negation wins over `hasExplicitRemember`). */
export function hasNegatedRemember(text:string):boolean {
  return typeof text==='string' && matches(active().compiled.negatedRemember,text);
}

/** Positive remember request that is not negated in the same text. */
export function isExplicitUserRemember(text:string):boolean {
  return hasExplicitRemember(text) && !hasNegatedRemember(text);
}

/** True when a user statement contains an explicit correction marker. */
export function hasCorrectionMarker(text:string):boolean {
  return typeof text==='string' && matches(active().compiled.correction,text);
}

/** True when a quote carries a stable long-term preference cue. */
export function hasStablePreferenceCue(text:string):boolean {
  return typeof text==='string' && matches(active().compiled.preference,text);
}

/** True when the span is quoted, hypothetical, task-scoped or a read instruction. */
export function isTaskOrQuotedCue(text:string):boolean {
  return typeof text==='string' && matches(active().compiled.quoted,text);
}
