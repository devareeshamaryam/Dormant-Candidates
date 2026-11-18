// Writes the run's list to a Google Sheet using a service account (no extra dependencies).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const HEADER = ['Candidate Id', 'Person Id', 'Name'];

async function accessToken(keyFile) {
  const key = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), key.private_key).toString('base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
  });
  if (!res.ok) throw new Error(`Google auth -> HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).access_token;
}

async function sheetsCall(token, method, path, body) {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${process.env.GOOGLE_SHEET_ID}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Google Sheets -> HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

// Replaces the tab's contents with the current list, so the sheet always shows the latest run.
async function writeList(list) {
  const token = await accessToken(path.resolve(__dirname, '..', process.env.GOOGLE_SERVICE_ACCOUNT_FILE || 'service-account.json'));
  const tab = process.env.GOOGLE_SHEET_TAB || 'Sheet1';
  const values = [HEADER, ...list.map((c) => [c.candidateId, c.personId, c.name])];
  await sheetsCall(token, 'POST', `/values/${encodeURIComponent(`${tab}!A:H`)}:clear`, {});
  await sheetsCall(token, 'PUT', `/values/${encodeURIComponent(`${tab}!A1`)}?valueInputOption=RAW`, { values });
}

module.exports = { writeList };
