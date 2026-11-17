importScripts('/article-ranker.js?v=1');
self.addEventListener('message', ({ data }) => {
  if (!Number.isInteger(data?.request) || !Array.isArray(data.articles) || data.articles.length > 160) return;
  const model = globalThis.ThreadNewsArticleRanker;
  let history = model.validFeedback(data.history);
  const article = data.articles.find(item => item.id === data.feedback?.id);
  if (article && [0,1].includes(data.feedback.label)) {
    history = [...history.filter(row => row.id !== article.id), model.feedback(article,data.feedback.label)].slice(-model.limit);
  }
  self.postMessage({ request:data.request, history, ranked:model.rank(data.articles,history) });
});
