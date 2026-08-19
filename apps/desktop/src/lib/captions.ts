const TERMINATOR_PATTERN = /([。！？；!?;])/;

export const MAX_CAPTION_CHARS = 42;

export function splitCaption(text: string, maxChars = MAX_CAPTION_CHARS): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const pieces = normalized.split(TERMINATOR_PATTERN);
  const sentences: string[] = [];
  for (let index = 0; index < pieces.length; index += 2) {
    const body = pieces[index] ?? '';
    const terminator = pieces[index + 1] ?? '';
    if (`${body}${terminator}`.trim()) sentences.push(`${body}${terminator}`.trim());
  }
  const chunks: string[] = [];
  for (const sentence of sentences) {
    let remaining = sentence;
    while (remaining.length > maxChars) {
      const candidate = remaining.slice(0, maxChars);
      const breakAt = Math.max(candidate.lastIndexOf('，'), candidate.lastIndexOf('、'), candidate.lastIndexOf(' '));
      const cut = breakAt >= Math.floor(maxChars * 0.55) ? breakAt + 1 : maxChars;
      chunks.push(remaining.slice(0, cut).trim());
      remaining = remaining.slice(cut).trim();
    }
    if (remaining) chunks.push(remaining);
  }
  return chunks;
}
