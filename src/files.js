import fs from 'node:fs';
import path from 'node:path';
import { userPaths } from './store.js';

export const RUN_ID = /^[A-Za-z0-9_-]{8,64}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function rm(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

export function runDir(dataDir, user, runId) {
  if (!RUN_ID.test(runId)) throw new Error('invalid run id');
  return path.join(userPaths(dataDir, user).tmp, runId);
}

export function removeRunDir(dataDir, user, runId) {
  if (typeof runId === 'string' && RUN_ID.test(runId)) rm(runDir(dataDir, user, runId));
}

export function transcriptPath(dataDir, user, conversationId) {
  if (!UUID.test(conversationId)) throw new Error('invalid conversation id');
  return path.join(userPaths(dataDir, user).transcripts, `${conversationId}.txt`);
}

export function removeTranscript(dataDir, user, conversationId) {
  if (UUID.test(conversationId)) rm(transcriptPath(dataDir, user, conversationId));
}

// Everything the app wrote for one user except the database file itself: temp photos and transcripts.
export function removeUserFiles(dataDir, user) {
  const p = userPaths(dataDir, user);
  for (const d of [p.tmp, p.transcripts]) {
    if (!fs.existsSync(d)) continue;
    for (const name of fs.readdirSync(d)) rm(path.join(d, name));
  }
}
