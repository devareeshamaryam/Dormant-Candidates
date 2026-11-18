const STAGE_ID = 11941;
const DORMANT_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const TRIGGER_TYPE_IDS = [100541, 100548, 100556, 108860, 100552];
const BLOCK_TYPE_IDS = [100546, 113891, 100549];
const STOP_TYPE_IDS = [100550, 100551, 100547];
const SENT_TYPE_ID = 100547;

const typeId = (e) => e.activity_type_id ?? e.activity_type?.id;
const eventPersonId = (e) => e.person_id ?? e.person?.id;
const daysAgoIso = (days, now = Date.now()) => new Date(now - days * DAY_MS).toISOString();

// Strip formatting; only accept numbers already in +<digits> form.
function normalizePhone(value) {
  const s = String(value || '').replace(/[\s\-.()]/g, '');
  return /^\+\d{6,15}$/.test(s) ? s : '';
}

// City falls back to the job's city when the person has none.
function extractContact(candidate, job) {
  const p = candidate.person || {};
  return {
    personId: p.id,
    candidateId: candidate.id,
    jobId: job.id,
    name: String(p.name || '').trim(),
    city: String(p.city || '').trim() || job.city,
    phone: normalizePhone(p.phones?.[0]?.value),
    email: p.emails?.[0]?.value || '',
  };
}

function needMessage(events, now = Date.now()) {
  let latestTrigger = 0;
  for (const e of events) {
    const t = typeId(e);
    if (BLOCK_TYPE_IDS.includes(t) || STOP_TYPE_IDS.includes(t)) return false;
    if (TRIGGER_TYPE_IDS.includes(t)) latestTrigger = Math.max(latestTrigger, Date.parse(e.created_at));
  }
  // NaN (unparseable date) fails both checks, so the person is skipped.
  return latestTrigger > 0 && now - latestTrigger >= DORMANT_DAYS * DAY_MS;
}

const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const messageText = (name, city) =>
  `Good morning ${escapeHtml(name)}. I am Steve, of Ateca Consulting, a specialist search firm in private banking. ` +
  `Your name came up while I was mapping the senior bankers covering ${escapeHtml(city)}, and it came up more than once. ` +
  `I am working on a confidential mandate that sits close to your profile. I would rather explain it on a call than in writing, ` +
  `fifteen minutes, and you decide from there whether it goes any further.`;

module.exports = {
  STAGE_ID, DORMANT_DAYS, SENT_TYPE_ID,
  typeId, eventPersonId, daysAgoIso, extractContact, needMessage, messageText,
};
