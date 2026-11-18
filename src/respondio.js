const BASE_URL = 'https://api.respond.io/v2';
const TEMPLATE_NAME = 'ateca_cold_approach_mapped_v1';
const TEMPLATE_LANGUAGE = 'en';
const SENDER_NAME = 'Steve'; // template variable {{2}}
const TAG = 'outreach';
const MAX_RETRIES = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const contactPath = (phone) => `/contact/${encodeURIComponent(`phone:${phone}`)}`;

// Retries 429 always; 5xx only when the call is safe to repeat
// (never for the message send, so a candidate can't get the template twice).
async function call(method, path, body, { retry5xx = true, allow404 = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(BASE_URL + path, {
      method,
      headers: {
        Authorization: `Bearer ${process.env.RESPOND_API_TOKEN}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: body && JSON.stringify(body),
    });
    const retryable = res.status === 429 || (retry5xx && res.status >= 500);
    if (retryable && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
      continue;
    }
    if (allow404 && res.status === 404) return null;
    const text = await res.text();
    if (!res.ok) throw new Error(`respond.io ${method} ${path.split('/').pop()} -> HTTP ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }
}

// True if this phone already carries the outreach tag in respond.io (= already approached).
async function alreadyApproached(phone) {
  const contact = await call('GET', contactPath(phone), undefined, { allow404: true });
  return Boolean(contact?.tags?.includes(TAG));
}

// Returns 'sent', or 'skipped' when the contact was already approached.
// The tag is added BEFORE sending, so even if the run crashes after the send,
// the next run sees the tag and never messages this phone again.
async function sendOutreach(c) {
  if (await alreadyApproached(c.phone)) return 'skipped';

  await call('POST', `/contact/create_or_update/${encodeURIComponent(`phone:${c.phone}`)}`, {
    firstName: c.name,
    phone: c.phone,
    custom_fields: [
      { name: 'loxo_candidate_id', value: String(c.candidateId) },
      { name: 'loxo_job_id', value: String(c.jobId) },
      { name: 'loxo_person_id', value: String(c.personId) },
    ],
  });

  await sleep((Number(process.env.CONTACT_DELAY_SEC) || 3) * 1000);

  await call('POST', `${contactPath(c.phone)}/tag`, [TAG]);

  await call('POST', `${contactPath(c.phone)}/message`, {
    channelId: Number(process.env.RESPOND_CHANNEL_ID),
    message: {
      type: 'whatsapp_template',
      template: {
        name: TEMPLATE_NAME,
        languageCode: TEMPLATE_LANGUAGE,
        components: [{
          type: 'body',
          parameters: [
            { type: 'text', text: c.name },
            { type: 'text', text: SENDER_NAME },
            { type: 'text', text: c.city },
          ],
        }],
      },
    },
  }, { retry5xx: false });
  return 'sent';
}

module.exports = { sendOutreach, TEMPLATE_NAME, SENDER_NAME };
