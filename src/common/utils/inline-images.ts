import * as crypto from 'crypto';

/** Imagen del cuerpo del mail, extraída como adjunto inline. */
export interface InlineImage {
  name: string;
  mimeType: string;
  /** Contenido en base64, ya sin el prefijo `data:…;base64,`. */
  content: string;
  contentId: string;
  inline: true;
}

const DATA_URI_IMAGE = /src=(["'])data:(image\/[a-z0-9.+-]+);base64,\s*([^"']+)\1/gi;

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
};

/**
 * Detecta el tipo real mirando los magic numbers del binario. El mime declarado en
 * el data URI no siempre coincide — la firma de Vida Lenta, por ejemplo, se guardó
 * como `image/png` pero los bytes son JPEG.
 */
function sniffMimeType(base64: string, declared: string): string {
  let head: Buffer;
  try {
    head = Buffer.from(base64.slice(0, 24), 'base64');
  } catch {
    return declared;
  }
  if (head.length < 4) return declared;

  const hex = head.subarray(0, 4).toString('hex');
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (hex === '89504e47') return 'image/png';
  if (hex.startsWith('47494638')) return 'image/gif';
  if (
    head.subarray(0, 4).toString('ascii') === 'RIFF' &&
    head.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return declared;
}

/**
 * Reemplaza las imágenes embebidas como data URI por referencias `cid:` y las
 * devuelve como adjuntos inline.
 *
 * Gmail y Outlook descartan las imágenes `data:` de los mails que reciben, así que
 * una firma embebida de esa forma le llega rota al destinatario. El adjunto inline
 * con Content-ID es el formato que sí renderizan.
 *
 * El HTML devuelto es el que se manda al proveedor; el que se guarda en la base
 * sigue siendo el original con el data URI, que se rinde solo en la bandeja.
 */
export function extractInlineImages(html: string): { html: string; images: InlineImage[] } {
  const images: InlineImage[] = [];
  if (!html) return { html: html ?? '', images };

  const rewritten = html.replace(
    DATA_URI_IMAGE,
    (match: string, quote: string, declared: string, data: string) => {
      const content = data.replace(/\s/g, '');
      if (!content) return match;

      const mimeType = sniffMimeType(content, declared.toLowerCase());
      const index = images.length + 1;
      const contentId = `img${index}.${crypto.randomBytes(8).toString('hex')}@mails-bot`;

      images.push({
        name: `imagen-${index}.${EXTENSIONS[mimeType] ?? 'bin'}`,
        mimeType,
        content,
        contentId,
        inline: true,
      });

      return `src=${quote}cid:${contentId}${quote}`;
    },
  );

  return { html: rewritten, images };
}
