// The sRGB ICC profile Vellum embeds as the output intent of a PDF/A file (optimize/pdfa.js).
//
// PDF/A requires the file to carry the colour profile its device-dependent colours (DeviceRGB,
// DeviceGray) are to be read against, embedded in the file itself. Vellum ships no profile and
// downloads none, so it builds one: a real ICC v2.1 matrix/TRC display profile for sRGB, written here
// from the numbers the sRGB specification gives —
//
//   primaries   the sRGB red, green and blue in the PCS, Bradford-adapted to D50, as every sRGB ICC
//               profile stores them
//   white point D50, the PCS illuminant an ICC display profile is stored against
//   tone curve   sRGB's own transfer function (the linear segment below 0.04045, then the 2.4 power
//               of the offset value), sampled into a 1024-point `curv` table — the exact curve, not a
//               plain gamma standing in for it
//
// The same bytes come out every time: nothing here reads a clock, a random number or a system setting.
// It is a profile, not a claim about one: `readIccHeader` reads back what a PDF/A validator reads —
// the size, version, device class and colour space — and the PDF/A check uses it on whatever profile
// the written file actually carries, Vellum's or the document's own.

const SIGNATURE = (text) => Uint8Array.from(text, (c) => c.charCodeAt(0));

/** s15Fixed16Number: the ICC fixed-point number the XYZ and white point tags are stored in. */
const fixed16 = (value) => Math.round(value * 65536);

/** sRGB's red, green and blue in the PCS, adapted to D50 (IEC 61966-2.1 through the Bradford matrix). */
const PRIMARIES = {
  r: [0.4360657, 0.2224932, 0.0139089],
  g: [0.3851515, 0.7168870, 0.0970900],
  b: [0.1430784, 0.0606198, 0.7141013],
};
/** D50, the ICC profile connection space illuminant. */
const D50 = [0.9642029, 1.0, 0.8249054];

const DESCRIPTION = 'sRGB IEC61966-2.1 (built by Vellum)';
const COPYRIGHT = 'Public domain. Built from the sRGB specification; no profile is shipped or downloaded.';

/** sRGB's transfer function: an encoded value 0..1 to its linear light value. */
function srgbToLinear(u) {
  return u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4;
}

let cached = null;

/** The profile's bytes. Built once; the same bytes every time. */
export function srgbIccProfile() {
  return (cached ??= build());
}

function build() {
  const tags = [];
  const add = (signature, data) => tags.push({ signature, data });

  add('desc', textDescription(DESCRIPTION));
  add('wtpt', xyzTag([D50]));
  add('rXYZ', xyzTag([PRIMARIES.r]));
  add('gXYZ', xyzTag([PRIMARIES.g]));
  add('bXYZ', xyzTag([PRIMARIES.b]));
  const trc = toneCurve(1024);
  // One curve, named by all three channels: the tag table may point several tags at the same data.
  add('rTRC', trc);
  add('gTRC', trc);
  add('bTRC', trc);
  add('cprt', text(COPYRIGHT));

  // Lay the tag data out after the header and the tag table, each tag 4-byte aligned.
  const tableSize = 4 + tags.length * 12;
  const placed = [];
  const seen = new Map(); // identical data (the shared tone curve) is stored once
  let offset = 128 + tableSize;
  for (const tag of tags) {
    let at = seen.get(tag.data);
    if (at === undefined) {
      at = offset;
      seen.set(tag.data, at);
      offset += tag.data.length + ((4 - (tag.data.length % 4)) % 4);
    }
    placed.push({ ...tag, offset: at });
  }
  const size = offset;

  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  writeHeader(out, view, size);
  view.setUint32(128, tags.length);
  placed.forEach((tag, i) => {
    const at = 132 + i * 12;
    out.set(SIGNATURE(tag.signature), at);
    view.setUint32(at + 4, tag.offset);
    view.setUint32(at + 8, tag.data.length);
  });
  for (const [data, at] of seen) out.set(data, at);
  return out;
}

function writeHeader(out, view, size) {
  view.setUint32(0, size);                        // profile size
  out.set(SIGNATURE('VLLM'), 4);                  // preferred CMM
  view.setUint32(8, 0x02100000);                  // version 2.1.0
  out.set(SIGNATURE('mntr'), 12);                 // device class: display
  out.set(SIGNATURE('RGB '), 16);                 // data colour space
  out.set(SIGNATURE('XYZ '), 20);                 // profile connection space
  // A fixed creation date, so the profile (and the PDF/A file carrying it) is the same every time.
  [2026, 1, 1, 0, 0, 0].forEach((n, i) => view.setUint16(24 + i * 2, n));
  out.set(SIGNATURE('acsp'), 36);                 // profile file signature
  out.set(SIGNATURE('MSFT'), 40);                 // primary platform
  // 44 flags, 48 manufacturer, 52 model, 56 attributes: all zero (not embedded-only, no restrictions)
  view.setUint32(64, 0);                          // rendering intent: perceptual
  D50.forEach((n, i) => view.setInt32(68 + i * 4, fixed16(n)));
  out.set(SIGNATURE('VLLM'), 80);                 // profile creator
  // 84 profile id (16 bytes) and 100 reserved (28 bytes): zero
}

/** XYZType: one or more XYZ numbers. */
function xyzTag(values) {
  const out = new Uint8Array(8 + values.length * 12);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE('XYZ '), 0);
  values.forEach((xyz, i) => xyz.forEach((n, k) => view.setInt32(8 + i * 12 + k * 4, fixed16(n))));
  return out;
}

/** curveType: `count` samples of sRGB's transfer function, as 16-bit values. */
function toneCurve(count) {
  const out = new Uint8Array(12 + count * 2);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE('curv'), 0);
  view.setUint32(8, count);
  for (let i = 0; i < count; i++) {
    view.setUint16(12 + i * 2, Math.round(srgbToLinear(i / (count - 1)) * 65535));
  }
  return out;
}

/** textType: a 7-bit ASCII string, NUL-terminated. */
function text(value) {
  const ascii = [...value].map((c) => (c.codePointAt(0) < 128 ? c.charCodeAt(0) : 0x3f));
  const out = new Uint8Array(8 + ascii.length + 1);
  out.set(SIGNATURE('text'), 0);
  out.set(ascii, 8);
  return out;
}

/** textDescriptionType: the ASCII description, with the Unicode and ScriptCode parts left empty. */
function textDescription(value) {
  const ascii = [...value].map((c) => (c.codePointAt(0) < 128 ? c.charCodeAt(0) : 0x3f));
  const count = ascii.length + 1;
  const out = new Uint8Array(12 + count + 8 + 3 + 67);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE('desc'), 0);
  view.setUint32(8, count);
  out.set(ascii, 12);
  return out;
}

/**
 * What a PDF/A check reads out of an ICC profile: its own recorded size, version, device class and
 * colour space, or null when the bytes are not a profile at all. Reads; never repairs.
 */
export function readIccHeader(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 132) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = (offset) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (at(36) !== 'acsp') return null;
  return {
    size: view.getUint32(0),
    version: view.getUint32(8),
    deviceClass: at(12),
    colorSpace: at(16),
    connectionSpace: at(20),
    tagCount: view.getUint32(128),
  };
}

/** How many components a profile's colour space has, for the /N the PDF stream must carry. */
export const ICC_COMPONENTS = Object.freeze({ 'GRAY': 1, 'RGB ': 3, 'CMYK': 4, 'Lab ': 3 });
