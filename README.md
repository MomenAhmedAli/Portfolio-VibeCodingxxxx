# Moamen — Product & UX Designer Portfolio

## Run Locally

Requires Node.js 20+:

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Production Build

```bash
npm run build
npm run preview
```

## Deploy to GitHub Pages

This project uses Vite + TypeScript, so it must be built (`dist/`) rather than served from raw source `index.html`:

1. Push this repository to GitHub on the `main` branch.
2. Go to **Settings -> Pages -> Build and deployment -> Source** and select **GitHub Actions**.
3. The included `.github/workflows/deploy.yml` workflow will build `dist/` and publish the live site automatically.
