# Vendored: JSON schemas of Make's Apps Editor for VS Code

These files are unchanged copies from Make's own VS Code extension "Make Apps Editor"
(Marketplace id `Integromat.apps-sdk`), public repository https://github.com/integromat/vscode-apps-sdk,
MIT licence (`LICENSE.md` here, copied from the same commit).

- Commit: `6ff5f3dd9960ccbeb24de3beb1cca935de89eaa0` (master, 2026-10-08; the latest release tag is 2.9.0)
- `imljson/*.json` = `syntaxes/imljson/schemas/*.json`: the schemas the extension checks IMLJSON code
  files against (its `package.json` `contributes.jsonValidation` maps file names to them).
- `local-development/makecomapp.schema.json` = `syntaxes/local-development/schemas/makecomapp.schema.json`:
  the schema of the local project file `makecomapp.json`.

`test/schemas.test.ts` validates every file of `app/` against them, the way the extension does in the
editor. To update: copy the same paths from a newer commit, note it above, and run `npm test`.
