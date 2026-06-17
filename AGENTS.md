# AGENTS

## Purpose

This repository packages a generic OpenChamber mobile-access bridge for OpenCode/devcontainer workflows.

## Key files

- `index.js`: minimal OpenCode plugin entrypoint.
- `bin/opencode-openchamber-mobile-bridge.mjs`: host-side CLI.
- `examples/openchamber-mobile-bridge.json`: placeholder config template.
- `package.json`: npm/OpenCode plugin metadata.

## Privacy rules

- Keep the package public and generic.
- Do not commit private project names, customer names, domains, tailnet hostnames, local absolute workspace paths, tokens, or passwords.
- Example values must remain placeholders such as `/path/to/project` and `example-project`.
- User config belongs outside the repo, normally under `~/.config/opencode/`.

## Compatibility rules

- Keep `package.json` installable as a normal npm package.
- Preserve `type: "module"`, `exports`, `bin`, and `oc-plugin` metadata.
- Keep the plugin dependency-free unless a real portability need appears.
- Keep OpenCode plugin behavior minimal; host orchestration belongs in the CLI.

## Testing

Minimum checks after edits:

1. `node --check index.js`
2. `node --check bin/opencode-openchamber-mobile-bridge.mjs`
3. `node -e "import('./index.js').then(m => console.log(m.id))"`
4. `node bin/opencode-openchamber-mobile-bridge.mjs --help`
5. `npm pack --dry-run`

For runtime changes, test with a disposable local devcontainer and placeholder config.
