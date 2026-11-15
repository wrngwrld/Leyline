# Release notes

When preparing a release, write notes for Leyline users, not a recap of developer commits.

- Review all changes since the previous release and group related changes by user-facing feature, not by commit.
- Lead with the most useful new capabilities, then list improvements, fixes, and security or compatibility changes where applicable. Omit empty sections.
- Explain the user-visible benefit in plain language. Avoid implementation details, raw commit subjects, and internal work such as scripts, benchmarks, version bumps, or documentation-only changes.
- Keep each bullet concise and combine several commits that describe the same change.
- Include the correct installer names and any current signing or first-launch guidance. Do not claim a platform or capability is supported unless verified.
- Keep the generated notes from `scripts/release-notes.mjs` accurate; update its curated summaries when needed, and inspect the rendered notes before publishing.
