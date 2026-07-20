/**
 * Vertex CRM — WhatsApp Chat Export Parser (GAP-05)
 *
 * Parses the .txt files produced by WhatsApp's official, user-facing
 * "Export chat" feature (chat → contact name → Export chat). This is the
 * safe migration path for tenants moving from other CRMs: their history
 * comes WITH them, into a database they control.
 *
 * The format is UNOFFICIAL and locale-dependent. Handled variants:
 *   [12/03/2025, 14:23:45] Ana García: message        (bracketed, iOS style)
 *   12/3/25, 2:23 PM - Ana García: message            (dash, Android/US)
 *   03.12.2025, 14:23 - Ana: message                  (dot dates, EU)
 *   3/12/2025, 14:23 - Ana: multi
 *   line continues                                     (multiline folding)
 *   <Media omitted> / <Se omitió multimedia>          (media placeholders)
 *   IMG-2025.jpg (file attached)                       (attached-media exports)
 *   System lines without "Name: " (encryption notice,  (classified as system,
 *   "You created group ...", missed calls)              excluded from turns)
 *
 * Date ambiguity (12/03 = Dec 3 or 12 Mar?) is resolved per-file: if any
 * line's first component exceeds 12, the file is day-first; otherwise we
 * fall back to the caller-provided hint (default: day-first, since the
 * initial market is Costa Rica / LatAm).
 *
 * File location: services/crm-service/src/services/whatsapp-import.parser.ts
 */

export interface ParsedMessage {
  timestamp: Date;
  sender: string;          // saved contact name or phone as it appears in the export
  content: string;
  isMedia: boolean;        // <Media omitted> or "(file attached)"
  mediaFilename?: string;  // when the export included media files
}

export interface ParseResult {
  messages: ParsedMessage[];
  participants: string[];      // distinct senders, in order of first appearance
  systemLines: number;         // excluded non-message lines (encryption notice etc.)
  unparsedLines: number;       // lines we could not classify (quarantined, not silently dropped)
  dateOrder: 'DMY' | 'MDY';
  firstMessageAt: Date | null;
  lastMessageAt: Date | null;
}

// Header shapes:  "[date, time] " (iOS)  or  "date, time - " (Android)
const HEADER_RE =
  /^(?:\[(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?[Mm]\.?)?\]\s?|(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?[Mm]\.?)?\s+-\s+)/;

const MEDIA_PLACEHOLDERS = [
  '<Media omitted>', '<Se omitió multimedia>', '<Multimedia omitido>',
  '<Médias omis>', '<Mídia omitida>', '\u200e<Media omitted>',
];
const ATTACHED_RE = /^(?:\u200e)?(.+?\.(?:jpg|jpeg|png|webp|mp4|3gp|opus|ogg|mp3|m4a|pdf|docx?|xlsx?))\s+\(file attached\)/i;

interface RawLine {
  d1: number; d2: number; year: number;
  hour: number; minute: number; second: number;
  ampm: string | null;
  rest: string;
}

function matchHeader(line: string): RawLine | null {
  // Strip WhatsApp's LTR/RTL invisible marks that prefix many lines
  const clean = line.replace(/^[\u200e\u200f\ufeff]+/, '');
  const m = HEADER_RE.exec(clean);
  if (!m) return null;
  const g = m[1] !== undefined
    ? { d1: m[1], d2: m[2], y: m[3], h: m[4], min: m[5], s: m[6], ap: m[7] }
    : { d1: m[8], d2: m[9], y: m[10], h: m[11], min: m[12], s: m[13], ap: m[14] };
  return {
    d1: Number(g.d1), d2: Number(g.d2),
    year: Number(g.y.length === 2 ? `20${g.y}` : g.y),
    hour: Number(g.h), minute: Number(g.min), second: g.s ? Number(g.s) : 0,
    ampm: g.ap ? g.ap.toUpperCase().replace(/\./g, '') : null,
    rest: clean.slice(m[0].length),
  };
}

function toDate(r: RawLine, order: 'DMY' | 'MDY'): Date {
  const day = order === 'DMY' ? r.d1 : r.d2;
  const month = order === 'DMY' ? r.d2 : r.d1;
  let hour = r.hour;
  if (r.ampm === 'PM' && hour < 12) hour += 12;
  if (r.ampm === 'AM' && hour === 12) hour = 0;
  return new Date(Date.UTC(r.year, month - 1, day, hour, r.minute, r.second));
}

/**
 * Parse one exported chat. `dateOrderHint` is used only when the file itself
 * is ambiguous (no component > 12 anywhere).
 */
export function parseWhatsAppExport(
  text: string,
  dateOrderHint: 'DMY' | 'MDY' = 'DMY'
): ParseResult {
  const lines = text.split(/\r?\n/);

  // Pass 1: collect raw headed lines to resolve date order for the whole file
  const raws: Array<{ raw: RawLine; index: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const r = matchHeader(lines[i]);
    if (r) raws.push({ raw: r, index: i });
  }
  let dateOrder: 'DMY' | 'MDY' | null = null;
  for (const { raw } of raws) {
    if (raw.d1 > 12) { dateOrder = 'DMY'; break; }
    if (raw.d2 > 12) { dateOrder = 'MDY'; break; }
  }
  dateOrder = dateOrder ?? dateOrderHint;

  // Pass 2: build messages with multiline folding
  const messages: ParsedMessage[] = [];
  const participants: string[] = [];
  let systemLines = 0;
  let unparsedLines = 0;
  let current: ParsedMessage | null = null;

  for (const line of lines) {
    const r = matchHeader(line);
    if (r) {
      if (current) messages.push(current);
      current = null;

      // "Sender: content" — a colon after a name distinguishes messages
      // from system lines ("Messages are end-to-end encrypted", calls, etc.)
      const sep = r.rest.indexOf(': ');
      if (sep === -1) {
        systemLines++;
        continue;
      }
      const sender = r.rest.slice(0, sep).trim();
      let content = r.rest.slice(sep + 2);

      let isMedia = false;
      let mediaFilename: string | undefined;
      const cleanContent = content.replace(/^[\u200e\u200f]+/, '').trim();
      if (MEDIA_PLACEHOLDERS.some((ph) => cleanContent === ph.replace(/^\u200e/, ''))) {
        isMedia = true;
        content = '[media not included in export]';
      } else {
        const att = ATTACHED_RE.exec(cleanContent);
        if (att) {
          isMedia = true;
          mediaFilename = att[1];
          content = `[attachment: ${att[1]}]`;
        }
      }

      if (!participants.includes(sender)) participants.push(sender);
      current = { timestamp: toDate(r, dateOrder), sender, content, isMedia, mediaFilename };
    } else if (current && line.length > 0) {
      // Continuation of a multiline message
      current.content += '\n' + line;
    } else if (line.trim().length > 0) {
      unparsedLines++;
    }
  }
  if (current) messages.push(current);

  return {
    messages,
    participants,
    systemLines,
    unparsedLines,
    dateOrder,
    firstMessageAt: messages.length ? messages[0].timestamp : null,
    lastMessageAt: messages.length ? messages[messages.length - 1].timestamp : null,
  };
}
