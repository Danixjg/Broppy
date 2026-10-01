# Hosting the APIs on Tencent Cloud Lighthouse

The website runs on Vercel (`https://broppy-one.vercel.app`). Its server side calls the APIs; browsers never do. This
folder runs them on one Lighthouse server with Docker Compose:

| Service | Address | What it serves |
| --- | --- | --- |
| `demo-api` | `https://demo-api.<ip>.sslip.io` | The public demo: fictional mock data and no sign-in. It runs with `PUBLIC_DEMO=true` and refuses to start if any real identity or data setting is present. |
| `sso-api` (optional, profile `sso`) | `https://sso-api.<ip>.sslip.io` | Real sign-in. It accepts only Auth0 access tokens, reads the Supabase directory and writes the durable audit. |
| `caddy` | ports 80 and 443 | HTTPS for both addresses. It gets and renews Let's Encrypt certificates by itself. |

[sslip.io](https://sslip.io) names need no domain: `demo-api.43-156-1-2.sslip.io` resolves to `43.156.1.2`.

The Vercel site sends demo visitors to `DEMO_API_URL` and signed-in people to `BRAIN_API_URL`. The two never mix:
the demo path forwards only a persona name, and the SSO path forwards only the session's access token.

**Cost.** As of 30 Sep 2026, Lighthouse offers new users a free trial (2 vCPU, 2 GB, 3 months, no card), which covers
the hackathon. Check the current terms on the offer page before you create the server. Keep **auto-renew off**. If
the server isn't renewed, it's suspended about 48 hours after expiry and its data is kept for 15 days. To stop
everything sooner, delete the instance.

## 1. Create the server

In the Tencent Cloud console, open **Lighthouse** and create an instance with the free-trial offer:

- **Region:** Singapore, or another region outside mainland China. Mainland regions block websites on domains without
  an ICP filing, and sslip.io names can't have one.
- **Image:** Ubuntu Server 24.04 LTS (a system image). The Docker CE application image also works if
  `docker compose version` prints v2 or later; then skip step 3.
- **Plan:** the free-trial 2 vCPU / 2 GB bundle, with auto-renew off.

Note the instance's **public IPv4 address**, e.g. `43.156.1.2`.

## 2. Open the firewall

Open the instance's **Firewall** tab and allow **TCP 80** and **TCP 443** from all IPv4 sources (`0.0.0.0/0`). Keep
the SSH rule. Port 80 is used to issue certificates and to redirect to HTTPS.

## 3. Install Docker

Log in with the console's **Log in** button, or with SSH, then run:

```sh
curl -fsSL https://get.docker.com | sudo sh
sudo docker compose version
```

## 4. Start the demo API

```sh
git clone https://github.com/Danixjg/Broppy.git broppy
cd broppy
# Until this folder is on main, use the branch that has it:
git checkout fix/auth0-wiring
cd infra/tencent
cp .env.example .env
nano .env
```

In `.env`, replace `43-156-1-2` in both names with your server's IP, written with dashes. Then start it:

```sh
sudo docker compose up -d --build
```

The first build takes a few minutes. Caddy then gets the certificates, usually within a minute. Check from anywhere:

```sh
curl https://demo-api.43-156-1-2.sslip.io/health
curl -H 'x-demo-user: maya' https://demo-api.43-156-1-2.sslip.io/v1/me
```

The first returns `{"ok":true,…}`, and the second returns Maya with role `admin`.

## 5. Point the Vercel site at it

In the Vercel project behind `https://broppy-one.vercel.app`, open **Settings → Environment Variables** and add:

| Name | Value | Environments |
| --- | --- | --- |
| `DEMO_API_URL` | `https://demo-api.43-156-1-2.sslip.io` | Production and Preview |

Then redeploy: **Deployments**, the latest deployment's **⋯** menu, **Redeploy**. The start page now offers **Try
the demo**. The workspace opens with a demo banner, and **Viewing as** in the header switches between the six
fictional people.

The demo keeps one shared state for every visitor, and anyone can act as any persona, the admin included. Content
and permission edits therefore stay visible to everyone until the demo API restarts. A restart puts the fictional data
back:

```sh
sudo docker compose restart demo-api
```

Optional: **Settings → Functions → Function Region → Singapore (sin1)** puts the site's server side next to the
API, which saves a round trip across the Pacific on every workspace request.

## 6. Add real sign-in

Do this after `pnpm doctor:sso` passes on a teammate's machine (see `apps/web/AUTH0.md`). That confirms the Auth0
tenant and Supabase are ready.

**Before you start: one SSO API per Supabase project.** The durable audit is one hash chain per organization, and
only one API may write to it. The hosted SSO API and a local `pnpm dev:sso` on the same Supabase project therefore
break each other: once both have been used, one of them fails every request until it restarts. Before local SSO
work, stop the hosted one with `sudo docker compose --profile sso stop sso-api`. Afterwards, start it again with the
`up` command below; starting reloads the chain. The alternative is to give the hosted API its own Supabase project,
with the migrations applied and the users seeded as in `apps/web/AUTH0.md` section 3.

**On the server:**

```sh
cd ~/broppy/infra/tencent
cp sso.env.example sso.env
nano sso.env
```

Fill `sso.env` with the same values as the API section of the team's `.env.local`.

Then add the audit signing key as `audit-signing-key.pem` in this folder. Create the file with `nano` and paste the
key file's contents, or copy it over with `scp`.

Use the **team's existing key**, the one already used with this Supabase project. At startup the API checks the
signature of every stored audit batch, and it refuses to start with a different key. Generate a new key
(`openssl genpkey -algorithm ed25519 -out audit-signing-key.pem`) only if the project's audit tables are still
empty, and then share it with the team.

```sh
# The API runs as the image's node user (uid 1000).
sudo chown 1000:1000 audit-signing-key.pem
sudo chmod 600 audit-signing-key.pem
sudo docker compose --profile sso up -d --build
curl https://sso-api.43-156-1-2.sslip.io/health
curl -H 'x-demo-user: ravi' https://sso-api.43-156-1-2.sslip.io/v1/me
```

The first returns `{"ok":true,…}`. The second must return **401**, because the SSO API refuses demo personas.

**In Vercel** (Settings → Environment Variables), add these for **Production only**, then redeploy:

| Name | Value |
| --- | --- |
| `APP_BASE_URL` | `https://broppy-one.vercel.app` |
| `AUTH0_DOMAIN` | `dev-3es7focax4cjcswg.us.auth0.com` |
| `AUTH0_CLIENT_ID` | `msyBcV9l7aWnFYDW2NqlF2BvjeeUHwlD` |
| `AUTH0_CLIENT_SECRET` | The application's client secret. Mark it **Sensitive**. |
| `AUTH0_SECRET` | A new value from `openssl rand -hex 32`. Mark it **Sensitive**. |
| `AUTH0_AUDIENCE`, `AUTH0_ORG_ID` | The same values as in `sso.env` |
| `BRAIN_API_URL` | `https://sso-api.43-156-1-2.sslip.io` |

Previews stay demo-only, because they don't get these variables. Their addresses vary by branch and deployment, and
aren't in Auth0's allowlists.

**In Auth0** (Applications → the Regular Web Application → Settings), add the site next to the local entries:

- **Allowed Callback URLs:** `https://broppy-one.vercel.app/auth/callback`
- **Allowed Logout URLs:** `https://broppy-one.vercel.app`, exactly as written in `APP_BASE_URL`
- **Allowed Web Origins:** `https://broppy-one.vercel.app`

The start page then offers both **Sign in with SSO** and **Try the demo**. A signed-in session always takes priority
over demo mode.

## 7. Optional: a language model that costs nothing

Without a model, the built-in writer answers. To add one, see `decisions.md`, D27 and D28.

**The public demo on Groq's free plan.** With no card on file, Groq can't bill. On the server:

```sh
cd ~/broppy/infra/tencent
cp demo.env.example demo.env
nano demo.env
sudo docker compose up -d demo-api
```

Paste the Groq API key into `demo.env`. All visitors share `LLM_DAILY_ANSWERS` (100 to start). After that, the
built-in writer answers until midnight UTC.

**The SSO API on Tencent's model, within its free tokens.** Do this only after `pnpm llm:usage` reports that the plan
fits. First, in TokenHub, check that post-paid billing is not enabled, as it isn't by default. Calls past the free
tokens then stop instead of billing, and the budgets below are a second stop.
Uncomment the TokenHub lines in `sso.env`. Every machine using the same Tencent Cloud account draws on the same free
tokens, and each counts only its own calls. So the server's budgets plus the laptops' must stay below 800000 each: the
example's 700000 leaves 100000 for local runs. Then run `sudo docker compose --profile sso up -d`. The API refuses to
start with TokenHub or Hunyuan if a budget is missing.

**Checking usage.** Each API keeps its counts on the `model-usage` volume, and they survive restarts and rebuilds:

```sh
sudo docker compose exec demo-api cat /data/usage-demo.json
sudo docker compose --profile sso exec sso-api cat /data/usage-sso.json
```

Never run `docker compose down -v` while Hunyuan is in use. It deletes the volume, and the counts would start from
zero again. As Nur, asking the audit log for `llm_fallback` shows when, and why, the built-in writer stepped in.

## Updating

```sh
cd ~/broppy
git pull
cd infra/tencent
sudo docker compose up -d --build
```

Once SSO runs, add `--profile sso` to that last command. Rebuilding restarts the demo API, which resets its data.
Now and then, run `sudo docker image prune -f` to free disk space from old builds.

## Troubleshooting

Start with `sudo docker compose ps` and `sudo docker compose logs --tail 50 <service>`. Once SSO runs, add
`--profile sso` after `compose`.

| Symptom | Cause | Fix |
| --- | --- | --- |
| `curl` hangs or the connection is refused | Ports 80 and 443 are closed, or Caddy isn't running | Step 2; check `ps` and the `caddy` logs |
| Certificate errors right after the first start | Caddy is still getting certificates, or Let's Encrypt can't reach port 80 | Wait a minute and retry; check the `caddy` logs and the firewall |
| `sso-api.…` answers 502 | The SSO API isn't running (expected until step 6), or it stopped at startup | Check the `sso-api` logs. Startup errors are listed in `apps/web/AUTH0.md` section 6. |
| `env file …/sso.env not found` | `--profile sso` was used before `sso.env` existed, or Compose is older than the one step 3 installs | Create `sso.env` (step 6) |
| `bind source path does not exist: …/audit-signing-key.pem` | The key isn't in this folder | Add it (step 6) |
| `sso-api` logs `EACCES` for the key | The container's user can't read the key | `sudo chown 1000:1000 audit-signing-key.pem` |
| `sso-api` logs `Invalid stored audit log` | The key isn't the one that signed the stored audit | Use the team's existing key |
| Every SSO request, `/health` included, answers `{"error":"Invalid request"}` | The SSO API can no longer write to Supabase. Most often another API, such as a local `pnpm dev:sso`, wrote to the same audit chain. | Stop the other API, then run `sudo docker compose --profile sso restart sso-api` |
| `demo-api` logs `PUBLIC_DEMO serves mock data only; remove …` | A real setting reached the demo API | Remove it. The demo API must only get `PUBLIC_DEMO`. |
| The start page has no **Try the demo** | `DEMO_API_URL` isn't set for that environment, or the deployment predates it | Step 5, then redeploy |
| The workspace says "The demo API did not accept this persona" | `DEMO_API_URL` points at the SSO API | Use the `demo-api.…` address |
| The workspace says "The demo API is not reachable; check DEMO_API_URL" | Wrong address, or the demo API is down | Run the step 4 checks |
| Answers no longer come from the model | The daily allowance or the budget is used up, the model is rate limited, or its replies weren't copied word for word (`ungrounded`). Ask the audit log for `llm_fallback` to see which. | Wait for midnight UTC, or check the counts (step 7). Raise a Hunyuan budget only within its free tokens. |
| An API stops at startup with `TokenHub needs LLM_USAGE_FILE and LLM_TOKEN_BUDGET…` (or `Hunyuan needs…`) | The model settings have no budget | Set the budgets in `sso.env` (step 7) |
| The build stops with `exit code: 137` | The server ran out of memory while building | Add swap (below), then build again |

To add 2 GB of swap:

```sh
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## Security notes

- The demo API is public by design and serves only the fictional mock corpus. Startup fails if an Auth0, Supabase,
  live-source, source-OAuth or remote FGA setting reaches it.
- The SSO API accepts only valid Auth0 access tokens from the configured organization, for people in the Supabase
  directory. Demo personas get 401.
- Secrets live in `sso.env`, in the key file (both gitignored) and in Vercel's environment variables. Never commit
  them.
- The Vercel site forwards demo visitors only to `DEMO_API_URL`, with no credentials. It forwards signed-in people only
  to `BRAIN_API_URL`, with their session's token.
