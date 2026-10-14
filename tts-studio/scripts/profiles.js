#!/usr/bin/env node
// Profile housekeeping from the machine that runs the dashboard:
//   npm run profiles -- list
//   npm run profiles -- reset-pin <name>     removes a PIN you forgot (the Owner's too)
// Whoever can run this can read the data folder anyway, so it needs no PIN.
import { loadConfig } from '../server/config.js';
import { createStore } from '../server/db.js';
import { createProfiles } from '../server/profiles.js';

const [command, ...rest] = process.argv.slice(2);
const cfg = loadConfig();
const store = createStore(cfg.dataDir);
const profiles = createProfiles({ db: store.db, dataDir: cfg.dataDir, getMax: () => cfg.maxProfiles });

function finish(code = 0) {
  store.close();
  process.exit(code);
}

if (command === 'list') {
  for (const p of profiles.list()) console.log(`${p.isOwner ? '* ' : '  '}${p.name}${p.locked ? '   (PIN set)' : ''}`);
  console.log('\n* is the Owner.');
} else if (command === 'reset-pin' && rest.length) {
  const name = rest.join(' ').trim().toLowerCase();
  const found = profiles.list().find((p) => p.name.toLowerCase() === name);
  if (!found) {
    console.error(`No profile called “${rest.join(' ')}”. Try: npm run profiles -- list`);
    finish(1);
  }
  profiles.clearPin(found.id);
  profiles.closeSessionsOf(found.id);
  console.log(`Removed the PIN of ${found.name} and signed it out everywhere. Set a new one from Manage profile.`);
} else {
  console.error('Usage: npm run profiles -- list\n       npm run profiles -- reset-pin <name>');
  finish(command ? 1 : 0);
}
finish();
