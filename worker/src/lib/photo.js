// Validation for the selfie. The browser already crops and re-encodes the picture (which also drops camera
// metadata such as GPS), but the server never trusts that: it checks the bytes itself.

import { HttpError } from './util.js';

export const MAX_PHOTO_BYTES = 60_000;
const MIN_SIDE = 96;
const MAX_SIDE = 640;

// Accepts "data:image/jpeg;base64,...." or bare base64. Returns { b64, bytes, width, height } or throws a 400.
export function checkPhoto(input) {
  const bad = (code, msg) => new HttpError(400, code, msg);
  if (typeof input !== 'string' || !input) throw bad('invalid_photo', 'Send the photo as a JPEG.');
  const b64 = input.replace(/^data:image\/jpeg;base64,/i, '');
  if (b64.length > Math.ceil((MAX_PHOTO_BYTES * 4) / 3) + 8) throw bad('photo_too_large', 'That photo is too large. Try again.');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw bad('invalid_photo', 'That is not a valid photo.');
  let bin;
  try {
    bin = atob(b64);
  } catch {
    throw bad('invalid_photo', 'That is not a valid photo.');
  }
  const n = bin.length;
  if (n > MAX_PHOTO_BYTES) throw bad('photo_too_large', 'That photo is too large. Try again.');
  const at = (i) => bin.charCodeAt(i);
  if (n < 4 || at(0) !== 0xff || at(1) !== 0xd8 || at(2) !== 0xff) throw bad('invalid_photo', 'The photo must be a JPEG.');

  let i = 2;
  let width = 0;
  let height = 0;
  while (i + 3 < n) {
    if (at(i) !== 0xff) throw bad('invalid_photo', 'That is not a valid photo.');
    while (i < n && at(i) === 0xff) i++; // fill bytes
    const m = at(i++);
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue; // markers with no length
    if (m === 0xd9) break;
    const len = (at(i) << 8) | at(i + 1);
    if (len < 2 || i + len > n) throw bad('invalid_photo', 'That is not a valid photo.');
    // EXIF/XMP (0xE1), Photoshop (0xED) and comments (0xFE) can carry location and other personal data.
    if (m === 0xe1 || m === 0xed || m === 0xfe) throw bad('photo_has_metadata', 'The photo carries hidden data. Take it again in the app.');
    const isSof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
    if (isSof) {
      if (at(i + 2) !== 8) throw bad('invalid_photo', 'That is not a valid photo.');
      height = (at(i + 3) << 8) | at(i + 4);
      width = (at(i + 5) << 8) | at(i + 6);
      break;
    }
    if (m === 0xda) break;
    i += len;
  }
  if (!width || !height) throw bad('invalid_photo', 'That is not a valid photo.');
  if (width < MIN_SIDE || height < MIN_SIDE || width > MAX_SIDE || height > MAX_SIDE) {
    throw bad('photo_size', `The photo must be between ${MIN_SIDE} and ${MAX_SIDE} pixels each way.`);
  }
  return { b64, bytes: n, width, height };
}

export const photoDataUrl = (b64) => 'data:image/jpeg;base64,' + b64;
// A photo changed in the last day is worth a second look at the door.
export const NEW_PHOTO_SECS = 24 * 3600;
