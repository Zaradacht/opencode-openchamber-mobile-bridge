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
