# Playwright E2E

The Playwright smoke tests verify that the Helpdesk web page renders without
server or browser errors and that `/healthz` reports a healthy application.

## Runner requirement

`helpdesk.lab.local` is available only inside the homelab network. The workflow
therefore uses a Linux self-hosted GitHub Actions runner with these labels:

- `self-hosted`
- `linux`
- `homelab`

Add the runner in repository **Settings > Actions > Runners > New self-hosted
runner** and install it on a trusted Linux host that can resolve and reach the
Helpdesk URL.

## Running the test

Open **Actions > Playwright E2E > Run workflow**. Keep the default URL or enter
another Helpdesk address reachable from the runner.

The workflow also runs every day at 05:00 UTC. Failed runs retain screenshots,
traces, video, and the HTML report for 14 days.

The initial smoke test does not log in and needs no password. Authenticated user
flows can be added later with credentials stored as GitHub Actions secrets.
