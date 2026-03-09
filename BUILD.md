# Windows Packaging Guide

## Development
- Install dependencies: `npm install`
- Run development mode: `npm run dev`

## Build Production Assets
- Build renderer + Electron main + backend server: `npm run build`

## Create Windows Installer (NSIS)
- Build and generate installer: `npm run dist:win`
- Optional unpacked app folder only: `npm run pack:win`

Installer/output files are written to the `release` directory.
Typical installer file:
- `release/AI-Meeting-Assistance-Setup-<version>.exe`

## Run Production App Locally (without Vite)
- Start built app from source tree: `npm run start:prod`
- In packaged mode, Electron starts the local Express backend automatically.

## API Key Behavior
- If `OPENAI_API_KEY` exists in environment, it is used.
- If not, the app supports entering a key in **Settings / About / Legal**.
- The key entered in-app is stored locally in browser storage and applied on startup.

## Branding / Legal Text Location
The About/Legal content is shown in the Settings modal in:
- `src/App.tsx`

Current required text includes:
- Built by Ahan Bhatt
- Contact: bhattahan@gmail.com
- Website: https://ahanbhatt.github.io/Personal-Website/
- Responsible-use disclaimer

## App/Installer Branding Configuration
- Electron-builder config is in `package.json` under the `build` field.
- Product name, app id, NSIS options, and installer naming are configured there.
- Windows icon path is configured as:
  - `build/icon.ico`

Replace `build/icon.ico` with your final brand icon before release.

## Website Publishing
1. Run `npm run dist:win`.
2. Upload the generated `.exe` installer from the `release` directory to your website.
3. Point your website download button/link to that installer file.

## Quick Smoke Test Checklist
1. Install from the generated `.exe`.
2. Launch from Start Menu and confirm app window opens.
3. Open Settings, add API key (if not set via env).
4. Select a source, run Capture -> Stop + Answer.
5. Confirm transcript + answer appear.
6. Confirm sticky-note popout and global shortcut still work.
7. Uninstall from Windows Apps settings and confirm app is removed.
