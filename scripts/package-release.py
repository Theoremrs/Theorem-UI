#!/usr/bin/env python3
"""Archive the generated Worker and its relative deploy config, without secrets."""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import tarfile
from pathlib import Path


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    os.chdir(root)
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    if os.environ.get("GITHUB_SHA", revision) != revision:
        raise SystemExit("The checked-out commit does not match the workflow source.")
    version = (
        os.environ["GITHUB_REF_NAME"]
        if os.environ.get("GITHUB_REF_TYPE") == "tag"
        else f"snapshot-{revision[:12]}"
    )
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+-]{0,100}", version):
        raise SystemExit("Release tag must be a safe version name.")
    output = root / ".output"
    deploy_file = root / ".wrangler/deploy/config.json"
    if not (output / "server").is_dir() or not (output / "public").is_dir():
        raise SystemExit("Build the complete Cloudflare Worker before packaging.")
    deploy = json.loads(deploy_file.read_text())
    raw_config = deploy.get("configPath")
    if not isinstance(raw_config, str) or not raw_config:
        raise SystemExit("Generated deploy config has no configPath.")
    config = (deploy_file.parent / raw_config).resolve()
    if not config.is_file() or not config.is_relative_to(output):
        raise SystemExit("Deploy config must point to a generated file inside .output.")
    # Nitro may emit an absolute path. Keep the downloaded archive relocatable.
    deploy["configPath"] = os.path.relpath(config, deploy_file.parent)
    deploy_file.write_text(json.dumps(deploy, indent=2) + "\n")
    for path in output.rglob("*"):
        if path.is_symlink() and not path.resolve().is_relative_to(output):
            raise SystemExit(f"Build depends on a file outside its output: {path.relative_to(root)}")
    assets = root / "release-assets"
    assets.mkdir(exist_ok=True)
    archive = assets / f"theorem-ui-{version}-cloudflare.tar.gz"
    with tarfile.open(archive, "w:gz") as package:
        package.add(output, arcname=".output")
        package.add(deploy_file, arcname=".wrangler/deploy/config.json")
    with (assets / f"theorem-ui-{version}-source.tar.gz").open("wb") as source:
        subprocess.run(
            ["git", "archive", "--format=tar.gz", f"--prefix=theorem-ui-{version}/", revision],
            stdout=source,
            check=True,
        )
    metadata = {
        "schema_version": 1,
        "repository": os.environ.get("GITHUB_REPOSITORY", "Theoremrs/Theorem-UI"),
        "source_commit": revision,
        "release_version": version,
        "workflow_run": os.environ.get("GITHUB_RUN_ID"),
        "artifact_kind": "cloudflare-worker",
        "deploy_config": config.relative_to(root).as_posix(),
        "deployment_performed": False,
    }
    (assets / "build-manifest.json").write_text(json.dumps(metadata, indent=2) + "\n")
    (assets / "RELEASE-NOTES.md").write_text(
        f"Built from `{metadata['repository']}@{revision}`.\n\n"
        "Contains the Cloudflare Worker, browser assets, production Theia frontend, "
        "terminal WebAssembly, and generated deploy config in one archive. "
        "The separate source archive contains tracked source only.\n\n"
        "No Cloudflare deployment, Fly deployment, runtime credentials or database data "
        "are included. Restore secrets in the destination account separately. "
        "The Worker configuration retains the source revision's domain and backend URLs.\n\n"
        "Checks cover the production build, TypeScript and a Wrangler dry run. "
        "They do not establish authenticated live application behavior.\n"
    )
    files = sorted(path for path in assets.iterdir() if path.is_file() and path.name != "SHA256SUMS")
    if any(path.is_symlink() or path.stat().st_size == 0 for path in files):
        raise SystemExit("Refusing empty or symlinked release assets.")
    with (assets / "SHA256SUMS").open("w") as checksums:
        for path in files:
            with path.open("rb") as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            checksums.write(f"{digest}  {path.name}\n")
    print(f"Prepared {len(files)} assets for {version} from {revision}.")


if __name__ == "__main__":
    main()
