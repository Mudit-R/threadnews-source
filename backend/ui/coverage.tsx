import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

type Match = {
  id: string;
  title: string;
  publisher: string;
  url: string;
  viaGoogleNews: boolean;
  publishedAt: string;
  dateBasis: string;
  official: boolean;
  similarWording: boolean;
  matchedTerms: string[];
};

type Coverage = { windowHours: number; matches: Match[] };
type LoadingState = { status: 'loading' } | { status: 'unavailable' } | { status: 'error' } | { status: 'ready'; data: Coverage };
type Order = 'match' | 'chronological';

const publishedFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata'
});

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function validMatch(value: unknown): value is Match {
  if (!object(value) || typeof value.url !== 'string') return false;
  try {
    const url = new URL(value.url);
    if (url.protocol !== 'https:' || url.username || url.password) return false;
  } catch { return false; }
  return typeof value.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(value.id) &&
    typeof value.title === 'string' && typeof value.publisher === 'string' &&
    typeof value.viaGoogleNews === 'boolean' && typeof value.official === 'boolean' &&
    typeof value.similarWording === 'boolean' && typeof value.dateBasis === 'string' &&
    typeof value.publishedAt === 'string' && Number.isFinite(Date.parse(value.publishedAt)) &&
    Array.isArray(value.matchedTerms) && value.matchedTerms.every(term => typeof term === 'string');
}

function parseCoverage(payload: unknown, id: string): Coverage {
  if (!object(payload) || payload.articleId !== id ||
      typeof payload.windowHours !== 'number' || payload.windowHours <= 0 ||
      !Array.isArray(payload.matches) || !payload.matches.every(validMatch)) {
    throw new Error('Invalid coverage response');
  }
  return { windowHours: payload.windowHours, matches: payload.matches };
}

function Report({ report }: { report: Match }) {
  const verb = report.dateBasis === 'indexed' ? 'Indexed' : report.dateBasis === 'updated' ? 'Updated' : 'Published';
  return (
    <li className="coverage-report">
      <div className="coverage-report-meta">
        <strong>{report.publisher}</strong>
        {report.official && <span className="coverage-report-tag">Official source</span>}
        <time dateTime={report.publishedAt}>{verb} {publishedFormat.format(new Date(report.publishedAt))}</time>
      </div>
      <h3><a href={'/news/' + encodeURIComponent(report.id)}>{report.title}</a></h3>
      {report.similarWording && <p className="coverage-shared">Nearly identical headline</p>}
      <p className="coverage-shared">Shared terms · {report.matchedTerms.join(', ')}</p>
      <a className="coverage-publisher-link" href={report.url} target="_blank" rel="noopener noreferrer">
        {report.viaGoogleNews ? 'Open via Google News' : 'Read at the publisher'} <span aria-hidden="true">↗</span>
      </a>
    </li>
  );
}

function CoveragePanel({ articleId, apiBase }: { articleId: string; apiBase: string }) {
  const [state, setState] = useState<LoadingState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [order, setOrder] = useState<Order>('match');
  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Coverage request timed out')), 10000);
    let mounted = true;
    async function load() {
      try {
        const response = await fetch(apiBase + '/api/news/' + encodeURIComponent(articleId) + '/coverage', {
          credentials: 'omit', signal: controller.signal
        });
        if (!mounted) return;
        if (response.status === 404) {
          setState({ status: 'unavailable' });
          return;
        }
        if (!response.ok) throw new Error('Coverage request failed');
        const data = parseCoverage(await response.json(), articleId);
        if (mounted) setState({ status: 'ready', data });
      } catch {
        if (mounted) setState({ status: 'error' });
      } finally {
        clearTimeout(timeout);
      }
    }
    void load();
    return () => {
      mounted = false;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [apiBase, articleId, attempt]);

  if (state.status === 'loading') return <p role="status">Looking for nearby coverage…</p>;
  if (state.status === 'unavailable') return <p role="status">Coverage comparison is unavailable for this article.</p>;
  if (state.status === 'error') return (
    <div className="coverage-panel-error">
      <p role="status">Coverage could not be loaded.</p>
      <button className="button" type="button" onClick={() => {
        setState({ status: 'loading' });
        setAttempt(value => value + 1);
      }}>Try again</button>
    </div>
  );

  const { matches, windowHours } = state.data;
  if (!matches.length) return <p role="status">No similar headlines found among recent reports within {windowHours} hours of this article.</p>;
  const visible = order === 'match' ? matches : [...matches].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
  return (
    <>
      <div className="coverage-panel-controls">
        <p role="status">{matches.length} {matches.length === 1 ? 'publisher' : 'publishers'} with similar headlines</p>
        {matches.length > 1 && (
          <label>Order <select value={order} onChange={event => setOrder(event.target.value === 'chronological' ? 'chronological' : 'match')}>
            <option value="match">Closest match</option>
            <option value="chronological">Oldest first</option>
          </select></label>
        )}
      </div>
      <p className="coverage-panel-note">Matches use headlines and dates within a {windowHours}-hour window. Outlets may be citing the same original report.</p>
      <ul className="coverage-report-list">
        {visible.map(report => <Report key={report.id} report={report} />)}
      </ul>
    </>
  );
}

export function mount(container: HTMLElement, input: { articleId: string; apiBase: string }) {
  const root = createRoot(container);
  root.render(<CoveragePanel {...input} />);
  return () => root.unmount();
}
