// A crash used to only surface if the person who hit it happened to
// mention it — nothing told an admin automatically. Registered as early
// as possible (this module is one of the first imported by main.ts) so
// it catches as much of boot as possible. The try/catch inside
// reportClientError() is what makes that safe even if something inside
// it throws: reporting an error must never itself throw a second one.
import { getStoredSessionToken } from '../auth/session';

let clientErrorReportCount = 0;
const MAX_CLIENT_ERROR_REPORTS_PER_LOAD = 20; // bounds a tight error loop, not normal use

export function reportClientError(kind: string, message: unknown, extra?: Record<string, unknown>): void {
  try {
    if (clientErrorReportCount >= MAX_CLIENT_ERROR_REPORTS_PER_LOAD) return;
    clientErrorReportCount++;
    const token = (typeof getStoredSessionToken === 'function') ? getStoredSessionToken() : null;
    const body = Object.assign({
      kind: kind,
      message: String(message || '').slice(0, 500),
      pageUrl: location.href,
      userAgent: navigator.userAgent,
      appVersion: (typeof APP_VERSION !== 'undefined') ? APP_VERSION : null,
      token: token || null,
    }, extra || {});
    fetch(API_BASE_URL + 'report-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true, // survives a navigation/close triggered by the same error
    }).catch(function() {}); // best-effort — a failed report is not itself worth reporting
  } catch (e) { /* reporting must never throw */ }
}

window.addEventListener('error', function(e) {
  reportClientError('error', e.message, {
    stack: e.error && e.error.stack ? String(e.error.stack).slice(0, 2000) : null,
    source: e.filename || null,
    line: e.lineno || null,
    col: e.colno || null,
  });
});
window.addEventListener('unhandledrejection', function(e) {
  const reason = e.reason;
  reportClientError('unhandledrejection', reason && reason.message ? reason.message : String(reason), {
    stack: reason && reason.stack ? String(reason.stack).slice(0, 2000) : null,
  });
});
