# Go Peer Aleph Packaging

This directory now keeps only the `universal-connectivity`-specific Aleph VM
contract and workflow entrypoints.

The reusable rootfs builder scripts, guest bootstrap/configure logic, service
units, and shared deploy/publish runners now live in the standalone shared repo
and published packages:

- `NiKrause/shared-aleph-tooling`
- `@le-space/rootfs`
- `@le-space/node`

That means `universal-connectivity` no longer carries a second editable copy of
the guest/rootfs implementation. The remaining local responsibility here is the
`uc-go-peer` profile contract and the repo-specific workflow orchestration.

## What Still Lives In UC

- [root-profiles/uc-go-peer.json](./root-profiles/uc-go-peer.json)
  The UC-owned rootfs contract: profile id, executable path, services, exposed
  ports, and manifest metadata.
- [../../../.github/workflows/build-aleph-go-peer-rootfs.yml](../../../.github/workflows/build-aleph-go-peer-rootfs.yml)
  The manual CI entrypoint for Aleph rootfs build/publish/deploy runs.
- [../../../.github/workflows/uc-go-peer-rootfs-reusable.yml](../../../.github/workflows/uc-go-peer-rootfs-reusable.yml)
  The UC-specific workflow that coordinates rootfs build/publish, `js-peer`
  publish/rebuild, VM deploy, probing, domain linking, and retention cleanup.
- [../../../.github/actions/aleph-vm-deploy/action.yml](../../../.github/actions/aleph-vm-deploy/action.yml)
  Thin compatibility wrapper around the published shared deploy runner.

## What Moved To Shared Tooling

The following implementation is now owned by `shared-aleph-tooling` and consumed
through the published packages rather than kept as local source here:

- rootfs build orchestration
- qcow2 customization scripts
- guest bootstrap/configure/setup/describe logic
- AutoTLS refresh service behavior
- Aleph rootfs publish helpers
- VM deploy logic
- site publish / probe / bootstrap / domain-link helpers
- retention cleanup

For `uc-go-peer`, the shared rootfs assets are currently carried as the
reference profile at:

- `shared-aleph-tooling/packages/rootfs/reference/uc-go-peer`

## Current Runtime Model

The `uc-go-peer` contract still distinguishes between:

- support directory: `/opt/go-peer`
- executable path: `/usr/local/bin/universal-chat-go`

The published shared build path uses the UC contract plus the shared reference
rootfs assets to produce and optionally publish the Aleph VM image.

## Package-Based Workflow Path

`universal-connectivity` intentionally uses the shared-package approach instead
of a cross-repo reusable-workflow dependency.

In practice that means:

- UC keeps its own workflow structure
- the workflow installs `@le-space/node`
- the workflow calls shared runner modes like:
  - `runRootfsMode(...)`
  - `runSiteMode(...)`
  - `runActionMode(...)`

This keeps repo-local control over CI structure while centralizing the actual
Aleph/rootfs/deploy behavior in the shared package.

## Two-Pass Site Publish

When the workflow runs with both `publish=true` and `deploy_vm=true`, it does a
two-pass `js-peer` flow:

1. publish the rootfs and an initial `js-peer` site
2. deploy the VM
3. collect the final browser bootstrap multiaddrs from the guest
4. rebuild `js-peer` with `NEXT_PUBLIC_RELAY_LISTEN_ADDRS`
5. republish the site and optionally relink the production domain

## AutoTLS Note

AutoTLS is still an operational follow-up area.

The shared guest refresh service now retries after a failed wait window rather
than being permanently one-shot, but successful `*.libp2p.direct` address
publication still depends on upstream broker behavior and may lag behind a
successful VM deployment.
