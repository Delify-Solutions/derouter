## 1. Reading a repository

- [x] 1.1 `parseRepoUrl`: browser, `/tree/`, `/blob/`, scp-style and nested GitLab groups; owner and repo validated as plain names; malformed escapes are an error
- [x] 1.2 `fetchTree` / `fetchFile` for GitHub, GitLab, Codeberg with timeouts, encoded paths and an `incomplete` flag
- [x] 1.3 `pickSkillPaths`, `slugFromRepoPath`, `describeSkillFile` ← (verify: supporting files never become skills; a crafted URL cannot reach another API path)

## 2. Endpoint and page

- [x] 2.1 `POST /api/skills/import-repo`: preview only, admin-guarded, bounded reads, readable errors for 404 / 403 / 429 / timeout
- [x] 2.2 `RepoImportModal`: read, review, rename or skip, then bulk import

## 3. Checks

- [x] 3.1 `test/skill-repo-import.test.js`, eslint, `next build`, full `npm test` (1601/1601)
