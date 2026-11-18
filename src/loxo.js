const MAX_RETRIES = 8;
const MAX_BACKOFF_MS = 30000;
const CONCURRENCY = 10;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Exponential backoff with jitter so parallel requests don't retry in lockstep.
const backoff = (attempt) => Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt) * (0.5 + Math.random());
const baseUrl = () => `https://app.loxo.co/api/${process.env.LOXO_SLUG}`;

// Simple concurrency limiter shared by all Loxo requests.
function limiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}
const limit = limiter(CONCURRENCY);

async function rawRequest(path, { method = 'GET', body, headers = {} } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(baseUrl() + path, {
        method,
        body,
        headers: { Authorization: `Bearer ${process.env.LOXO_TOKEN}`, Accept: 'application/json', ...headers },
      });
    } catch (err) {
      if (attempt >= MAX_RETRIES) throw new Error(`${method} ${path.split('?')[0]} -> ${err.message}`);
      await sleep(backoff(attempt));
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
      continue;
    }
    if (!res.ok) throw new Error(`${method} ${path.split('?')[0]} -> HTTP ${res.status}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
}

const request = (path, opts) => limit(() => rawRequest(path, opts));

// Returns [{ id, city }] deduped by id (city is the fallback for candidates without one).
async function listJobs() {
  const jobs = new Map();
  for (let page = 1; ; page++) {
    const data = await request(`/jobs?per_page=100&page=${page}`);
    const items = data.jobs || data.results || data.data || [];
    items.forEach((j) => jobs.set(j.id, { id: j.id, city: String(j.city || '').trim() }));
    if (items.length < 100) break;
  }
  return [...jobs.values()];
}

// Follows scroll_id until it is empty/repeated. complete = we got at least total_count items.
async function scroll(path, key) {
  const items = [];
  let scrollId;
  let total;
  for (;;) {
    const url = scrollId ? `${path}&scroll_id=${encodeURIComponent(scrollId)}` : path;
    const data = await request(url);
    total ??= data.total_count;
    const page = data[key] || [];
    items.push(...page);
    if (!page.length || !data.scroll_id || data.scroll_id === scrollId) break;
    if (total != null && items.length >= total) break;
    scrollId = data.scroll_id;
  }
  return { items, complete: total == null || items.length >= total };
}

const stageCandidates = (jobId, stageId) =>
  scroll(`/jobs/${jobId}/candidates?per_page=100&query=${encodeURIComponent(`workflow_stage_id:${stageId}`)}`, 'candidates');

const jobEventsSince = (jobId, sinceIso) =>
  scroll(`/person_events?per_page=100&job_ids%5B%5D=${jobId}&created_at_start=${encodeURIComponent(sinceIso)}`, 'person_events');

const personEvents = (personId) => scroll(`/person_events?per_page=100&person_id=${personId}`, 'person_events');

function logPersonEvent(personId, jobId, activityTypeId, notesHtml) {
  const body = new URLSearchParams({
    'person_event[person_id]': String(personId),
    'person_event[job_id]': String(jobId),
    'person_event[activity_type_id]': String(activityTypeId),
    'person_event[notes]': notesHtml,
  });
  return request('/person_events', {
    method: 'POST',
    body: body.toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
}

module.exports = { sleep, listJobs, stageCandidates, jobEventsSince, personEvents, logPersonEvent };
