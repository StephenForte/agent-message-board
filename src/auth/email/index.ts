import { safeActivationReturn } from '../paths';

export type Email = { to: string; subject: string; text: string };
export interface EmailAdapter { send(email: Email): Promise<void> }

export class CapturingEmailAdapter implements EmailAdapter {
  readonly messages: Email[] = [];
  async send(email: Email) { this.messages.push({ ...email }); }
}

export class ConsoleEmailAdapter implements EmailAdapter {
  async send(email: Email) {
    if (process.env.NODE_ENV === 'production') throw new Error('Console email is disabled in production');
    console.info('[development email]', { ...email, text: consoleEmailText(email.text) });
  }
}

export class ResendEmailAdapter implements EmailAdapter {
  constructor(private readonly apiKey: string, private readonly from: string) {}
  async send(email: Email) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: this.from, ...email }),
      });
      if (!response.ok) throw new Error('delivery failed');
    } catch {
      // Do not propagate provider response bodies, headers, or email content into logs.
      throw new Error('Email delivery unavailable');
    }
  }
}

/** Keep development verification links usable without logging an activation bearer credential. */
function consoleEmailText(text: string): string {
  return text.replace(/https?:\/\/\S+/g, (value) => {
    try {
      const url = new URL(value);
      if (url.pathname.startsWith('/activate/')) return `${url.origin}/activate/[redacted]`;
      const callback = url.searchParams.get('callbackURL');
      if (callback) {
        const destination = new URL(callback, url.origin);
        if (safeActivationReturn(destination.searchParams.get('returnTo'))) {
          destination.searchParams.delete('returnTo');
          url.searchParams.set('callbackURL', `${destination.pathname}${destination.search}`);
        }
      }
      return url.toString();
    } catch { return '[redacted link]'; }
  });
}
