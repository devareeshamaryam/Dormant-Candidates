require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const loxo = require('./loxo');
const logic = require('./logic');
const state = require('./state');
const respondio = require('./respondio');
const sheets = require('./sheets');

const DRY_RUN = process.env.DRY_RUN !== 'false';
const MAX_PER_RUN = Number(process.env.MAX_PER_RUN) || 50;
const DELAY_SEC = Number(process.env.DELAY_BETWEEN_MESSAGES_SEC) || 0;
const LOG_RETRIES = 3;

async function run() {
  const started = Date.now();
  const stats = { jobs: 0, inStage: 0, dormant: 0, stored: 0, withPhone: 0, needMessage: 0, final: 0, alreadyTagged: 0, sent: 0, failures: 0 };

  for (const key of ['LOXO_TOKEN', 'LOXO_SLUG', ...(DRY_RUN ? [] : ['RESPOND_API_TOKEN', 'RESPOND_CHANNEL_ID'])]) {
    if (!process.env[key]) throw new Error(`Missing ${key}`);
  }
  console.log(`Run started ${new Date(started).toISOString()} (DRY_RUN=${DRY_RUN}, MAX_PER_RUN=${MAX_PER_RUN})`);

  // Step 2: jobs (optionally limited by JOB_IDS)
  const wanted = process.env.JOB_IDS ? new Set(process.env.JOB_IDS.split(',').map((s) => Number(s.trim()))) : null;
  const jobs = (await loxo.listJobs()).filter((j) => !wanted || wanted.has(j.id));
  stats.jobs = jobs.length;

  // Step 3: dormant candidates per job
  const since = logic.daysAgoIso(logic.DORMANT_DAYS);
  const dormant = [];
  await Promise.all(jobs.map(async (job) => {
    try {
      const [cands, recent] = await Promise.all([loxo.stageCandidates(job.id, logic.STAGE_ID), loxo.jobEventsSince(job.id, since)]);
      const inStage = cands.items.filter((c) => c.workflow_stage_id === logic.STAGE_ID);
      stats.inStage += inStage.length;
      if (!cands.complete || !recent.complete) throw new Error('incomplete candidate or activity list');
      const active = new Set(recent.items.map(logic.eventPersonId));
      for (const c of inStage) {
        if (!active.has(c.person?.id)) dormant.push(logic.extractContact(c, job));
      }
    } catch (err) {
      stats.failures++;
      console.error(`Job ${job.id} skipped: ${err.message}`);
    }
  }));
  dormant.sort((a, b) => a.candidateId - b.candidateId);
  stats.dormant = dormant.length;

  // Store all dormant candidates in the Google Sheet
  if (process.env.GOOGLE_SHEET_ID) {
    try {
      await sheets.writeList(dormant);
      stats.stored = dormant.length;
    } catch (err) {
      stats.failures++;
      console.error(`Google Sheet write failed: ${err.message}`);
    }
  }

  // Step 4: only people with a phone (and a name/city for the template); skip the local sent log;
  // dedupe by person and by phone (two Loxo records can share one number)
  const alreadySent = state.loadSent();
  const byPerson = new Map();
  const phones = new Set();
  for (const c of dormant) {
    if (!c.personId || !c.phone || !c.name || !c.city || alreadySent.has(c.personId)) continue;
    if (byPerson.has(c.personId) || phones.has(c.phone)) continue;
    byPerson.set(c.personId, c);
    phones.add(c.phone);
  }
  stats.withPhone = byPerson.size;

  // Step 5: need_message across all jobs
  const toMessage = [];
  await Promise.all([...byPerson.values()].map(async (c) => {
    try {
      const events = await loxo.personEvents(c.personId);
      if (!events.complete) throw new Error('incomplete event history');
      if (logic.needMessage(events.items)) toMessage.push(c);
    } catch (err) {
      stats.failures++;
      console.error(`Person ${c.personId} skipped: ${err.message}`);
    }
  }));
  stats.needMessage = toMessage.length;

  // Step 6: final list
  const final = toMessage.sort((a, b) => a.personId - b.personId).slice(0, MAX_PER_RUN);
  stats.final = final.length;
  console.table(final.map(({ personId, name, city, phone, jobId }) => ({ personId, name, city, phone, jobId })));

  // Step 7 + 8: send one at a time, then log back to Loxo
  for (const c of final) {
    if (DRY_RUN) {
      console.log(`[dry-run] would send ${respondio.TEMPLATE_NAME} to ${c.phone} (person ${c.personId}): ` +
        `{{1}}="${c.name}" {{2}}="${respondio.SENDER_NAME}" {{3}}="${c.city}"`);
      continue;
    }
    if (stats.sent > 0) await loxo.sleep(DELAY_SEC * 1000);
    let result;
    try {
      result = await respondio.sendOutreach(c);
    } catch (err) {
      stats.failures++;
      console.error(`Send failed for person ${c.personId}: ${err.message} ` +
        '(if the outreach tag was already added, this phone will not be retried; remove the tag in respond.io to retry)');
      continue;
    }
    if (result === 'skipped') {
      stats.alreadyTagged++;
      console.log(`Skipped person ${c.personId}: already has the outreach tag in respond.io`);
      continue;
    }
    stats.sent++;
    console.log(`Sent to person ${c.personId}`);
    await logToLoxo(c, stats);
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log('\nSummary');
  console.log(`  jobs checked:        ${stats.jobs}`);
  console.log(`  candidates in stage: ${stats.inStage}`);
  console.log(`  dormant:             ${stats.dormant}`);
  console.log(`  stored in sheet:     ${process.env.GOOGLE_SHEET_ID ? stats.stored : 'not configured'}`);
  console.log(`  with phone:          ${stats.withPhone}`);
  console.log(`  need_message:        ${stats.needMessage}`);
  console.log(`  final list:          ${stats.final}`);
  console.log(`  already tagged:      ${stats.alreadyTagged}`);
  console.log(`  sent:                ${DRY_RUN ? '0 (dry run)' : stats.sent}`);
  console.log(`  failures:            ${stats.failures}`);
  console.log(`  elapsed:             ${elapsed}s`);
  return stats;
}

async function logToLoxo(c, stats) {
  const notes = `<p>${logic.messageText(c.name, c.city)}</p>`;
  for (let attempt = 1; attempt <= LOG_RETRIES; attempt++) {
    try {
      await loxo.logPersonEvent(c.personId, c.jobId, logic.SENT_TYPE_ID, notes);
      return;
    } catch (err) {
      console.error(`Loxo log attempt ${attempt} failed for person ${c.personId}: ${err.message}`);
      if (attempt < LOG_RETRIES) await loxo.sleep(2000 * attempt);
    }
  }
  // Sent but not logged: remember locally so this person is never messaged again.
  state.addSent(c.personId);
  stats.failures++;
  console.error(`Person ${c.personId} written to the sent log`);
}

if (process.argv.includes('--schedule')) {
  const cron = require('node-cron');
  cron.schedule('0 9 * * *', () => run().catch((err) => console.error(`Run failed: ${err.message}`)), { timezone: 'Asia/Dubai' });
  console.log('Scheduled daily at 09:00 Asia/Dubai');
} else {
  run().then(
    () => process.exit(0),
    (err) => { console.error(`Run failed: ${err.message}`); process.exit(1); },
  );
}
