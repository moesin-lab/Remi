# Stable application update feed

This deployment-only branch provides a complete application feed for the stable
instance running `277a43bef475b690b13d713cd9175222095f2767` (`0.2.88`). The
default formal release feed currently resolves to the older image-only
`v0.2.86`, which cannot be applied by the in-container application updater.

`stable-application.json` preserves the deployed application identity, runtime
contract, migration policy and verified archive checksum. Its source-SHA-named
archive is stored as an additional asset on the existing release. That release
is an archive storage location; its tag, version and formal manifest are not
changed. No new SemVer release is created.

The manual workflow verifies all 14 completed CI checks for the application SHA,
copies the exact public registry archive to that durable HTTPS download address,
and verifies an anonymous download by size and SHA-256. It never replaces an
existing archive or formal release manifest. This feed supports Linux x64;
other architectures still require their own verified application bundles.

Save the raw HTTPS URL of `stable-application.json` through platform settings,
then run `check_updates` and verify the reported source and preflight. Changing
the source does not update, downgrade, restart or migrate the application. This
feed is pinned to the verified stable deployment; future code changes must be
tested and published before advancing it. The ordinary formal release workflow
on main already packages application archives for new releases.
