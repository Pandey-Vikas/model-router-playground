const buffer = [];
const listeners = new Set();
const MAX = 100;
let nextId = 1;

export function pushLog(entry) {
  const record = { id: nextId++, ts: new Date().toISOString(), ...entry };
  buffer.push(record);
  if (buffer.length > MAX) buffer.shift();
  for (const listener of listeners) {
    try { listener(record); } catch { /* ignore */ }
  }
  return record;
}

export function getRecentLogs() {
  return buffer.slice();
}

export function subscribeLogs(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}
