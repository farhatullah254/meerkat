export const DEFAULTS = {
  enabled: true,
  corner: 'bottom-right',
  maxCards: 5,
  meerkatUrl: 'http://localhost:3000',
  opacity: 0.72,
  blocklist: [
    'mail.google.com',
    'accounts.google.com',
    'login.microsoftonline.com',
    'outlook.office.com',
    'outlook.live.com',
    'paypal.com',
    'stripe.com',
    'wise.com',
    'revolut.com',
    'monzo.com',
    'chase.com',
    'hsbc.co.uk',
    'barclays.co.uk',
    'natwest.com',
    'lloydsbank.com',
    '1password.com',
    'bitwarden.com',
    'lastpass.com'
  ]
};

/** A host is blocked on an exact match or as a subdomain of a listed domain. */
export function isBlocked(hostname, blocklist) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  return (blocklist || []).some((raw) => {
    const entry = String(raw || '').trim().toLowerCase().replace(/^\.+|\/+$/g, '');
    if (!entry) return false;
    return host === entry || host.endsWith(`.${entry}`);
  });
}
