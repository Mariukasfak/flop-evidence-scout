/**
 * The last lines of a file, read without loading all of it.
 *
 * The audit log is 170 MB and grows every minute. Anything that answers "what
 * happened lately" by reading the whole file gets slower the longer the agent
 * has been healthy, which is exactly backwards — and the dashboard did it once a
 * cycle. When the read starts mid-file the first line is a fragment, so it is
 * dropped rather than handed on as a record.
 */
import fs from 'node:fs';

export function tailLines(file, bytes = 400_000) {
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - bytes);
  const buf = Buffer.alloc(size - start);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buf, 0, buf.length, start);
  } finally {
    fs.closeSync(fd);
  }
  const lines = buf.toString('utf8').split('\n');
  if (start > 0) lines.shift();
  return lines.filter(Boolean);
}
