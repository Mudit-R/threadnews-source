// Explicit registry prevents clients from turning ingestion into an arbitrary URL fetcher.
// Enable a publisher only after its current terms permit the intended audience/use.
export const FEEDS = [
  { id:'gdelt-economy',publisher:'The GDELT Project',format:'gdelt',query:'(inflation OR economy OR tariff OR unemployment OR "interest rates" OR "cost of living")',category:'Economy',region:'Global',sourceType:'News report',enabledByDefault:false,terms:'https://www.gdeltproject.org/about.html#termsofuse',note:'Open discovery metadata, attributed to GDELT and the original publisher. Index time is not a verified publication time. Full publisher articles and images are not republished.' },
  { id:'gdelt-world',publisher:'The GDELT Project',format:'gdelt',query:'(ceasefire OR sanctions OR invasion OR earthquake OR election OR humanitarian)',category:'World affairs',region:'Global',sourceType:'News report',enabledByDefault:false,terms:'https://www.gdeltproject.org/about.html#termsofuse',note:'GDELT headline/link discovery; source claims are not independently verified.' },
  { id:'gdelt-health',publisher:'The GDELT Project',format:'gdelt',query:'(outbreak OR vaccine OR "public health" OR "drug approval" OR "healthcare costs")',category:'Health',region:'Global',sourceType:'News report',enabledByDefault:false,terms:'https://www.gdeltproject.org/about.html#termsofuse',note:'GDELT headline/link discovery. No medical advice or inferred article summaries.' },
  { id:'gdelt-infrastructure',publisher:'The GDELT Project',format:'gdelt',query:'(railway OR "power grid" OR "water supply" OR "energy prices" OR "climate policy")',category:'Infrastructure',region:'Global',sourceType:'News report',enabledByDefault:false,terms:'https://www.gdeltproject.org/about.html#termsofuse',note:'GDELT headline/link discovery focused on services that affect everyday life.' },
  { id:'fed-monetary',publisher:'Federal Reserve',url:'https://www.federalreserve.gov/feeds/press_monetary.xml',category:'Economy',region:'North America',sourceType:'Official source',enabledByDefault:false,terms:'https://www.federalreserve.gov/website-linking-policies.htm',note:'Official monetary-policy releases; an institutional account, not independent corroboration.' },
  { id:'ecb',publisher:'European Central Bank',url:'https://www.ecb.europa.eu/rss/press.html',category:'Economy',region:'Europe',sourceType:'Official source',enabledByDefault:false,terms:'https://www.ecb.europa.eu/services/disclaimer/html/index.en.html',note:'Attributed official headline/link metadata. Source opinions are not an endorsement by ThreadNews.' },
  ...['cpi','ppi','empsit'].map(id => ({ id:'bls-'+id,publisher:'U.S. Bureau of Labor Statistics',url:`https://www.bls.gov/feed/${id}.rss`,category:'Economy',region:'North America',sourceType:'Official source',enabledByDefault:false,terms:'https://www.bls.gov/opub/copyright-information.htm',note:'Dated U.S. releases covering consumer prices, producer prices and employment.' })),
  { id:'uk-energy',publisher:'UK Department for Energy Security and Net Zero',url:'https://www.gov.uk/search/news-and-communications.atom?organisations%5B%5D=department-for-energy-security-and-net-zero',category:'Energy',region:'Europe',sourceType:'Official source',enabledByDefault:false,terms:'https://www.gov.uk/help/terms-conditions',note:'UK announcements about energy supply, prices, and policy. Feed timestamps can reflect updates.' },
  ...[
    ['uk-transport','UK Department for Transport','department-for-transport','Infrastructure'],
    ['uk-education','UK Department for Education','department-for-education','Politics'],
    ['uk-home-office','UK Home Office','home-office','Politics']
  ].map(([id,publisher,department,category])=>({id,publisher,category,
    url:`https://www.gov.uk/search/news-and-communications.atom?organisations%5B%5D=${department}`,
    region:'United Kingdom',sourceType:'Official source',enabledByDefault:false,
    terms:'https://www.gov.uk/help/terms-conditions', licensedFeedSummary:true,
    note:'Official announcement. Short first-party feed descriptions carry Open Government Licence attribution.'})),
  { id:'nasa', publisher:'NASA', url:'https://www.nasa.gov/news-release/feed/', category:'Space & science', region:'Global', sourceType:'Official source', enabledByDefault:true, terms:'https://www.nasa.gov/nasa-brand-center/images-and-media/' },
  { id:'un-news', publisher:'UN News', url:'https://news.un.org/feed/subscribe/en/news/all/rss.xml', category:'World affairs', region:'Global', sourceType:'Official source', enabledByDefault:true, terms:'https://www.un.org/en/about-us/terms-of-use' },
  { id:'google-world', publisher:'Google News', url:'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en', category:'World affairs', region:'Global', sourceType:'News report', discovery:'Google News', enabledByDefault:false, terms:'https://policies.google.com/terms', note:'Public RSS discovery endpoint, not a supported/licensed Google News API. Headline/link metadata only. Review use before public release.' },
  { id:'bbc-world', publisher:'BBC News', url:'https://feeds.bbci.co.uk/news/world/rss.xml', category:'World affairs', region:'Global', sourceType:'News report', enabledByDefault:false, terms:'https://www.bbc.co.uk/usingthebbc/terms/', note:'Review RSS-specific reuse conditions and preserve BBC News attribution.' },
  { id:'nhk-world', publisher:'NHK WORLD-JAPAN', url:'https://www3.nhk.or.jp/nhkworld/data/en/news/all.rss', category:'World affairs', region:'Asia', sourceType:'News report', enabledByDefault:false, terms:'https://www3.nhk.or.jp/nhkworld/en/information/terms/', note:'Verify endpoint availability and public aggregation permission before enabling.' },
  { id:'cna-world', publisher:'CNA', url:'https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=6511', category:'World affairs', region:'Asia', sourceType:'News report', enabledByDefault:false, blocked:true, terms:'https://www.channelnewsasia.com/rss/rssterms', note:'Published RSS terms prohibit redistribution to third parties. Obtain permission; this registry entry alone does not authorize use.' }
];

export function enabledFeeds(env={}) {
  const configured=typeof env.ENABLED_FEEDS==='string' ? new Set(env.ENABLED_FEEDS.split(',').map(x=>x.trim()).filter(Boolean)) : null;
  return FEEDS.filter(f=>!f.blocked&&(configured?configured.has(f.id):f.enabledByDefault));
}
export function canonicalPublisher(value){
  return ({'Bloomberg.com':'Bloomberg','DW.com':'DW','Euronews.com':'Euronews','ABC News - Breaking News, Latest News and Videos':'ABC News'})[value]||value;
}
export function enabledFeedIds(env={}){
  return enabledFeeds(env).flatMap(feed=>{
    if(feed.id!=='google-world')return [feed.id];
    if(env.GOOGLE_NEWS_ENABLED!=='true'&&env.GOOGLE_NEWS_RIGHTS_ACK!=='true')return [];
    return [...new Set(String(env.GOOGLE_NEWS_TOPICS||'WORLD').split(',').map(x=>x.trim().toUpperCase()).filter(x=>['WORLD','BUSINESS','HEALTH'].includes(x)))].map(topic=>'google-'+topic.toLowerCase());
  });
}
