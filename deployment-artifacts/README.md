# Stable application update feed

This deployment-only branch provides a complete application feed for the stable
instance. Read `stable-application.json` for the published version and commit. The
default formal release feed currently resolves to the older image-only
`v0.2.86`, which cannot be applied by the in-container application updater.

`stable-application.json` preserves the deployed application identity, runtime
contract, migration policy and verified archive checksum. Its source-SHA-named
archive is stored as an additional asset on the existing release. That release
is an archive storage location; its tag, version and formal manifest are not
changed. No new SemVer release is created.

The manual workflow accepts a tested source ref, a successful Platform images
run ID and the successful full Release build check run ID for that source SHA.
It verifies all 14 effective CI checks (including reruns), then packages the
immutable image outputs with the official extractor and migration policy checks.
It uploads the archive to a durable HTTPS address and verifies an anonymous
download by size and SHA-256 before advancing the feed. It never replaces an
existing archive or formal release manifest. This feed supports Linux x64;
other architectures still require their own verified application bundles.

Save the raw HTTPS URL of `stable-application.json` through platform settings,
then run `check_updates` and verify the reported source and preflight. Changing
the source does not update, downgrade, restart or migrate the application. This
feed advances only through that verified publication workflow. Future code changes
must be tested and published before advancing it. The ordinary formal release workflow
on main already packages application archives for new releases.
