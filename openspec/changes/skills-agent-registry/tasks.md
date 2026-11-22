## 1. Registry and storage

- [x] 1.1 `runtimes.js`: 26-agent registry, `runtimeSkillsDir`, `isEveryRuntime`, `storedRuntimes`
- [x] 1.2 `skillsRepo`: store "all" as `[]`, expose `allAgents`, keep `target = generic`
- [x] 1.3 Schema v47 and migration 007 (guarded for databases without `targets`)
- [x] 1.4 Catalogue sends `all` ← (verify: a skill saved for all agents still covers an agent added later)

## 2. Installer

- [x] 2.1 Generate the id list and `home_for` / `dir_for` from the registry with strict pattern checks
- [x] 2.2 Shared folder written once; canonical copy plus links for several folders; `--copy`; real folders updated in place; link failure falls back to a copy
- [x] 2.3 `--target` accepts every id; `all` accepted from the catalogue; picker and list show "mọi agent"
- [x] 2.4 Tests: omp/dsh folders and `DSH_HOME`, shared folder, links, `--copy`, in-place update, all-agents skill, dash ← (verify: nothing is written for an agent the machine lacks; no real folder is replaced by a link)

## 3. Pages

- [x] 3.1 Admin `RuntimePicker`: "Mọi agent" / "Chọn agent"; list shows "Mọi agent"
- [x] 3.2 Customer card: "Mọi agent" or tags, one path chosen from a list; copy updated for the new agents

## 4. Checks

- [ ] 4.1 `npm test`, eslint on touched files, `next build`
