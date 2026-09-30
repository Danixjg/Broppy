# Web sign-in

Configure this public file for your actual tenant; never add a secret:

```json
{
  "issuer": "https://YOUR_TENANT.auth0.com/",
  "clientId": "YOUR_SPA_CLIENT_ID",
  "audience": "YOUR_API_IDENTIFIER",
  "organization": "org_COMPANY_A",
  "apiUrl": "https://YOUR_API_HOST",
  "demo": false
}
```

The login page offers **Sign in with SSO** using Authorization Code with PKCE, state and signed ID-token nonce validation. Access tokens are kept in session storage. Expired tokens require signing in again. Register the exact callback and logout paths used: `/`, `/index.html`, `/login.html`; register the web origin too. API Auth0 issuer/audience/organization values must match. The API reads active status, roles and platform identities from Supabase.

For the local fixture demo only, leave issuer/clientId/audience blank and set `demo: true`; the API independently requires `ALLOW_DEMO_AUTH=true` outside production. Partial or invalid configuration fails closed.

See [server and source setup](../../docs/live-sources-and-sign-in.md).
