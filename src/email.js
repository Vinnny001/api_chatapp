// Sends email through Brevo's HTTP API (free plan: 300 emails a day, no domain needed: the
// sender address only has to be confirmed in Brevo). HTTP rather than SMTP, because Render's
// free plan blocks the SMTP ports.
//   BREVO_API_KEY    Brevo → SMTP & API → API keys
//   BREVO_SENDER_EMAIL  the sender address confirmed in Brevo → Senders
//   BREVO_SENDER_NAME   optional, default "ChatApp"
// Without BREVO_API_KEY (development) the email is printed to the server log instead.

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';

export async function sendEmail({ to, subject, text, html }) {
  const key = process.env.BREVO_API_KEY;
  if (!key) {
    console.warn(`[email] BREVO_API_KEY not set, not sent. To: ${to} | ${subject}\n${text}`);
    return;
  }
  const res = await fetch(BREVO_URL, {
    method: 'POST',
    headers: { 'api-key': key, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { email: process.env.BREVO_SENDER_EMAIL, name: process.env.BREVO_SENDER_NAME || 'ChatApp' },
      to: [{ email: to }],
      subject,
      textContent: text,
      htmlContent: html,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Email not sent (Brevo ${res.status}): ${detail.slice(0, 200)}`);
  }
}

/** The code email for confirming an address or resetting a password. */
export function codeEmail({ code, purpose }) {
  const what = purpose === 'reset' ? 'reset your ChatApp password' : 'confirm your email for ChatApp';
  const subject = purpose === 'reset' ? `${code} is your ChatApp password reset code` : `${code} is your ChatApp code`;
  const text = `Use this code to ${what}:\n\n${code}\n\nIt expires in 15 minutes. If this wasn't you, you can ignore this email.`;
  const html = `<div style="font-family:Segoe UI,Roboto,Arial,sans-serif;max-width:420px;margin:auto;padding:24px;color:#111b21">
  <h2 style="color:#0b8f6a;margin:0 0 16px">ChatApp</h2>
  <p>Use this code to ${what}:</p>
  <p style="font-size:32px;font-weight:700;letter-spacing:8px;margin:20px 0">${code}</p>
  <p style="color:#54656f;font-size:14px">It expires in 15 minutes. If this wasn't you, you can ignore this email.</p>
</div>`;
  return { subject, text, html };
}
