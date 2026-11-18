// Local safety log: people who were messaged but could not be logged in Loxo.
const fs = require('fs');
const path = require('path');

// On Cloud Run point SENT_LOG_FILE at a mounted bucket, since the container disk is wiped after each run.
const FILE = path.resolve(__dirname, '..', process.env.SENT_LOG_FILE || 'sent.json');

function loadSent() {
  try {
    return new Set(JSON.parse(fs.readFileSync(FILE, 'utf8')));
  } catch (err) {
    if (err.code === 'ENOENT') return new Set();
    throw err; // a corrupt file must stop the run, never be ignored
  }
}

function addSent(personId) {
  const sent = loadSent();
  sent.add(personId);
  fs.writeFileSync(FILE, JSON.stringify([...sent], null, 2));
}

module.exports = { loadSent, addSent };
