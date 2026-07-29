import { Fragment } from 'react';

// Tiny, dependency-free markdown renderer for LLM answers/notes. Renders only a
// safe subset (headings, bullet/numbered lists, bold/italic/code inline) as
// React elements — never HTML strings — so there is no XSS surface. Anything it
// doesn't recognize is shown as plain text.
function renderInline(text, keyPrefix) {
  // Split on **bold**, *italic*, and `code` while keeping the delimiters.
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g).filter(Boolean);
  return parts.map((p, i) => {
    const key = `${keyPrefix}-${i}`;
    if (p.startsWith('**') && p.endsWith('**')) return <strong key={key}>{p.slice(2, -2)}</strong>;
    if (p.startsWith('*') && p.endsWith('*')) return <em key={key}>{p.slice(1, -1)}</em>;
    if (p.startsWith('`') && p.endsWith('`')) return <code key={key} className="px-1 py-0.5 rounded bg-surface-3 text-[0.85em]">{p.slice(1, -1)}</code>;
    return <Fragment key={key}>{p}</Fragment>;
  });
}

export default function Markdown({ text, className = '' }) {
  const src = String(text ?? '');
  const blocks = [];
  const lines = src.split('\n');
  let list = null; // { ordered, items: [] }

  const flush = () => {
    if (!list) return;
    const items = list.items.map((it, i) => <li key={i}>{renderInline(it, `li-${blocks.length}-${i}`)}</li>);
    blocks.push(list.ordered
      ? <ol key={`b${blocks.length}`} className="list-decimal ml-5 space-y-1">{items}</ol>
      : <ul key={`b${blocks.length}`} className="list-disc ml-5 space-y-1">{items}</ul>);
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    const numbered = /^\d+\.\s+(.*)$/.exec(line);
    if (h) {
      flush();
      const level = h[1].length;
      const cls = level === 1 ? 'text-base font-bold' : level === 2 ? 'text-sm font-bold' : 'text-sm font-semibold';
      blocks.push(<p key={`b${blocks.length}`} className={`${cls} mt-2`}>{renderInline(h[2], `h${blocks.length}`)}</p>);
    } else if (bullet) {
      if (!list || list.ordered) { flush(); list = { ordered: false, items: [] }; }
      list.items.push(bullet[1]);
    } else if (numbered) {
      if (!list || !list.ordered) { flush(); list = { ordered: true, items: [] }; }
      list.items.push(numbered[1]);
    } else if (line.trim() === '') {
      flush();
    } else {
      flush();
      blocks.push(<p key={`b${blocks.length}`}>{renderInline(line, `p${blocks.length}`)}</p>);
    }
  }
  flush();
  return <div className={`space-y-2 ${className}`}>{blocks}</div>;
}
