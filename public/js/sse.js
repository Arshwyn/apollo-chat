// Incremental parser for a text/event-stream body read in arbitrary chunks.
export class SseParser {
  constructor() {
    this.buf = '';
  }

  push(chunk) {
    this.buf += chunk;
    const out = [];
    let i;
    while ((i = this.buf.indexOf('\n\n')) >= 0) {
      const block = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      let event = 'message';
      const data = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length === 0) continue;
      try {
        out.push({ event, data: JSON.parse(data.join('\n')) });
      } catch {
        /* ignore malformed block */
      }
    }
    return out;
  }
}
