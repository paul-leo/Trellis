# Design

The importer remains source-read-only and keeps one BackupSession. Each
canonical/secret-policy/local-secret write must check its result; a failed
standalone import finalizes the manifest so the user can run the normal
rollback command.

`mcp-remote` is converted only for the verified Basic Authorization shape and
known argument set. Unsupported extra arguments remain conflicts. Missing
absolute paths are skipped as unavailable source entries.

The package-owned `trellis-runtime` Skill is refreshed by a dedicated CLI
command through the same backup writer used by other canonical writes. Native
symlinks and Runtime providers consume the updated canonical file without
per-Agent edits.
