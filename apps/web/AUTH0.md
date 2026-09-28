# Web sign-in configuration

`auth-config.json` is public and has exactly these fields:

```json
{
  "issuer": "https://YOUR_TENANT.auth0.com/",
  "clientId": "YOUR_PUBLIC_SPA_CLIENT_ID",
  "audience": "YOUR_API_IDENTIFIER"
}
```

Use an Auth0 **Single Page Application** with Authorization Code + PKCE enabled. `issuer` must be an HTTPS origin with a trailing `/` and no path, query, credentials, or fragment. `clientId` is the public application ID. `audience` is the API identifier configured for the access token and must match the API's `AUTH0_AUDIENCE`. No client secret belongs in this file.

For the default local web server at `http://127.0.0.1:3001`, register `http://127.0.0.1:3001/` as an **Allowed Callback URL** and **Allowed Logout URL**, and `http://127.0.0.1:3001` as an **Allowed Web Origin** in the Auth0 application. The callback URL is the current page's origin and pathname; if the app is served at another pathname, register that exact URL instead. Configure the API with the same issuer and audience and an Auth0 user mapping so `/v1/me` can return the signed-in role.

With all three fields empty, the web app keeps the demo user switcher. The API must have `ALLOW_DEMO_AUTH=true` for that mode. A partially filled or invalid configuration displays an error and does not fall back to the demo switcher.

The browser requests `openid profile`, exchanges the code with its PKCE verifier, validates state and the signed ID token (including nonce), and keeps only the access token in `sessionStorage` until expiration or logout. API calls use `Authorization: Bearer ...`; `/v1/me` supplies the role used by the UI. Register the API's web origin and allow the `Authorization` request header for browser calls.

Flow reference: [Auth0 Authorization Code Flow with PKCE](https://auth0.com/docs/get-started/authentication-and-authorization-flow/authorization-code-flow-with-pkce/add-login-using-the-authorization-code-flow-with-pkce).
