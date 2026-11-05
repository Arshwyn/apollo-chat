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

// Generic category for a blocked call, never a path or a tool input.
export function blockCategory(toolName) {
  if (typeof toolName !== 'string') return 'tool access';
  if (toolName.startsWith('mcp__')) return 'connector access';
  if (['Read', 'Write', 'Edit', 'Grep', 'Glob', 'NotebookEdit'].includes(toolName)) return 'file access';
  if (['Bash', 'BashOutput', 'KillShell'].includes(toolName)) return 'command access';
  return 'tool access';
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join(' ');
  return '';
}

export function createStreamParser() {
  const seenTools = new Set();
  const toolNames = new Map();
  let hadText = false;
  // Text since the last tool call. A tool call turns it into interim narration (event `interim`), so
  // the consumer keeps only the text that follows the last tool call as the final answer.
  let current = '';
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
        if (id && typeof name === 'string') toolNames.set(id, name);
        if (id && seenTools.has(id)) return;
        if (id) seenTools.add(id);
        if (current.trim()) out.push({ kind: 'interim', text: current });
        current = '';
        hadText = false;
        out.push({ kind: 'tool', name: toolLabel(name) });
      };
      if (o.type === 'stream_event' && o.event) {
        const e = o.event;
        if (e.type === 'content_block_start' && e.content_block?.type === 'text' && hadText) {
          current += '\n\n';
          out.push({ kind: 'delta', text: '\n\n' });
        } else if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') {
          tool(e.content_block.id, e.content_block.name);
        } else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) {
          hadText = true;
          current += e.delta.text;
          out.push({ kind: 'delta', text: e.delta.text });
        }
      } else if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
        for (const c of o.message.content) if (c.type === 'tool_use') tool(c.id, c.name);
      } else if (o.type === 'user' && Array.isArray(o.message?.content)) {
        for (const c of o.message.content) {
          if (c.type === 'tool_result' && c.is_error && resultText(c.content).includes(BLOCK_MARK)) {
            out.push({
              kind: 'blocked',
              category: toolNames.has(c.tool_use_id) ? blockCategory(toolNames.get(c.tool_use_id)) : null,
            });
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
