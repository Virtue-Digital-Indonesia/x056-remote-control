# Independent frontend releases

Frontend publication changes the UI without restarting the gateway or its agent processes. The gateway serves immutable, checksummed bundles from `state/frontend-releases`. Production does not serve files from the development checkout.

## Enable once

Deploy the backend support during an idle window. Do not force the bootstrap deployment while turns or workflows are running.

On the host, run `scripts/install-deployer.sh`. This installs separate frontend and backend actuators under the same deployment lock. The backend actuator waits for idle indefinitely. Only an explicitly authorized `.deploy/force` can bypass that wait; `.deploy/idle-only` takes precedence.

## Publish

Commit and test the UI changes first. Write the full commit hash atomically to `.deploy/frontend-requested`. The host checks this request every minute.

The actuator exports committed files into a temporary snapshot. It uses the publisher from the running image, never executable code from the candidate snapshot. Publication rejects changed backend source, dependency manifests, or service-worker code. Those changes require an idle backend release.

The publisher validates every asset, saves an immutable bundle, and switches `current.json` atomically. The actuator checks the live UI revision and health afterward. Verification failure triggers rollback.

Read `.deploy/frontend-status.json` and `.deploy/frontend-last.log`. A failed request remains available for review. Existing UI assets remain available throughout publication.

## Open tabs and rollback

Open tabs retain their current scripts, drafts, and connections. The UI displays an update notice without reloading. Refresh when ready to load the current release.

For rollback, run the baked publisher inside the running gateway:

```sh
node --import tsx scripts/frontend-release.ts rollback
```

Run this command from `/app`, using host Docker access. It switches to the previous compatible bundle, or the baked UI when rolling back the first publication. It does not stop the container.

After a backend upgrade, incompatible frontend overrides are ignored and the baked UI loads. Retain old bundles for open tabs; this implementation does not garbage-collect them.
