## Why

Publishing a skill library meant selecting forty files or a folder on the admin's own
machine. Skill libraries already live in git repositories; a link should be enough.

## What Changes

- **Import from a repository URL**: the admin pastes a GitHub, GitLab or Codeberg link
  (repository, `/tree/` folder, or `/blob/` file; browser URL or `git@host:owner/repo`)
  and the page lists every skill in it for review. Nothing is written by the read; the
  admin ticks, renames or skips rows and the chosen ones go through the existing bulk
  import (`POST /api/skills/bulk`).
- Which files are skills: `SKILL.md` per folder (the folder name is the slug), or a loose
  `.md` file; a README, `references/*.md` or other markdown beside a `SKILL.md` is
  supporting material, and repository documents at the top level (README, LICENSE,
  CHANGELOG…) are not skills.
- Public repositories only: a token that can read arbitrary repositories is a far larger
  permission than publishing skills, and the admin can always paste a file.
- Bounded: ≤100 files per import, 512 KB each, 8 reads in flight; a listing the host cut
  short (very large repository) is reported instead of hidden.

## Capabilities

### Modified Capabilities
- `customer-skills`: import from a repository URL.

## Impact

- `src/lib/skills/repoImport.js`, `src/app/api/skills/import-repo/route.js`
- `src/app/(dashboard)/dashboard/customer-skills/{RepoImportModal,SkillsAdminPageClient}.js`
- `test/skill-repo-import.test.js`
