import type { QRCode } from 'jsqr';
import jsqr from 'jsqr';
import { PNG } from 'pngjs';

type Decode = (data: Uint8ClampedArray, width: number, height: number) => QRCode | null;
// jsqr is CommonJS with a default export: under NodeNext the function sits on .default.
const jsQR: Decode = ((jsqr as unknown as { default?: Decode }).default ??
  jsqr) as unknown as Decode;

/**
 * The link a QR code in a screenshot points to, when it has one. Login QR codes (itsme) are
 * plain https links: a user on the phone that has the app cannot scan a picture shown on
 * that same phone, but can tap the link, which opens the app directly.
 */
export function qrLink(image: { data: string; mimeType: string }): string | undefined {
  if (image.mimeType !== 'image/png') return undefined;
  try {
    const png = PNG.sync.read(Buffer.from(image.data, 'base64'));
    const code = jsQR(
      new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length),
      png.width,
      png.height,
    );
    const text = code?.data.trim();
    return text && /^https:\/\/\S+$/.test(text) ? text : undefined;
  } catch {
    return undefined;
  }
}
