# Self-host installation candidate

This is a loopback-only installation candidate, not a published or production-ready release. No public images or upgrade automation are supplied here. It uses the existing static Web image layout and API entry point. PostgreSQL 16 is isolated behind Compose, with its own named volume. The Web proxy routes `/api/`, `/healthz` and `/readyz` to the API on the internal network. Cloud features, payments, generation and the worker are not available in this bundle.

## Prepare a new instance

Use Docker with the Compose plugin, Node.js to run the preflight, and the reviewed release's Web, API and PostgreSQL image references. The two app images must come from the **same release**. Digest pinning prevents a tag from changing underneath this setup; it does not certify that two images are compatible. The bundle contains no live registry name, usable image references or credentials.

From this directory, create an untracked `.env` from the provided `.env.example`. Fill in the three `name:tag@sha256:…` references and a unique database password (`openssl rand -hex 32`). Compose uses environment-variable overrides ahead of `.env`: run from a shell without stale `CANVAS_*` overrides. Keep the same Compose project name across restarts, and use a different one per instance so instances do not reuse volumes.

```sh
node preflight.mjs
```

Preflight checks the rendered configuration without printing secret values, pulling images or starting services. Keep accounts off for the first smoke test. Enabling `CANVAS_ACCOUNTS_ENABLED` requires a separate stable auth secret, SMTP, Turnstile and the existing timeout settings. Preflight checks that these are present, not that the services or credentials work. This bundle does not configure admin bootstrap or real email/Turnstile acceptance.

Once the matching images are available, the **first-install rehearsal** for a fresh project is:

```sh
docker compose --env-file .env -p canvas-selfhost pull db api web
docker compose --env-file .env -p canvas-selfhost up -d --wait db
docker compose --env-file .env -p canvas-selfhost --profile migration run --rm --no-deps migrate
docker compose --env-file .env -p canvas-selfhost up -d api web
```

Run these in order and stop if a command fails. The migration is explicit and is not run by an ordinary startup. Open `http://127.0.0.1:3000` (or the configured port); check `/healthz`, `/readyz` and `/api/v1/meta` are JSON from the API, then verify `/assets` loads the Web app. With accounts disabled, `/readyz` is not a schema check; the separate migration exit is required. Do not use `down -v` when preserving the instance database. Do not reuse the commands as an upgrade procedure for an existing instance or attach an existing database to the candidate.

## Verification and next gate

`node --test deploy/self-host/preflight.test.mjs` from the repository root renders the real Compose file with synthetic settings. It checks loopback binding, profile separation, a persistent data volume, API/migration consistency, rejection of mutable image tags and incomplete account settings, and that ambient payment/generation variables do not turn on those features. It does not pull images or require a running engine.

The next gate is to produce reviewed, same-release image artifacts and run an isolated first-install rehearsal, including the HTTP checks above and confirming the database survives container recreation. A later gate covers version notifications, backups and a real previous-version upgrade with restore verification. None of those runtime gates has passed yet.
