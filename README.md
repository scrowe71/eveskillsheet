# EveSkillsheet

Skills for all your EVE Online characters in one place, with optional read-only share links (handy for character sales).

- **Private by default.** The app runs in your browser and logs in with EVE SSO using PKCE, so there is no client secret. Tokens and cached data stay in this browser (localStorage).
- **Main + alts.** Log in with your main first, then **Add character** for each alt. EVE makes every character approve access once. After that they all live under one page.
- **All characters view:** total SP, unallocated SP, what each character is training, when each queue ends, and a warning for empty or nearly-finished queues.
- **Character sheet tabs:**
  - **Skills:** every skill grouped and searchable, with level bars that also show queued and Alpha-limited levels.
  - **Skill queue:** live countdowns.
  - **Ships:** every hull the character can fly. For the rest, it lists the missing skills, including prerequisite chains, plus the SP and training time needed.
  - **Attributes & remaps.**
  - **Clones & implants:** jump clones and their locations, and when the next clone jump is available.
- **Share sheet:** publishes one character to a private link like `https://skillsheet.crankyape.space/s/AbC123xyz789`. The server checks the EVE login token's signature with CCP and pulls the data from ESI itself, so the person sharing can't edit what viewers see. You choose whether to include the queue, attributes and clones (clones reveal locations, so they're off by default). Shared sheets refresh on their own, at most hourly, whenever you click Refresh in the app. **Stop sharing** deletes the sheet.

## Setup

### 1. Register the EVE application
1. Go to https://developers.eveonline.com/applications and create an application named **EveSkillsheet**.
2. Connection type: **Authentication & API Access**.
3. Scopes:
   - `esi-skills.read_skills.v1`
   - `esi-skills.read_skillqueue.v1`
   - `esi-clones.read_clones.v1`
   - `esi-clones.read_implants.v1`
   - `esi-universe.read_structures.v1`
4. Callback URL: `https://skillsheet.crankyape.space/` (**with the trailing slash**).
5. Copy the **Client ID** into `config.js`. The secret key is not used, so never put it in this repo.

### 2. Create the D1 database (for share links)
1. In the Cloudflare dashboard, go to **Storage & Databases → D1 → Create database** and name it `eveskillsheet`.
2. Open it, go to **Console**, paste the contents of `schema.sql`, and click **Execute**.

### 3. Deploy on Cloudflare Pages
1. Go to **Workers & Pages → Create → Pages → Connect to Git** and pick this repo.
   - Framework preset: **None**
   - Build command: *(leave empty)*
   - Build output directory: `/`
2. After the first deploy, open the Pages project and go to **Settings → Bindings → Add → D1 database**:
   - Variable name: `DB`
   - Database: `eveskillsheet`
3. In **Settings → Variables and Secrets**, add a plain-text variable `CLIENT_ID` set to the same Client ID. The share server then only accepts logins made through your app.
4. **Custom domains → Set up a custom domain →** `skillsheet.crankyape.space`.
5. Go to **Deployments** and **Retry deployment** so the binding and variable take effect.

Without the D1 binding, the private app still works fully. Only **Share sheet** will say sharing isn't set up.

## Notes
- ESI only updates a character's skill list when that character logs in. Queue entries whose finish time has passed are counted as trained, so the sheet stays accurate between logins.
- Removing a character only clears it from this browser. To fully revoke access, also remove the app at https://community.eveonline.com/support/third-party-applications/. Stop sharing *before* removing a character, because deleting a sheet needs that character's login.
- `data/skills.json` and `data/ships.json` come from ESI. After a patch that adds skills or ships, run `python tools/gen_data.py data` and commit.

## Files
| File | Purpose |
| --- | --- |
| `index.html`, `app.js`, `styles.css`, `config.js` | The private app: logins, refresh, all-characters view, share dialog |
| `sheet.html`, `sheet.js` | Public read-only sheet at `/s/<link>` |
| `shared/snapshot.js` | Pulls one character from ESI (used by the app **and** the server) |
| `shared/render.js`, `shared/lib.js` | Sheet tabs and the skill, ship and queue math |
| `functions/api/sheets/…` | Pages Functions: publish, status, read and delete shared sheets |
| `functions/s/[slug].js` | Serves the sheet page for share links |
| `server/` | Token verification against CCP's signing keys, plus server-side ESI calls |
| `schema.sql` | D1 table |
| `_headers` | Security headers (CSP) |
