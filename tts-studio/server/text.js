/** Strip markdown and tidy whitespace so the text reads naturally when spoken. */
export function cleanText(text, { stripMarkdown = true } = {}) {
  let t = String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');
  if (stripMarkdown) {
    t = t
      .replace(/```[\s\S]*?```/g, '') // fenced code blocks
      .replace(/`([^`]*)`/g, '$1') // inline code
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
      // links -> link text, except Kokoro pronunciation hints like [word](/fəˈnɛtɪks/)
      .replace(/\[([^\]]+)\]\((?!\/[^)]*\/\))[^)]*\)/g, '$1')
      .replace(/^#{1,6}[ \t]*/gm, '') // heading markers
      .replace(/^[ \t]*[-*+][ \t]+/gm, '') // bullet markers (never eats the blank line before a list)
      .replace(/(\*{1,3})([^*\n]+)\1/g, '$2') // *italic* **bold**
      .replace(/(?<!\w)(_{1,3})([^_\n]+)\1(?!\w)/g, '$2'); // _italic_ (leaves snake_case alone)
  }
  return t
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function slugify(s, fallback = 'audio') {
  const slug = String(s ?? '')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 60);
  return slug || fallback;
}
