import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { qrLink } from './qr.js';

const png = (file: string) => ({
  mimeType: 'image/png' as const,
  data: readFileSync(new URL(file, import.meta.url)).toString('base64'),
});

describe('qrLink', () => {
  it('reads the link out of a login page screenshot', () => {
    expect(qrLink(png('./fixtures/itsme-qr.png'))).toBe(
      'https://idp.prd.itsme.services/spa/scan?itsme_flow_type=w2aoqrc&flow_code=a066a0a51d1242489a7db5836f7bca6e',
    );
  });

  it('is undefined without a QR code, or for other formats', () => {
    expect(qrLink(png('./fixtures/plain.png'))).toBeUndefined();
    expect(qrLink({ mimeType: 'image/jpeg', data: 'AAAA' })).toBeUndefined();
  });
});
