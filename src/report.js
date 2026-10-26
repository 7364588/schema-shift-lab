import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

/** A self-contained, read-only report. Supplied case data is included, not redacted. */
export function renderReport(report) {
  if (!report || typeof report !== 'object' || !Array.isArray(report.cases)) {
    throw new TypeError('A comparison report with cases is required.');
  }
  const json = JSON.stringify(report);
  if (Buffer.byteLength(json, 'utf8') > 16 * 1024 * 1024) {
    throw new RangeError('Report exceeds the HTML rendering limit.');
  }
  const escaped = json.replace(/[<>&\u2028\u2029]/g, char =>
    '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
  let html = readFileSync(new URL('./report.html', import.meta.url), 'utf8').replace(/\r\n?/g, '\n');
  const script = html.match(/<script id="app">([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error('Report template is incomplete.');
  const hash = createHash('sha256').update(script).digest('base64');
  html = html.replace('REPORT_SCRIPT_HASH', hash);
  html = html.replace('REPORT_DATA_JSON', () => escaped);
  if (Buffer.byteLength(html, 'utf8') > 16 * 1024 * 1024) {
    throw new RangeError('Rendered HTML exceeds the output limit.');
  }
  return html;
}
