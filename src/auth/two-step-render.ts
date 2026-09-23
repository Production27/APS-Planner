// Pieces of the two-step verification screens shared by the sign-in
// overlay (login.ts, when the company requires setting it up) and
// Settings > Two-step verification (src/app/two-step.ts).
import qrcode from 'qrcode-generator';
import { escapeHtml } from '../utils/html';

// Draws the otpauth:// link as a QR code an authenticator app can scan.
// Generated locally: the secret never goes to a QR-code web service.
export function renderQrInto(container: HTMLElement, uri: string): void {
  const qr = qrcode(0, 'M');
  qr.addData(uri);
  qr.make();
  container.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 3, scalable: true });
  const svg = container.querySelector('svg');
  if (svg) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'QR code for your authenticator app'); }
}

// Groups the key in fours so it's easier to type by hand.
export function formatSecret(secret: string): string {
  return secret.replace(/(.{4})/g, '$1 ').trim();
}

export function recoveryCodesText(codes: string[], username: string): string {
  return 'TeamSync recovery codes for ' + username + '\r\n' +
    'Each code works once, if you can\'t use your authenticator app.\r\n' +
    'Made ' + new Date().toLocaleString() + '\r\n\r\n' + codes.join('\r\n') + '\r\n';
}

// Lists the codes with Copy and Download buttons.
export function renderRecoveryCodesInto(container: HTMLElement, codes: string[], username: string): void {
  container.innerHTML =
    '<ol class="mfa-codes">' + codes.map(function (c) { return '<li><code>' + escapeHtml(c) + '</code></li>'; }).join('') + '</ol>' +
    '<div class="mfa-codes-actions">' +
      '<button type="button" class="btn btn-secondary" data-act="copy">Copy</button>' +
      '<button type="button" class="btn btn-secondary" data-act="download">Download</button>' +
    '</div>';
  const text = recoveryCodesText(codes, username);
  const copyBtn = container.querySelector('[data-act="copy"]') as HTMLButtonElement;
  copyBtn.onclick = function () {
    const btn = copyBtn;
    navigator.clipboard.writeText(text).then(function () { btn.textContent = 'Copied'; }, function () { btn.textContent = 'Copy failed'; });
  };
  (container.querySelector('[data-act="download"]') as HTMLButtonElement).onclick = function () {
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'teamsync-recovery-codes.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  };
}
