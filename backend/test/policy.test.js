import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORY_ALLOWLIST,normalizeCategory,exclusionReason,isImpactNews,impactScore,impactAssessment,EDITORIAL_POLICY,POLICY_VERSION } from '../src/policy.js';

const article=(title,category='Technology',patch={})=>({title,category,...patch});
test('category fixtures admit only canonical labels and the reviewed World affairs alias',()=>{
  assert.deepEqual(CATEGORY_ALLOWLIST,['Economy','Finance','Politics','World','Infrastructure','Health','Energy','Trade']);
  for(const value of CATEGORY_ALLOWLIST)assert.deepEqual(normalizeCategory(value.toLowerCase()),{category:value,rejectReason:null});
  assert.deepEqual(normalizeCategory('  World   affairs '),{category:'World',rejectReason:null});
});
test('unsupported or missing categories receive deterministic rejection reasons without semantic guessing',()=>{
  for(const value of ['Technology','Climate','Science','Sport','Business','Public safety'])assert.deepEqual(normalizeCategory(value),{category:value,rejectReason:'category_not_allowed'});
  assert.deepEqual(normalizeCategory(''),{category:'',rejectReason:'category_missing'});
  assert.deepEqual(normalizeCategory('Business',{title:'Bank announces a merger and dividend'}),{category:'Business',rejectReason:'category_not_allowed'});
});
test('routine entertainment, gaming promotion, gadget speculation and shopping lists are excluded by subject',()=>{
  for(const title of ['Official gameplay trailer reveals a new expansion','A new cinematic trailer for Warhammer','Total War Warhammer gameplay trailer','God of War launch trailer arrives','Total Recall official trailer','Warhammer 40K review: our verdict','Xbox game review: our verdict','First look at a Nintendo game','The best headphones under $100','Black Friday laptop deals are here','New iPhone renders reveal colour options','Galaxy phone unboxing and first impressions','Celebrity couple spotted together on the red carpet','Football match highlights and results']){
    assert(exclusionReason(article(title)),title);assert.equal(impactScore(article(title)),0,title);
  }
  assert.equal(exclusionReason(article('An award-winning performance','Entertainment')),'outside_editorial_scope');
});
test('public-impact reporting survives entertainment/game/product subjects without blocking publishers',()=>{
  for(const title of ['Game studio announces layoffs affecting 200 jobs','New gaming privacy breach exposes personal data','Nintendo faces a lawsuit over consumer rights','Laptop battery recall after a fire hazard','New console security vulnerability puts users at risk','Game workers strike over working conditions','Sporting body announces new public health rules','How a new tariff will change smartphone prices'])assert.equal(exclusionReason(article(title)),null,title);
  assert(isImpactNews(article('Game studio layoffs','Entertainment',{source:{publisher:'IGN'}})));
  assert(!isImpactNews(article('Game gameplay trailer','Technology',{source:{publisher:'IGN'}})));
});
test('selection exceptions can use an attributed summary when a headline is ambiguous',()=>{
  const item=article('A game launch sparks a backlash','Entertainment',{summary:'Workers strike over working conditions and layoffs.'});
  assert.equal(exclusionReason(item),null);
  assert.equal(exclusionReason(article('Gaming trailer launch recap','Entertainment',{summary:'An exciting new character reveal.'})),'outside_editorial_scope');
});
test('corporate transactions and financial headlines are not mistaken for shopping deals',()=>{
  for(const title of ['Carl Icahn’s CVR Energy Strikes $4 Billion Deal for Two Marathon Refineries','Chip maker signs deal for a new factory','Shares trade under $100 after quarterly earnings','Phone maker announces a merger with a rival'])assert.equal(exclusionReason(article(title,'Economy')),null,title);
  assert.equal(exclusionReason(article('Laptop deals roundup: savings available now')),'shopping_or_product_listicle');
});
test('impact priority is deterministic, bounded and independent of publisher and official status',()=>{
  const item=article('Inflation raises household costs as interest rates rise','Economy');
  const score=impactScore(item);assert.equal(score,43);
  assert.equal(impactScore({...item,source:{publisher:'An official agency',sourceType:'Official source'},officialSources:Array(20).fill({})}),score);
  assert.equal(impactScore({...item,source:{publisher:'A tabloid'}}),score);
  assert.equal(impactScore(article('Inflation inflation inflation inflation','Economy')),43);
  assert(impactScore(item)>impactScore(article('A new software interface is announced')));
  const maximal=article('Inflation layoffs public health legislation railway war climate','Economy');assert.equal(impactScore(maximal),100);
  assert(Number.isInteger(impactScore({}))&&impactScore({})>=0&&impactScore({})<=100);
});
test('the public policy explains the formula and keeps subject priority separate from truth or neutrality',()=>{
  const assessment=impactAssessment(article('Privacy breach triggers a data protection lawsuit','Politics'));
  assert.equal(assessment.policyVersion,POLICY_VERSION);assert.deepEqual(assessment.signals.map(signal=>signal.id),['law_and_public_rights','security_and_privacy']);
  assert.equal(assessment.score,52);assert.deepEqual(EDITORIAL_POLICY.categories,CATEGORY_ALLOWLIST);assert.equal(EDITORIAL_POLICY.scoring.range[1],100);
  assert.match(EDITORIAL_POLICY.scoring.limitations,/does not estimate accuracy/);assert.match(EDITORIAL_POLICY.selection,/mistakes/);
});
