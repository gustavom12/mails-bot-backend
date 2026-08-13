/** Quita etiquetas HTML para validar longitud / buscar texto. */
export function stripHtml(html: string): string {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export function htmlHasContent(html: string, minPlainChars = 1): boolean {
  if (!html) return false;
  if (/<img\b/i.test(html)) return true;
  return stripHtml(html).length >= minPlainChars;
}
