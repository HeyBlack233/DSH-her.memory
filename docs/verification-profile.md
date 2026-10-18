# Verification Profile: her-memory-test

This document describes how to create and use a dedicated DSH profile,
`her-memory-test`, to verify the plugin without touching the current web
profile.

## Purpose

Live verification is run in a throwaway profile so that installing, configuring,
and exercising the plugin never affects the active web profile or the running
3080 server. All work happens on a separate port (3090) and can be cleaned up
completely afterwards. The profile is created from the default `web` profile,
so the settings-page shell and the client plugins behave the same way they do in
day-to-day use.

## Create the profile

Run the following from the plugin checkout:

```bash
dsh --profile her-memory-test --from-default-profile web --dump-config
```

This creates `/home/Chocola/.dsh/profiles/her-memory-test` with the base and
`web-app` bundles copied from the default profile and an empty patch directory.
The profile starts with the default DeepSeek official account and the
`deepseek-flash` model, which is enough for the verification steps.

## Install the plugin

Add the plugin from its local checkout:

```bash
dsh plugin --profile her-memory-test add /home/Chocola/dev/HeyBlack233/DSH-her.memory
```

The `add` command takes the local checkout path as the plugin source, links the
package into the profile, and applies the profile patch so the settings page and
tools are registered. Re-run this command whenever the package link or the patch
needs to be refreshed.

## Run the server

Start the profile as a managed background job:

```bash
dsh --profile her-memory-test --port 3090 --no-open
```

The printed URL includes a token and is the address to open. Do not add `web`
after the profile name: `web` is treated as an extra positional argument and the
command fails. Keep the job id from the background-job start so the server can
be stopped cleanly during cleanup.

## Verification checklist

Run these steps against the 3090 profile while it is running. Each step is
independent of the others, so failures can be fixed and re-checked in place
without restarting the whole flow:

1. Confirm the plugin row is active in the profile.
2. Open the settings page and confirm the Memory entry appears in the sidebar in
   both English and Chinese.
3. Confirm the four tabs (Overview, Memories, Curation, Settings) render.
4. Save configuration and confirm it persists across a reload.
5. Exercise the API actions (state and CRUD) against `/plugins/dsh-her-memory/api`.
6. Confirm the four tools and four skills are registered.
7. Confirm no slot crashes occur while using the settings page and the tools.
8. Confirm data is written under `$DSH_HOME/her-memory`.

## Safety rules

The following rules keep the real environment untouched:

- Never install the plugin into the `web` profile.
- Never change, stop, or restart the 3080 server.
- Stop the 3090 job when verification is finished.
- Remove temporary files created during verification.
- If a step fails, debug inside the `her-memory-test` profile only; do not
  switch the current profile to test a fix.

## Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| Plugin not listed in the profile | Package link or patch not applied | Re-run the plugin `add` command and check the profile patch directory for the expected entries |
| Settings entry missing | Client injection or registration failed | Check the client inject wiring and the settings-page registration, then restart the 3090 job |
| API returns 404 | `webServer` route not mounted | Check the web server route configuration and restart the 3090 job |
| Backend unreachable | Wrong or missing backend config | Verify the endpoint and credentials; a keyword-only search still works without a backend |
| Port conflict | 3090 already in use | Stop the existing job or choose another free port |
