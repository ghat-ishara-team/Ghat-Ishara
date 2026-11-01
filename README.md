# GHAT ISHARA

An experimental landslide susceptibility website for Pune, Raigad, Ratnagiri and Satara. The public website, four district maps and numerical score inspection work without Supabase configuration. Scores are static, uncalibrated susceptibility estimates, not event probabilities or operational warnings.

## Clone and run the website

Requires Git, Node.js 22.12+ and npm 10+, internet access and space for dependencies plus at least 600 MB for map download, staging and build copies. Run these commands in bash:

```bash
GIT_LFS_SKIP_SMUDGE=1 git clone --branch feature/website https://github.com/shiragave2omkar-hub/Ghat-Ishara.git
cd Ghat-Ishara/frontend
npm ci
npm run setup:maps
npm run dev
```

Open **http://127.0.0.1:5173/**, or the address Vite prints. LFS skipping avoids unnecessary ML dataset downloads; do not run `git lfs pull` for website setup. `setup:maps` independently downloads the pinned public GitHub Release archive and verifies it before installation. No Python, original rasters, model execution, GitHub token or Supabase `.env.local` is required for public use. The external basemap requires internet access.

## Optional official login

Local Supabase login has been tested with the correct ignored `frontend/.env.local`, a running local stack and a provisioned official account. Each teammate needs their own local stack and matching public URL/key: `localhost` and `127.0.0.1` refer to the computer running the browser, not another teammate's machine. **Hosted Supabase authentication has not yet been finalized; a shared hosted login is not ready for onboarding.**

Follow [the complete clone, local login and troubleshooting guide](frontend/CLONE_AND_RUN.md). Keep keys and passwords out of Git; only a publishable or legacy anon key belongs in browser configuration. Account provisioning is an operator task, separate from cloning the website.

See [frontend/README.md](frontend/README.md) for frontend checks and [frontend/MAP_RELEASE.md](frontend/MAP_RELEASE.md) for the pinned map archive and download safeguards. ML source files remain under `ml/` and are not needed to run the website.
