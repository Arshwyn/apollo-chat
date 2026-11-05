// Turns the CLI's stream-json lines into a few app events. Tool inputs, tool outputs and thinking
// are dropped here on purpose: only text deltas, a generic tool label, a "blocked" flag and the final
// result ever leave this module.
const BLOCK_MARK = 'apollo-isolation';

export function toolLabel(name) {
  if (typeof name !== 'string') return 'working';
  if (name.startsWith('mcp__')) {
    const server = (name.split('__')[1] || '')
      .replace(/^claude_ai_/, '')
      .split('_-_')[0]
      .replace(/_/g, ' ');
    return server || 'a connector';
  }
  if (['Read', 'Grep', 'Glob'].includes(name)) return 'reading';
  if (['Write', 'Edit'].includes(name)) return 'writing notes';
  if (['WebSearch', 'WebFetch'].includes(name)) return 'searching the web';
  return 'working';
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join(' ');
  return '';
}

export function createStreamParser() {
  const seenTools = new Set();
  let hadText = false;
  return {
    push(line) {
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        return [];
      }
      const out = [];
      const tool = (id, name) => {
        if (id && seenTools.has(id)) return;
        if (id) seenTools.add(id);
        out.push({ kind: 'tool', name: toolLabel(name) });
      };
      if (o.type === 'stream_event' && o.event) {
        const e = o.event;
        if (e.type === 'content_block_start' && e.content_block?.type === 'text' && hadText) {
          out.push({ kind: 'delta', text: '\n\n' });
        } else if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') {
          tool(e.content_block.id, e.content_block.name);
        } else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) {
          hadText = true;
          out.push({ kind: 'delta', text: e.delta.text });
        }
      } else if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
        for (const c of o.message.content) if (c.type === 'tool_use') tool(c.id, c.name);
      } else if (o.type === 'user' && Array.isArray(o.message?.content)) {
        for (const c of o.message.content) {
          if (c.type === 'tool_result' && c.is_error && resultText(c.content).includes(BLOCK_MARK)) {
            out.push({ kind: 'blocked' });
          }
        }
      } else if (o.type === 'result') {
        out.push({
          kind: 'result',
          isError: o.is_error === true,
          text: typeof o.result === 'string' ? o.result : '',
        });
      }
      return out;
    },
  };
}
