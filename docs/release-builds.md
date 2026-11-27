# Versioned release builds

The **Versioned release builds** workflow builds the production Cloudflare
Worker on GitHub-hosted Linux, including the terminal WebAssembly and Theia
frontend. It checks types and runs Wrangler in dry-run mode. No deployment
credentials are required and no production service is changed.

Run the workflow manually for a candidate build. The initial
`codex/versioned-release-builds` branch also runs on pushes so this pipeline
can be validated before merging. Successful runs retain a Worker archive,
complete tracked source snapshot, build manifest and SHA-256 checksums as an
Actions artifact for 30 days.

Push a `v*` or `build-*` tag at the intended commit to retain the successful
artifacts in a draft GitHub prerelease. The workflow does not publish a stable
release or replace an existing release. A version identifies its exact Git
commit; it does not automatically bump every package in the repository.

Download all release assets into one directory and check `SHA256SUMS` before
extracting the `-cloudflare.tar.gz` archive. It contains `.output/` and
`.wrangler/deploy/config.json`, with a relative configuration path so it can
move between machines. The generated Worker configuration retains the domain,
API origin and public variables of the tagged source. Deployment credentials
and runtime secrets remain separate in Cloudflare.

This archive targets Cloudflare Workers. It is not the Bun desktop server,
an iOS app, or a Platinum native application. An accepted build/dry run does
not substitute for an authenticated browser smoke test after a later deploy.
