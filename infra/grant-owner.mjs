// Marks one Firebase Auth user as the owner of this dodo instance. Security rules only
// allow users with the `dodo_owner` claim. Run in Cloud Shell after your first sign-in:
//   cd infra && npm i firebase-admin && node grant-owner.mjs PROJECT_ID you@example.com
import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const [projectId, email] = process.argv.slice(2);
if (!projectId || !email) {
  console.error('usage: node grant-owner.mjs PROJECT_ID EMAIL');
  process.exit(1);
}
initializeApp({ credential: applicationDefault(), projectId });
const auth = getAuth();
const user = await auth.getUserByEmail(email);
await auth.setCustomUserClaims(user.uid, { ...(user.customClaims ?? {}), dodo_owner: true });
console.log(
  `${email} (${user.uid}) is now the dodo owner. Sign out and in again to refresh the token.`,
);
