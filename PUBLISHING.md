# Publishing

1. Run validation:

```bash
node --check index.js
node --check bin/opencode-openchamber-mobile-bridge.mjs
node -e "import('./index.js').then(m => console.log(m.id))"
npm pack --dry-run
```

2. Confirm no private values are present:

```bash
grep -R "replace-with-private-value" .
```

3. Publish when ready:

```bash
npm whoami
npm publish
```

If the first publish returns `E404 Not Found ... you do not have permission`, refresh npm auth and retry:

```bash
npm login --auth-type=web
npm whoami
npm publish --access public
```

For first-time unscoped packages, this usually means the active npm session cannot create the package name, not that the tarball is missing.
