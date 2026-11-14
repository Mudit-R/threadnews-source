// Editorial scope, applied equally to curated imports and automatic discovery.
// Subject rules never block an entire publisher or grade truth, reliability or bias.
export const POLICY_VERSION='2026-11-04.1';
export const CATEGORY_ALLOWLIST=Object.freeze(['Economy','Finance','Politics','World','Infrastructure','Health','Energy','Trade']);
const CATEGORY_ALIASES=Object.freeze({
  economy:'Economy',finance:'Finance',politics:'Politics',world:'World','world affairs':'World',
  infrastructure:'Infrastructure',health:'Health',energy:'Energy',trade:'Trade'
});
export function normalizeCategory(value){
  const raw=typeof value==='string'?value.trim().replace(/\s+/g,' '):'';
  const canonical=CATEGORY_ALIASES[raw.toLowerCase()];
  return canonical?{category:canonical,rejectReason:null}:{category:raw,rejectReason:raw?'category_not_allowed':'category_missing'};
}
const CATEGORY_POINTS=Object.freeze({'economy':25,'finance':25,'politics':20,'world':18,'infrastructure':22,'health':22,'energy':22,'trade':20});
const SIGNALS=Object.freeze([
  {id:'household_costs_and_economy',points:18,pattern:/\b(?:inflation|cost of living|consumer prices?|food prices?|energy prices?|fuel prices?|electricity prices?|housing costs?|rent(?:s|al)? (?:rise|rises|increase|increases|costs?)|mortgages?|interest rates?|borrowing costs?|tariffs?|tax(?:es|ation)?|gdp|gross domestic product|economic (?:growth|contraction|recession)|recession|unemployment)\b/i},
  {id:'jobs_and_livelihoods',points:18,pattern:/\b(?:layoffs?|laid off|job cuts?|job losses?|redundan(?:cy|cies)|workers? (?:strike|pay|rights|safety)|labou?r (?:rights|law|dispute|market)|working conditions|minimum wage|wage (?:growth|rise|rises|cuts?)|pensions?|collective bargaining|trade unions?)\b/i},
  {id:'law_and_public_rights',points:16,pattern:/\b(?:legislation|regulat(?:ion|ions|or|ors|ory)|antitrust|court (?:ruling|rulings|order|orders|case|cases)|supreme court|lawsuits?|data protection|consumer rights|civil rights|voting rights|election(?:s)?|parliament|sanctions?|public (?:policy|spending|services))\b/i},
  {id:'health_and_safety',points:16,pattern:/\b(?:public health|healthcare|health care|hospitals?|epidemic|pandemic|outbreak|vaccin(?:e|es|ation)|drug approval|disease|recalls?|safety (?:warning|warnings|risk|risks|hazard|hazards)|fire hazard|food safety|consumer safety|crash(?:es)?|fatalities|deaths?|casualties|killed|injur(?:y|ies)|emergency (?:alert|alerts|services|warning|warnings))\b/i},
  {id:'infrastructure_and_essential_services',points:14,pattern:/\b(?:infrastructure|railways?|railroads?|high[ -]speed rail|bullet train|metro (?:line|lines|rail|project)|power grid|electricity (?:supply|outage)|power (?:outage|outages)|water (?:supply|quality|shortage)|public transport|transport (?:network|networks|project|projects)|sewage|broadband access)\b/i},
  {id:'security_and_privacy',points:16,pattern:/\b(?:data breach|privacy (?:breach|violation|violations|law|laws|rights|protection)|personal data|cyber ?attack|cybersecurity|ransomware|security (?:breach|vulnerabilit(?:y|ies)|flaw|flaws|patch|patches)|war|invasion|ceasefire|armed conflict|missile attack|nuclear (?:safety|security))\b/i},
  {id:'climate_and_disasters',points:14,pattern:/\b(?:climate|wildfires?|flood(?:s|ing)?|earthquakes?|drought|heatwave|heat wave|hurricane|cyclone|emissions?|air pollution|environmental (?:damage|protection|regulation))\b/i}
]);
const GAME=/\b(?:games?|gaming|gameplay|videogames?|playstation|xbox|nintendo|console|steam deck|esports?|warhammer|fortnite|pok[eé]mon|minecraft|call of duty|grand theft auto|god of war|baldur['’]s gate|final fantasy)\b/i;
const GADGET=/\b(?:iphone|ipad|macbook|galaxy|pixel|smartphones?|phones?|laptops?|headphones?|earbuds?|smartwatches?|tablets?|graphics cards?|gpus?|cameras?|gadgets?|televisions?|tvs?)\b/i;
const PROMOTION=/\b(?:trailers?|teasers?|gameplay|walkthroughs?|speedruns?|boss fights?|tier lists?|patch notes|early access|release dates?|pre[ -]?orders?|dlc|expansion packs?|cosplay)\b/i;
const REVIEW=/\b(?:reviews?|previews?|unboxings?|hands[ -]on|first impressions|first look|buying guide|buyers? guide)\b/i;
const SHOPPING=/\b(?:best deals?|shopping (?:deals|picks|guide)|discount codes?|coupon codes?|promo codes?|black friday|cyber monday|prime day|best (?:budget |cheap )?(?:phones?|laptops?|headphones?|earbuds?|tablets?|tvs?|gadgets?|games?)|top \d+ (?:phones?|laptops?|headphones?|earbuds?|tablets?|tvs?|gadgets?|games?))\b/i;
const BARGAIN=/\bdeals?\b.*\b(?:roundup|buy|picks|savings|shopping|available now)\b|\b(?:save|under) [£$€]\s*\d|\b\d+\s*% off\b/i;
const GOSSIP=/\b(?:red carpet|celebrity (?:couple|romance|gossip)|dating rumou?rs?|relationship rumou?rs?|paparazzi|spotted (?:with|together|hanging)|hangs? out with|boyfriend|girlfriend|celebrates? (?:formula 1|f1) champion|returns home after a \d+-year journey)\b/i;
const ENTERTAINMENT=/\b(?:box office|movie review|film review|album review|episode recap|season finale|streaming picks|award show|grammys?|oscars?|emmys?|golden globes)\b/i;
const SPORTS=/\b(?:match highlights|match recap|wins? the (?:melbourne cup|world cup|championship)|celebrates? (?:formula 1|f1) champion|(?:football|soccer|cricket|tennis|basketball) (?:scores|results|highlights)|goals? of the (?:week|season))\b/i;
// Broad words such as "war", "hospital" or "recall" can also be fictional game
// or film subjects. Override a promotional exclusion only with a more explicit
// real-world impact phrase, rather than any priority-score signal.
const IMPACT_EXCEPTION=/\b(?:layoffs?|laid off|job cuts?|job losses?|redundan(?:cy|cies)|workers? (?:strike|pay|rights|safety)|labou?r (?:rights|law|dispute|market)|working conditions|minimum wage|wage (?:growth|rise|rises|cuts?)|pensions?|collective bargaining|trade unions?|lawsuits?|legislation|antitrust|regulat(?:ion|ions|or|ors|ory)|data breach|data protection|personal data|privacy (?:breach|violation|violations|law|laws|rights|protection)|cyber ?attack|cybersecurity|ransomware|security (?:breach|vulnerabilit(?:y|ies)|flaw|flaws|patch|patches)|public health|healthcare|health care|epidemic|pandemic|outbreak|vaccin(?:e|es|ation)|drug approval|(?:product|battery|food|vehicle|safety|drug) recall|recalls? (?:of|over|affects|due)|fire hazard|consumer safety|food safety|safety (?:warning|warnings|risk|risks|hazard|hazards)|consumer rights|civil rights|voting rights|supreme court|court (?:ruling|rulings|order|orders)|inflation|cost of living|consumer prices?|tariffs?|interest rates?|borrowing costs?|gdp|economic (?:growth|contraction|recession)|tax (?:credits?|rebates?|rates?|cuts?|increase|relief|rules)|public (?:policy|spending|services|transport)|power grid|water (?:supply|quality|shortage)|electricity (?:supply|outage)|broadband access|evacuations?|disaster relief)\b/i;
function subject(article={}){return {title:String(article?.title||'').slice(0,800),context:[String(article?.title||'').slice(0,800),String(article?.summary||'').slice(0,2400)].join(' '),category:String(article?.category||'').trim().toLowerCase()};}
function signals(context){return SIGNALS.filter(signal=>signal.pattern.test(context));}

export function exclusionReason(article={}){
  const {title,context,category}=subject(article);
  // A game-company layoff, product recall or privacy breach stays in scope.
  // A matching impact term is an editorial signal, never proof of the report.
  if(IMPACT_EXCEPTION.test(context))return null;
  if(/^(?:sport|sports|entertainment|celebrity|lifestyle)$/.test(category))return 'outside_editorial_scope';
  if(GOSSIP.test(title))return 'personal_or_celebrity_gossip';
  if(SPORTS.test(title))return 'sporting_result_or_highlight';
  if(SHOPPING.test(title)||((GAME.test(title)||GADGET.test(title))&&BARGAIN.test(title)))return 'shopping_or_product_listicle';
  if(ENTERTAINMENT.test(title)||PROMOTION.test(title))return 'gaming_or_entertainment_promotion';
  if((GAME.test(title)||GADGET.test(title))&&REVIEW.test(title))return 'product_review_or_showcase';
  if(GADGET.test(title)&&/\b(?:rumou?rs?|leaks?|renders?|colour options|color options|specifications|specs)\b/i.test(title))return 'product_gossip_or_speculation';
  return null;
}
export const isImpactNews=article=>exclusionReason(article)===null;

export function impactAssessment(article={}){
  const reason=exclusionReason(article),{context,category}=subject(article),categoryPoints=CATEGORY_POINTS[category]??0;
  const matched=signals(context).map(({id,points})=>({id,points}));
  return {score:reason?0:Math.min(100,categoryPoints+matched.reduce((sum,signal)=>sum+signal.points,0)),categoryPoints:reason?0:categoryPoints,signals:reason?[]:matched,excludedReason:reason,policyVersion:POLICY_VERSION};
}
export const impactScore=article=>impactAssessment(article).score;

export const EDITORIAL_POLICY=Object.freeze({
  version:POLICY_VERSION,
  categories:CATEGORY_ALLOWLIST,
  focus:'Economy, finance, politics, world affairs, infrastructure, health, energy and trade developments with direct public impact.',
  excluded:'Celebrity and personal gossip, sporting results, entertainment or gameplay promotions, routine product reviews and speculation, and shopping or bargain listicles without an identified public impact.',
  exceptions:'Reports about jobs, law, public rights, privacy, security, health, recalls, essential services or other stated public-impact subjects remain in scope even when they concern entertainment, games or consumer products. Publishers are not blocked as a group.',
  selection:'Only the eight listed categories are admitted to news coverage. “World affairs” is a direct alias for “World”; other categories are not guessed from a headline. Topic and headline rules are transparent filters, not a universal measure of importance, truth or neutrality. These rules can make mistakes and are open to correction.',
  scoring:{name:'Public-impact priority',range:[0,100],formula:'Excluded subjects receive zero. Otherwise add the category points and each matched public-impact group once, capped at 100. Only the headline and short attributed summary are searched; repeated terms do not add extra points.',categoryPoints:CATEGORY_POINTS,signals:SIGNALS.map(({id,points})=>({id,points})),limitations:'The score prioritizes editorial subjects. It does not estimate accuracy, independence, impartiality, severity, audience size or how strongly an event will affect a particular reader. Publisher identity, official status and source counts do not increase it.'}
});
