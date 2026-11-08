/**
 * The logins `pnpm test:auth` tests, fixed so a run needs no setup. Each one uses the vault entry
 * for the first of its `vaultHosts` you have one for (Settings › Vault). Edit this list to test
 * other sites, or pass a JSON file of the same shape with --targets.
 */
import type { Targets } from './matrix.ts';

export const SITES: Targets = {
  methods: [
    {
      id: 'itsme',
      label: 'itsme (engie.be)',
      site: 'https://www.engie.be/nl/login/',
      vaultHosts: ['engie.be', 'itsme-id.com', 'itsme.be'],
      vaultOptional: true,
      hosts: ['engie.be', 'itsme-id.com', 'itsme.services', 'itsme.be'],
      mfa: 'itsme: a push to the itsme app after entering my phone number, or a QR code to scan',
      instructions:
        'Log in to My ENGIE and choose itsme on the login page. Prefer the option with my phone number (from the vault entry or get_personal_info), which sends a push to my itsme app; only use the QR code when there is no other option.',
    },
    {
      id: 'google',
      label: 'Google (booking.com)',
      site: 'https://account.booking.com/sign-in',
      vaultHosts: ['google.com'],
      hosts: ['booking.com', 'accounts.google.com', 'google.com'],
      mfa: 'Google 2-step verification: a prompt on my phone (tap Yes, maybe pick a number) or a code',
      instructions:
        'Sign in to Booking.com with "Continue with Google" (or "Sign in with Google"), using my Google account from the vault. Do not sign in with an email address on Booking.com itself.',
    },
    {
      id: 'password',
      label: 'Username + password (overleaf)',
      site: 'https://www.overleaf.com/login',
      vaultHosts: ['overleaf.com'],
      hosts: ['overleaf.com'],
      mfa: 'none expected; if Overleaf asks for a code, it comes by email (use get_email_code)',
      instructions:
        'Log in with the email and password from the vault on the Overleaf login form itself, not with Google or another provider.',
    },
    {
      id: 'email-2fa',
      label: 'Email + 2FA (vinted)',
      site: 'https://www.vinted.com/',
      vaultHosts: ['vinted.com', 'vinted.be'],
      vaultOptional: true,
      hosts: ['vinted.com', 'vinted.be'],
      mfa: 'a verification code sent to my email (fetch it with get_email_code), or by SMS (ask me)',
      instructions:
        'Choose "Log in", then the email option (not Google, Apple or Facebook). Use my email address from get_personal_info, or from the vault entry if there is one; if Vinted asks for a password and there is no vault entry, ask me. Accept only the cookie choices needed to continue.',
    },
    {
      id: 'google-session',
      label: 'Google (stored session)',
      site: 'https://myaccount.google.com/',
      hosts: ['google.com'],
      useGoogleSession: true,
      enabled: false,
    },
  ],
};
