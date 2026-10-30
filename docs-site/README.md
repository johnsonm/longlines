# Long Lines documentation site

The user documentation for Long Lines and Long Lines Relay, built with
[Starlight](https://starlight.astro.build) (Astro). It imports nothing from the app.

```sh
npm ci          # once, and after package-lock.json changes
npm run dev     # http://localhost:4321
npm run build   # static site in dist/
```

Pushes to main deploy it to https://docs.longlines.io through
`.github/workflows/deploy-docs.yml`.
