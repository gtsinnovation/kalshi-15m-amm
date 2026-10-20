# Local Google sign-in

The hosted Lovable service implements `/~oauth/initiate`. Vite does not.
During loopback development, the app explicitly uses the hosted broker at
`https://k15mamm.webpwa.io/~oauth/initiate`. Hosted builds retain the existing
relative Lovable flow. State validation and trusted message origins remain
handled by the Lovable SDK. No login bypass is introduced.

The managed backend advertises Google as enabled, but a direct request to
its Supabase authorization endpoint returns `missing OAuth secret`.
Therefore switching to direct Supabase Google OAuth is not sufficient for
this project. No Google secret needs to be added to the local frontend.

If the hosted broker rejects the return URL, have the authentication
administrator allow the exact local return URL, for example:

- `http://127.0.0.1:8080/`
- `http://localhost:8080/`

These are distinct origins. Do not replace the production Site URL or add
broad production wildcard redirects. Managed Google callback/client-secret
configuration belongs to the hosted broker, not Vite or a `VITE_*` variable.

After applying the code change, return to `/`, reload, and click Continue
with Google again. Do not reuse the old `/~oauth/initiate` URL. Complete
Google consent yourself. A redirect to the hosted app instead of localhost
may mean the local return URL was not allowed by the managed broker.

No backend settings are changed automatically. The provider/redirect flow
still needs a real user sign-in before end-to-end authentication is verified.
