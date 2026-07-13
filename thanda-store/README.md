# Thanda Store application

This is the Next.js application for the Thanda Store dealer portal.

The complete architecture, environment setup, operational runbook, synchronization commands, product rules, authentication model, image-thumbnail behaviour, and deployment instructions live in the repository [README](../README.md).

## Local development

```bash
npm install
npm run dev
```

Before committing application changes:

```bash
npm run lint
npx tsc --noEmit
npm run build
```

The production build must also be run on the VPS before restarting PM2.
