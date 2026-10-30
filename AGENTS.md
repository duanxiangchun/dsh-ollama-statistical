# Agent / release conventions

## GitHub push + tag（默认约定）

- 每次把版本变更推送到 GitHub（`master`）时，**默认同时创建并推送对应的 annotated tag**：
  `v<package.json 的 version>`（例如 `v0.9.4`）。
- 推送前先检查该 tag 是否已存在；已存在则复用，不要重复创建，也不要在同一版本上移动已有 tag。
- 推荐命令：
  ```bash
  git push origin master
  git tag -a vX.Y.Z -m "vX.Y.Z"
  git push origin vX.Y.Z
  ```
  或 `git push origin master vX.Y.Z`。
- 只改文档 / CI / 测试且 `package.json` 版本不变时，可只推 `master`；若该版本还没有 tag，仍应补推 tag。
- 推 `v*` tag 会触发 `.github/workflows/publish.yml`：校验 tag 与 package 版本一致、跑测试、`npm publish --provenance` 并创建 GitHub Release。npm 侧可能需要 2FA 或 Staged publish 审批。
- 除非用户明确说“不要打 tag / 不要发布”，否则默认按上述流程操作。
