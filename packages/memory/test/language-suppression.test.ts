import test from 'node:test';
import assert from 'node:assert/strict';
import { searchTokens } from '../src/index.js';
import {
  LANGUAGE_RULE_VERSION, LANGUAGE_RULES, compileLanguageRules,
  hasCorrectionMarker, hasExplicitRemember, hasNegatedRemember, hasStablePreferenceCue,
  isExplicitUserRemember, isTaskOrQuotedCue,
} from '../src/language.js';
import {
  FAMILY_EXTENSION_RATIO, FAMILY_EXTENSION_TOKEN_ALLOWANCE, FAMILY_JACCARD_THRESHOLD,
  FAMILY_SUBSET_THRESHOLD, buildSuppressionFamily, isRevivedRewrite,
} from '../src/suppression.js';

const CODE_ERROR=(code:string)=>(error:unknown)=>(error as {code?:string})?.code===code;

test('M01 language rule table is versioned and every rule compiles',()=>{
  assert.equal(LANGUAGE_RULE_VERSION,1);
  assert.deepEqual(Object.keys(LANGUAGE_RULES).sort(),['correction','negatedRemember','preference','quoted','remember']);
  for(const rules of Object.values(LANGUAGE_RULES))assert.ok(Array.isArray(rules)&&rules.length>0);
  assert.doesNotThrow(()=>compileLanguageRules());
  assert.deepEqual(compileLanguageRules(),LANGUAGE_RULES);
});

test('M01 explicit remember covers polite Chinese prefixes, remember and save-as phrases',()=>{
  const positive=[
    '请帮我记住这个项目使用 SQLite。',
    '麻烦记住：我偏好中文解释。',
    '帮我记一下，下次默认用 UTF-8。',
    '请记住，回答要简洁。',
    '帮我记下来，周一发布。',
    '劳驾记住部署命令。',
    '拜托帮我记一下测试账号。',
    '帮忙记下来这个约定。',
    'remember this: use pnpm.',
    'please remember that tests stay offline.',
    'save this as long-term memory.',
    'Save as preference: concise answers.',
  ];
  for(const text of positive){
    assert.equal(hasExplicitRemember(text),true,text);
    assert.equal(hasNegatedRemember(text),false,text);
    assert.equal(isExplicitUserRemember(text),true,text);
  }
  for(const text of ['继续检查事务。','UI 颜色保持蓝色。','读取配置文件。'])assert.equal(isExplicitUserRemember(text),false,text);
});

test('M01 negative remember protects 不要记住/别记住/不用记/不必记/don\'t remember',()=>{
  const negative=['请不要记住我的个人偏好。','别记住这段内容。','不用记住这个。','不必记这个。',"don't remember this。",'do not remember this.'];
  for(const text of negative)assert.equal(hasNegatedRemember(text),true,text);
  // 记住 exists inside the negated sentence; negation must still win.
  for(const text of ['请不要记住我的个人偏好。','别记住这段内容。','do not remember this.'])assert.equal(isExplicitUserRemember(text),false,text);
  assert.equal(isExplicitUserRemember("don't remember this。"),false);
  // Protective negation is not itself a bare remember request, but the positive
  // verb inside the sentence must not win either.
  assert.equal(isExplicitUserRemember('不用记住这个。'),false);
  assert.equal(isExplicitUserRemember('不必记这个。'),false);
  assert.equal(hasExplicitRemember('不必记这个。'),false);
});

test('M01 correction markers match the moved index.ts semantics',()=>{
  for(const text of ['更正：数据库改为 PostgreSQL。','改用 PostgreSQL 存储。','以后改成蓝色。','换成绿色侧栏。','调整为 UTF-8。','不再使用 SQLite。','取消此设置。','use Postgres instead.','change the engine.','no longer valid.','correct the value.'])
    assert.equal(hasCorrectionMarker(text),true,text);
  for(const text of ['继续检查事务。','UI 颜色保持蓝色。','数据库必须使用 SQLite。'])assert.equal(hasCorrectionMarker(text),false,text);
});

test('M01 stable preference cue matches the moved index.ts semantics',()=>{
  for(const text of ['我偏好中文解释。','我更喜欢简洁回答。','我习惯用 pnpm。','以后默认用中文。','今后使用 Vim。','总是先跑测试。','always run tests.','prefer concise answers.','usually offline.'])
    assert.equal(hasStablePreferenceCue(text),true,text);
  for(const text of ['当前任务读取文件。','本次使用 SQLite。','数据库必须使用 SQLite。'])assert.equal(hasStablePreferenceCue(text),false,text);
});

test('M01 quoted/task cues are not long-term preference evidence',()=>{
  const quoted=['> 原文：以后默认用中文。','摘录：偏好中文解释。','本次仅测量延迟。','此次使用 SQLite。','当前任务：修复事务。','假设我们使用 PostgreSQL。','示例：数据库配置。','请读取 README。','先检查构建输出。','read the file first.','inspect the build output.','for this task, use caching.','if the test fails, retry.','引用文档写道：必须使用 UTF-8。'];
  for(const text of quoted)assert.equal(isTaskOrQuotedCue(text),true,text);
  for(const text of ['我以后默认用中文。','数据库必须使用 SQLite。','麻烦记住这个偏好。','请帮我记住部署命令。'])assert.equal(isTaskOrQuotedCue(text),false,text);
  // A quoted span can still carry a preference word; the quoted cue is what
  // stops index.ts from treating it as a stable preference.
  assert.equal(isTaskOrQuotedCue('本次我更喜欢蓝色侧栏。'),true);
  assert.equal(hasStablePreferenceCue('本次我更喜欢蓝色侧栏。'),true);
});

test('M01 compileLanguageRules validates length, count and compilability',()=>{
  assert.deepEqual(compileLanguageRules({correction:['自定义更正']}).correction,['自定义更正']);
  assert.deepEqual(compileLanguageRules({correction:['自定义更正']}).preference,LANGUAGE_RULES.preference);
  assert.throws(()=>compileLanguageRules({correction:['(']}),CODE_ERROR('VALIDATION_ERROR'));
  assert.throws(()=>compileLanguageRules({correction:['x'.repeat(201)]}),CODE_ERROR('VALIDATION_ERROR'));
  assert.throws(()=>compileLanguageRules({correction:Array.from({length:33},(_,index)=>`rule-${index}`)}),CODE_ERROR('VALIDATION_ERROR'));
  assert.throws(()=>compileLanguageRules({correction:'not-an-array' as unknown as string[]}),CODE_ERROR('VALIDATION_ERROR'));
  assert.throws(()=>compileLanguageRules({unknownFamily:['x']} as unknown as Partial<typeof LANGUAGE_RULES>),CODE_ERROR('VALIDATION_ERROR'));
});

test('M03 family identity is deterministic, tokenized and literal-aware',()=>{
  const content='数据库必须使用 SQLite 3.44，禁止降级到 2.0。';
  const family=buildSuppressionFamily(content,searchTokens);
  assert.equal(family.normalized,'数据库必须使用 sqlite 3.44,禁止降级到 2.0。');
  assert.deepEqual(family.tokens,[...family.tokens].sort());
  assert.equal(new Set(family.tokens).size,family.tokens.length);
  assert.equal(family.hash.length,64);
  assert.deepEqual(family.literals,['2.0','3.44','sqlite']);
  assert.equal(buildSuppressionFamily(content,searchTokens).hash,family.hash);
  assert.notEqual(buildSuppressionFamily('数据库必须使用 SQLite 3.45，禁止降级到 2.0。',searchTokens).hash,family.hash);
  // Tokenizer order must not change identity (canonical sorting).
  const reversed=buildSuppressionFamily(content,(value)=>[...searchTokens(value)].reverse());
  assert.deepEqual(reversed.tokens,family.tokens);
  assert.equal(reversed.hash,family.hash);
  // Injected tokenizer receives normalized content and its empty results are dropped.
  const seen:string[]=[];
  const custom=buildSuppressionFamily('ＡＢＣ',(value)=>{seen.push(value);return ['x','x','','y'];});
  assert.deepEqual(seen,['abc']);
  assert.deepEqual(custom.tokens,['x','y']);
});

test('M03 exact-token and punctuation/quote rewrites are revived (cross-fork re-quote)',()=>{
  const family=buildSuppressionFamily('数据库必须使用 SQLite。',searchTokens);
  for(const content of ['数据库必须使用 SQLite。','「数据库必须使用 SQLite」','数据库必须使用sqlite。']){
    const result=isRevivedRewrite({content},[family],searchTokens);
    assert.equal(result.revived,true,content);
    assert.equal(result.familyHash,family.hash);
    assert.equal(result.overlap,1);
  }
});

test('M03 synonym rewrites above the Jaccard threshold are revived',()=>{
  const family=buildSuppressionFamily('数据库连接池必须限制最大并发数，避免耗尽服务端资源。',searchTokens);
  const result=isRevivedRewrite({content:'数据库连接池必须控制最大并发数，避免耗尽服务端资源。'},[family],searchTokens);
  assert.equal(result.revived,true);
  assert.equal(result.overlap!>=FAMILY_JACCARD_THRESHOLD,true);
  assert.equal(FAMILY_JACCARD_THRESHOLD,0.8);
});

test('M03 generic wording overlap alone never revives',()=>{
  const family=buildSuppressionFamily('部署流水线必须在合并到主分支之前运行完整回归测试，并保留全部失败日志。',searchTokens);
  for(const content of ['用户要求项目必须完成。','项目必须使用标准流程。','用户偏好简洁回答。'])
    assert.equal(isRevivedRewrite({content},[family],searchTokens).revived,false,content);
});

test('M03 different literals are a different fact even with identical wording',()=>{
  const family=buildSuppressionFamily('数据库必须使用 SQLite 3.44 并保留迁移脚本。',searchTokens);
  const differentLiteral=isRevivedRewrite({content:'数据库必须使用 SQLite 3.45 并保留迁移脚本。'},[family],searchTokens);
  assert.equal(differentLiteral.revived,false);
  assert.equal(isRevivedRewrite({content:'数据库必须使用 PostgreSQL 3.44 并保留迁移脚本。'},[family],searchTokens).revived,false);
});

test('M03 a sub-quote covering the family is revived, a small excerpt is not',()=>{
  const full='数据库必须使用 SQLite，必须保留 UTF-8 中文字段，禁止省略任何字段。';
  const family=buildSuppressionFamily(full,searchTokens);
  const truncated='数据库必须使用 SQLite，必须保留 UTF-8 中文字段，禁止省略任何';
  const revived=isRevivedRewrite({content:truncated},[family],searchTokens);
  assert.equal(revived.revived,true);
  assert.equal(revived.overlap!>=FAMILY_SUBSET_THRESHOLD,true);
  assert.equal(FAMILY_SUBSET_THRESHOLD,0.9);
  // A short shared excerpt is far below the family coverage threshold.
  assert.equal(isRevivedRewrite({content:'数据库必须使用'},[family],searchTokens).revived,false);
  // Identical literals but unrelated body is a different fact.
  assert.equal(isRevivedRewrite({content:'UTF-8 SQLite 完全另一个主题的说明。'},[family],searchTokens).revived,false);
});

test('M03 cross-fork paraphrase stays suppressed while a fork of another fact is untouched',()=>{
  const forgotten='发布前必须运行完整回归测试，并保留失败日志，禁止跳过任何步骤。';
  const family=buildSuppressionFamily(forgotten,searchTokens);
  // Fork B re-quotes the forgotten fact with a synonym and a re-quote: revived.
  const paraphrase='发布前必须运行完整回归测试，并保留失败日志，禁止越过任何步骤。';
  assert.notEqual(paraphrase,forgotten);
  assert.equal(isRevivedRewrite({content:paraphrase},[family],searchTokens).revived,true);
  // Fork B's own new fact keeps its own literals and is not suppressed.
  assert.equal(isRevivedRewrite({content:'发布前必须在 CI 中运行完整回归测试。CI-77'},[family],searchTokens).revived,false);
  // Pure punctuation candidate cannot revive anything.
  assert.equal(isRevivedRewrite({content:'！！！'},[family],searchTokens).revived,false);
  // No families => no suppression.
  assert.equal(isRevivedRewrite({content:forgotten},[],searchTokens).revived,false);
});

test('M01 moved predicates are equivalent to the former index.ts inline regexes',()=>{
  // Frozen copies of the regexes that lived in packages/memory/src/index.ts.
  // The Lead wires index.ts to these module functions; this test keeps the
  // relocation from silently changing matching behaviour.
  const inline={
    correction:/更正|纠正|改为|改用|改成|换成|调整为|不再|取消|instead|change|no longer|correct/iu,
    preference:/偏好|更喜欢|我.*习惯|以后|今后|默认|总是|always|prefer|usually/iu,
    quoted:/^\s*(?:>+|原文|摘录|转述|当前目标|本次|此次|这次|本轮|当前任务|假设|假如|如果|若\b|示例|例如|引用|文档(?:写道|说明)|(?:请|先|请先)?(?:读取|查看|阅读|检查|搜索|打开)|read\b|inspect\b|open\b|search\b|for this task\b|if\b|example\b)/iu,
  };
  const corpus=['更正：改为 PostgreSQL。','我被纠正了','改用 SQLite','调整为蓝色','no longer valid','exchange the value','我更喜欢绿色','我有个习惯','以后默认','默认输出','always','usually','本次使用','> 原文','摘录：','当前目标','假设','如果失败','若成功','示例','例如','引用','文档写道','请读取文件','先把配置打开','read the file','inspect','open','search','for this task','if needed','example output','正常的一行说明','今天天气不错'];
  for(const text of corpus){
    assert.equal(hasCorrectionMarker(text),inline.correction.test(text),`correction:${text}`);
    assert.equal(hasStablePreferenceCue(text),inline.preference.test(text),`preference:${text}`);
    assert.equal(isTaskOrQuotedCue(text),inline.quoted.test(text),`quoted:${text}`);
  }
});

test('M03 a bounded superset re-asserting the complete forgotten token set is revived',()=>{
  const family=buildSuppressionFamily('数据库写操作必须串行执行',searchTokens);
  // Added tail clause: Jaccard alone is 11/16 = 0.6875, below the 0.8 threshold.
  const tail=isRevivedRewrite({content:'数据库写操作必须串行执行，避免并发冲突。'},[family],searchTokens);
  assert.equal(tail.revived,true);
  assert.equal(tail.familyHash,family.hash);
  assert.equal(tail.overlap,1);
  // Added surrounding sentence within the bounded extension is still the same fact.
  assert.equal(isRevivedRewrite({content:'部署前，数据库写操作必须串行执行。'},[family],searchTokens).revived,true);
  assert.equal(FAMILY_EXTENSION_RATIO,1.6);
  assert.equal(FAMILY_EXTENSION_TOKEN_ALLOWANCE,4);
});

test('M03 superset revival is bounded and literal-aware',()=>{
  const family=buildSuppressionFamily('数据库写操作必须串行执行',searchTokens);
  // The forgotten sentence embedded in a long unrelated paragraph is guarded by
  // the token-ratio bound (it is not a bounded re-assertion of the fact).
  const swallowed='数据库写操作必须串行执行。另外部署流水线必须在合并到主分支之前运行完整回归测试，并保留全部失败日志，禁止跳过任何步骤，避免遗漏配置。';
  assert.equal(isRevivedRewrite({content:swallowed},[family],searchTokens).revived,false);
  // Different literals are a different fact even when the forgotten sentence is contained.
  assert.equal(isRevivedRewrite({content:'数据库写操作必须串行执行，避免 SQLite 并发冲突。'},[family],searchTokens).revived,false);
  // The complete forgotten token set is required; sharing one generic phrase is not revival.
  assert.equal(isRevivedRewrite({content:'部署流水线必须运行完整回归测试。'},[family],searchTokens).revived,false);
});
