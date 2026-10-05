# Tasks

## 1. Manifest

- [x] 1.1 Manifest helper: bounded read through the existing skill file reader,
      `size` and `sha256:<hex>` from the served bytes, file and total-size limits.
- [x] 1.2 Name validation: directory name equals frontmatter `name`, `description`
      present; diagnostics for anything omitted.

## 2. Serving

- [x] 2.1 `skill://` resources in `listResources` / `readResource`, scope-checked
      on every request; existing `trellis://` resources and tools unchanged.
- [x] 2.2 `skills/list` and `skills/get` handlers with cache fields and `-32602`.
- [x] 2.3 Do not declare the extension on the current protocol revision.

## 3. Documentation

- [x] 3.1 Document the shape, the digest-is-not-trust note, the declaration gate,
      and the upstream-relay constraints in docs.

## 4. Verification

- [x] 4.1 Unit tests: resources, manifest-vs-content equality, refused files,
      oversized skill, name mismatch, scope enforcement, `skills/*` shapes and
      errors, no declaration, existing tools unchanged.
- [x] 4.2 Full test suite, typecheck, build, package verification.
