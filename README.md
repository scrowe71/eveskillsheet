# EveSkillsheet

Track which ships each of your EVE Online characters can fly, plus their skills, queues and clones, all in one place.

- **Private.** The app runs in your browser and logs in with EVE SSO using PKCE, so there is no client secret. Tokens and cached data stay in this browser (localStorage).
- **Main + alts.** Log in with your main first, then **Add character** for each alt. EVE makes every character approve access once. After that they all live under one page.
- **Ships view (the home page):** a grid of every hull against every character. A cell shows ✓ if that character can fly the hull now, or how long they need to train. Click a time to see the exact missing skills, including prerequisite chains, with SP and training time.
  - Filter by **★ Watchlist**, someone can fly, someone within 7 days, all hulls or nobody can fly. Also filter by **race** (Amarr, Caldari, Gallente, Minmatar, Triglavian, ORE, pirate/faction…) and by **class**.
  - Click ☆ on any ship to add it to your watchlist.
- **Skill plans:**
  - Paste a plan, one skill per line (`Drones V`, `Gallente Cruiser 4`), or load an EVEMon `.emp` / `.xml` file. Plans are saved in this browser.
  - Pick a character to see how far along they are, plus every missing level in training order. Prerequisites that aren't in the plan are added first and flagged. Each level shows SP and training time, and there's a running total.
  - Export the missing list three ways: **Copy missing skills** (one `Skill Name IV` per line), **Download .txt** or **Download .csv**. **Copy plan** copies the whole plan so you can paste it on another device.
- **All characters view:** total and unallocated SP, hulls each character can fly, what each is training, and when each queue ends. Empty or nearly-finished queues are flagged.
- **Character sheet tabs:**
  - **Ships** (opens first): grouped by class or race, with the same filters and watchlist.
  - **Skills:** grouped and searchable, with level bars that also show queued and Alpha-limited levels.
  - **Skill queue:** live countdowns.
  - **Attributes & remaps.**
  - **Clones & implants:** jump clones and their locations, and when the next clone jump is available.
- **Optional share links** (off by default): set `sharing: true` in `config.js` and set up D1 (step 2 below). This lets you publish a read-only sheet for one character, for example to sell it. The server checks the EVE login token's signature with CCP and pulls the data from ESI itself, so the sheet can't be edited by the person sharing it.

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

### 2. Create the D1 database (only if you turn sharing on)
1. In the Cloudflare dashboard, go to **Storage & Databases → D1 → Create database** and name it `eveskillsheet`.
2. Open it, go to **Console**, paste the contents of `schema.sql`, and click **Execute**.

### 3. Deploy on Cloudflare Pages
1. Go to **Workers & Pages → Create → Pages → Connect to Git** and pick this repo.
   - Framework preset: **None**
   - Build command: *(leave empty)*
   - Build output directory: `/`
2. *(Sharing only)* After the first deploy, open the Pages project and go to **Settings → Bindings → Add → D1 database**:
   - Variable name: `DB`
   - Database: `eveskillsheet`
3. *(Sharing only)* In **Settings → Variables and Secrets**, add a plain-text variable `CLIENT_ID` set to the same Client ID. The share server then only accepts logins made through your app.
4. **Custom domains → Set up a custom domain →** `skillsheet.crankyape.space`.
5. If you added the binding, go to **Deployments** and **Retry deployment** so it takes effect.

With sharing off, you don't need D1 at all. The server code sits unused.

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
