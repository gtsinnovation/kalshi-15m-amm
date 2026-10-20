# Hetzner migration: k15mamm.webpwa.io

## Scope

This release uses the one-hour app's authentication process: confirmed, allowlisted Supabase accounts sign in with a password and a fresh TOTP authenticator code. It retains the 15-minute strategy and its existing Supabase project. The new server verifies every relay request with Supabase, checks password evidence, current verified factors, AAL2 and a TOTP timestamp no older than one hour. Password-only admins may access enrollment status, not the relay.

**This release is DEMO only.** Production exchange access is blocked in server policy; there is no environment switch to enable it. This does not resolve every existing audit finding. The trading loop still runs in the browser; Docker does not turn it into the one-hour app's persistent worker. Closing or suspending the browser can interrupt execution.

No accounts, authentication settings, DNS records or deployments were changed. The prepared patch has not been applied to the read-only D: repository.

## Admin preparation

Use the 15-minute project's own Supabase URL and publishable key. Do not copy private keys, env files, accounts or data volumes from the reference app. An authorized project administrator must enable password authentication and TOTP, disable public signup, and provision confirmed trusted admins. For an existing Google-linked account, set its password through supported Supabase administration without duplicating the account or removing its factors. Verify ownership first. Use a password minimum of at least 12 characters and configure recovery through the administrator. No service-role key belongs in a frontend variable or Docker build argument.

Set ALLOWED_EMAILS on the server. It is authoritative; browser state cannot grant access. This is one private admin application: all allowlisted accounts are trusted admins, not isolated tenants. Existing Google-only sessions are rejected; sign out and use the password.

On first login, choose Set up authenticator, scan the private QR code or enter the setup key, and verify a six-digit code. Add a backup factor through Authenticator settings. This release has no recovery codes or password-recovery bypass. Test recovery with the administrator before relying on it.

Authorization is rechecked in the dashboard every 15 seconds and on relevant auth/visibility events; failure pauses execution and clears unlocked credentials. The relay verifies each request independently. Token refresh does not renew TOTP evidence. Pausing, expiry, vault locking and signing out **do not guarantee cancellation** of resting orders. Use Kalshi directly to verify/cancel orders. Accept this release with a dedicated DEMO account only.

## Local checks

After applying the patch, run npm ci --ignore-scripts, npm run typecheck, npm test, npm run test:server, npm run lint and npm run build.

The dev server forwards /api and /healthz to port 3000. In the server terminal set APP_ORIGIN=http://127.0.0.1:8080, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and ALLOWED_EMAILS, then run npm run start:server. Run npm run dev in another terminal. Frontend VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY must refer to the same project. Password/TOTP does not use the Lovable OAuth broker.

For local Docker testing, use APP_ORIGIN=http://127.0.0.1:3015 in a local Compose env file. The host port is bound only to 127.0.0.1:3015. Verify health, login, enrollment, refresh, expired-factor denial, non-admin denial, DEMO operations and production denial.

## Existing Hetzner host

The Compose project is named k15mamm, distinct from the one-hour stack's amm project. It has no shared hourly data volume and starts no competing HTTPS gateway.

1. Transfer patched source using the normal private release process. Create deploy/.env.production from the supplied example on the host; do not commit it. Supply actual public project values, confirmed admin allowlist and APP_ORIGIN=https://k15mamm.webpwa.io.
2. For a containerized existing gateway, identify its existing network and set K15M_GATEWAY_NETWORK. Include deploy/compose.gateway.yaml with compose.yaml. The app joins under the unique alias k15mamm-app. The existing gateway must be on that network.
3. Add deploy/Caddyfile.k15mamm as a site block in the existing gateway configuration. It is a snippet, not a replacement for the hourly Caddyfile. For host-installed Caddy, omit the gateway override and change its upstream to 127.0.0.1:3015. For another gateway, translate the route and headers; do not start another listener on 80/443.
4. Validate and build before cutover:

```sh
docker compose --env-file deploy/.env.production -f compose.yaml -f deploy/compose.gateway.yaml config --quiet
docker compose --env-file deploy/.env.production -f compose.yaml -f deploy/compose.gateway.yaml build
```

5. Review the image, then start only this project using the same Compose arguments and up -d. Validate and reload the existing gateway through its normal operating procedure. Preserve its existing sites and environment.
6. Point the domain's A record to Hetzner and correct any stale AAAA record. Preserve previous DNS/gateway values for rollback. Verify certificate issuance. Set the Supabase project's Site URL and relevant recovery redirects to the final origin. Normal password/TOTP sign-in does not depend on the Google redirect allowlist.
7. Verify HTTPS, headers, /healthz, direct /credentials reload, password/TOTP enrollment/login, non-admin denial, dedicated-account DEMO reads/orders/cancellations and production denial. Confirm the hourly application remains healthy.

## Cutover and rollback

Pause the old browser bot and verify all orders directly in Kalshi before migration. Retire or equivalently secure the old Supabase kalshi-proxy before any future live release: this new server gate does not protect that independently reachable function. Existing backend functions and RLS need separate review under the private-admin model.

Keep the prior image tag, env file, DNS and gateway configuration. Roll back only k15mamm and its routing; do not stop the hourly project. Encrypted vault and audit data stay in the browser and origin, not on Hetzner. Do not clear them during migration. Arrange any encrypted backup through your operator process.

## Limits of verification

Real account provisioning, enrollment, exchange acceptance, image build/start, DNS and gateway cutover still need operator validation. Docker Desktop's Linux daemon was unavailable during preparation. Compose validation is not a container runtime test. Review the accompanying results report before deployment.

Primary references: [Supabase TOTP](https://supabase.com/docs/guides/auth/auth-mfa/totp), [password authentication](https://supabase.com/docs/guides/auth/passwords), [Compose project names](https://docs.docker.com/compose/how-tos/project-name/).
