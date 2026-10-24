export class UnsupportedFormatError extends Error {}

export function parseSubscription(input, schemes) {
  const text = input.replace(/^\uFEFF/, '').trim();
  if (!text) return [];
  let decoded = text;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    const compact = text.replace(/\s/g, '');
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact) || compact.length % 4 === 1) {
      throw new UnsupportedFormatError('Expected URI lines or a Base64 subscription');
    }
    const normalized = compact.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Buffer.from(normalized, 'base64');
    const canonical = bytes.toString('base64');
    if (normalized !== (normalized.includes('=') ? canonical : canonical.replace(/=+$/, ''))) {
      throw new UnsupportedFormatError('Noncanonical Base64 padding or trailing bits');
    }
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
      throw new UnsupportedFormatError('Base64 content is not UTF-8 text', { cause: error });
    }
  }
  const lines = decoded.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const match = /^([a-z][a-z0-9+.-]*):\/\/(\S+)$/i.exec(line);
    if (!match || !schemes.includes(match[1].toLowerCase()) || /[\x00-\x20\x7f]/.test(line)) {
      throw new UnsupportedFormatError('Unrecognized URI scheme or malformed subscription line');
    }
  }
  if (!lines.length) throw new UnsupportedFormatError('Decoded content has no URI entries');
  return lines;
}
