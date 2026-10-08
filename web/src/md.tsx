// 极简 Markdown 渲染：先全转义，再只放行白名单内联/块级标签。永不输出原始 HTML。
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inline(s: string): string {
  let o = esc(s);
  o = o.replace(/`([^`]+)`/g, '<code>$1</code>');
  o = o.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  o = o.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  o = o.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return o;
}

export function renderMarkdown(src: string): string {
  const lines = src.split('\n');
  const html: string[] = [];
  let inCode = false;
  let inList = false;
  for (const raw of lines) {
    if (/^```/.test(raw)) {
      html.push(inCode ? '</code></pre>' : '<pre><code>');
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      html.push(`${esc(raw)}\n`);
      continue;
    }
    const h = raw.match(/^(#{1,3})\s+(.*)$/);
    if (h !== null) {
      if (inList) {
        html.push('</ul>');
        inList = false;
      }
      html.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      continue;
    }
    const li = raw.match(/^\s*[-*]\s+(.*)$/);
    if (li !== null) {
      if (!inList) {
        html.push('<ul>');
        inList = true;
      }
      html.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (inList) {
      html.push('</ul>');
      inList = false;
    }
    if (raw.trim() === '') continue;
    html.push(`<p>${inline(raw)}</p>`);
  }
  if (inList) html.push('</ul>');
  if (inCode) html.push('</code></pre>');
  return html.join('\n');
}

export function MarkdownView(props: { text: string }) {
  return <div innerHTML={renderMarkdown(props.text)} />;
}
