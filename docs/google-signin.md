# Google sign-in

NovelForge supports email + password (credentials) and Google OAuth. Google is
optional: when the credentials are absent the button is hidden and the
credentials provider keeps working.

## 1. Create OAuth credentials

1. Open the [Google Cloud console](https://console.cloud.google.com/apis/credentials)
   and create (or pick) a project.
2. **APIs & Services → OAuth consent screen**: choose *External*, fill in the app
   name, support e-mail and developer contact. While the app is in *Testing*,
   add each person who needs to sign in under **Test users** — otherwise Google
   refuses with `access_blocked`.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   * Application type: **Web application**
   * **Authorised JavaScript origins**
     * `http://localhost:3000`
     * `https://<your-production-domain>`
   * **Authorised redirect URIs** — must match exactly, one per environment:
     * `http://localhost:3000/api/auth/callback/google`
     * `https://<your-production-domain>/api/auth/callback/google`
4. Copy the client id and client secret.

`AUTH_URL` / `NEXT_PUBLIC_APP_URL` are not required for OAuth, but
`googleCallbackUrl()` in `src/lib/auth/providers.ts` computes the redirect URI
from them — handy when you are unsure which value to paste into the console. A
`redirect_uri_mismatch` error almost always means the URI is missing from
step 3, or the scheme/host/port differs (Google treats `http://localhost:3000`
and `http://127.0.0.1:3000` as different).

## 2. Configure the deployment

```bash
AUTH_TRUST_HOST=true            # required behind a proxy / on Vercel
AUTH_GOOGLE_ID=xxxxxxxx.apps.googleusercontent.com
AUTH_GOOGLE_SECRET=GOCSPX-...
```

Both values must be present. If only one is set, the app logs
`[auth] Google sign-in disabled: …` and hides the button rather than offering a
flow that cannot complete.

## 3. How accounts are created and linked

The whole policy lives in `resolveGoogleSignIn` / `recordOAuthAccount`
(`src/services/auth/service.ts`) and is executed by the NextAuth `signIn` and
`jwt` callbacks (`src/lib/auth/config.ts`).

| Situation | Result |
| --- | --- |
| Google e-mail matches no account | New user row created, `emailVerified` set (Google vouches for the address), `accounts` row written for the Google `sub`. |
| Google `sub` already linked to that same user | Sign-in proceeds; display name and avatar refresh. |
| Google e-mail matches an **unverified password account** | **Refused** (`AccessDenied`). Prevents the classic pre-registration takeover: an attacker signs up with `victim@example.com`, and later the victim's Google sign-in would otherwise land in the attacker's account. The victim signs in with their password first; after e-mail verification the link is allowed. |
| Google e-mail matches a **verified** account | Linked. The password keeps working — linking adds a method, it never replaces one. |
| Google `sub` presented with a **different** e-mail (Google addresses can change) | **Refused** if the `sub` belongs to another user: `This Google account is already linked to a different NovelForge account.` |
| Google reports `email_verified: false`, or returns no e-mail | **Refused** and logged. |
| Link conflict discovered while issuing the token | Session is failed closed: the token gets no user id, and `session()` clears the user, so `requireUser()` rejects it. |

`allowDangerousEmailAccountLinking` is explicitly **false**: the adapter never
links accounts behind our back.

## 4. What was verified here, and what was not

Verified by executed tests (`npx vitest run tests/security/google-auth.test.ts`,
16 tests): provider registration with and without the env vars, redirect-URI
computation, first sign-in creating a verified account, the `accounts` link
being written once and never moved between users, the token containing the
database id, the unverified-password refusal (with the victim's row proven
unchanged), the verified-account link keeping password login working, the
sub/e-mail conflict refusal, the unverified-e-mail refusal, fail-closed behaviour
on a late conflict, and credentials sign-ins being untouched.

Verified live on a running server (`GET /api/auth/providers` and `GET /login`
with credentials set) — see `docs/production-readiness-audit.md` §9.15.

**Not verified:** a real round trip against Google's servers. That needs real
OAuth credentials and a public callback URL, which this environment does not
have. Steps 1–2 above are the remaining configuration work; the code path from
the callback onwards is covered by the tests listed above.

## 5. Network requirement

Auth.js resolves Google's endpoints through OIDC discovery, so the server (not
the browser) must be able to reach:

* `https://accounts.google.com/.well-known/openid-configuration` (sign-in)
* `https://oauth2.googleapis.com/token` (token exchange)
* `https://openidconnect.googleapis.com/v1/userinfo` (profile)

In an environment with restricted egress, Google sign-in fails with
`/api/auth/error?error=Configuration` and the server log shows
`[auth][error] TypeError: fetch failed`. That is a blocked discovery request, not
a credentials problem. Note that with explicit endpoints instead of discovery,
@auth/core cannot verify the ID-token signature (it builds the authorization
server object without `jwks_uri`), so NovelForge keeps the default discovery
flow deliberately rather than trading signature verification for offline
start-up.

## 6. Troubleshooting

| Symptom | Cause |
| --- | --- |
| `redirect_uri_mismatch` | Redirect URI in the console ≠ `<origin>/api/auth/callback/google` (scheme, host or port differ). |
| `access_blocked` / "app not verified" | Consent screen still in *Testing* and the account is not a test user. |
| `Configuration` error on `/login` | `AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET` mismatched (id without secret, or stale values after a rotation). |
| `AccessDenied` for a legitimate user | The account was created with a password and its e-mail is not verified — sign in with the password first. |
| Button missing on `/login` | Both Google env vars must be set; check the server log for `[auth] Google sign-in disabled`. |
| `error=Configuration` + `fetch failed` in the log | The server cannot reach `accounts.google.com` for OIDC discovery — check egress/DNS/proxy rules (see §5). |
| `MissingCSRF` | The sign-in POST arrived without the CSRF cookie/token; re-load `/login` before clicking. |
