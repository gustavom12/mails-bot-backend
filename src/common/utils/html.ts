/** Quita etiquetas HTML para validar longitud / buscar texto. */
export function stripHtml(html: string): string {
  if (!html) return '';
  return html
    .replace(/<(style|script|head)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (m, code: string) => safeCodePoint(Number(code), m))
    .replace(/&#x([0-9a-f]+);/gi, (m, hex: string) => safeCodePoint(parseInt(hex, 16), m))
    .replace(/&([a-z]+)(acute|grave|circ|tilde|uml);/gi, (m, letter: string) => {
      const map: Record<string, string> = {
        aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
        Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
        ntilde: 'ñ', Ntilde: 'Ñ', uuml: 'ü', Uuml: 'Ü',
      };
      return map[m.slice(1, -1)] ?? m;
    })
    .replace(/&iquest;/g, '¿')
    .replace(/&iexcl;/g, '¡')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeCodePoint(code: number, fallback: string): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff
    ? String.fromCodePoint(code)
    : fallback;
}

export function htmlHasContent(html: string, minPlainChars = 1): boolean {
  if (!html) return false;
  if (/<img\b/i.test(html)) return true;
  return stripHtml(html).length >= minPlainChars;
}
