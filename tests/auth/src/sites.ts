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
      mfa: 'itsme: a QR code that changes every few seconds, scanned with the app straight off the Mac screen (remotely: move to the Mac with request_device)',
      instructions: 'Log in to My ENGIE and choose itsme on the login page.',
    },
    {
      id: 'google',
      label: 'Google (vinted)',
      site: 'https://www.vinted.com/',
      vaultHosts: ['google.com'],
      hosts: ['vinted.com', 'vinted.be', 'accounts.google.com', 'google.com'],
      mfa: 'Google 2-step verification: a prompt on my phone (tap Yes, maybe pick a number) or a code',
      instructions:
        'Log in to Vinted with "Continue with Google", using my Google account from the vault. Do not use the email, Apple or Facebook options. Accept only the cookie choices needed to continue.',
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
      label: 'Email + 2FA (booking.com)',
      site: 'https://account.booking.com/sign-in',
      vaultHosts: ['booking.com'],
      vaultOptional: true,
      hosts: ['booking.com'],
      mfa: 'a verification code sent to my email (fetch it with get_email_code)',
      instructions:
        'Sign in to Booking.com with my email address (from get_personal_info, or the vault entry if there is one), not with Google, Apple or Facebook. If it asks for a password and there is no vault entry, ask me.',
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
