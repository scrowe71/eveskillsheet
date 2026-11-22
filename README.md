# EveSkillsheet

Track which ships each of your EVE Online characters can fly, plus their skills, queues and clones, all in one place.

- **Private.** The app runs in your browser and logs in with EVE SSO using PKCE, so there is no client secret. Tokens and cached data stay in this browser (localStorage).
- **Main + alts.** Log in with your main first, then **Add character** for each alt. EVE makes every character approve access once. After that they all live under one page.
- **Ships view (the home page):** a grid of every hull against every character. A cell shows ✓ if that character can fly the hull now, or how long they need to train. Click a time to see the exact missing skills, including prerequisite chains, with SP and training time.
  - Filter by **★ Watchlist**, someone can fly, someone within 7 days, all hulls or nobody can fly. Also filter by **race** (Amarr, Caldari, Gallente, Minmatar, Triglavian, ORE, pirate/faction…) and by **class**.
  - Click ☆ on any ship to add it to your watchlist.
- **Fits:** paste a ship fit in EFT format (EVE's fitting window → Copy to clipboard, Pyfa or zKillboard) and see which of your characters can fly it.
  - Every pilot gets a status: can fly it, can fly the hull only, or can't fly the hull, plus the time to finish.
  - For the selected pilot, every module, rig, subsystem, drone and loaded charge is marked ✓ or ✗, with the skills each ✗ is missing, and there's a full training order with prerequisites first.
  - Implants and boosters are recognised too. Drones, loaded ammo, and implants & boosters each have a switch to leave them out of the check. Cargo is never checked.
  - **Copy missing skills** copies the training list. **Make skill plan** turns the fit into a skill plan: hull and modules as Required; drones, ammo, implants and boosters as Recommended.
  - Fits are saved in this browser. Item requirements come from `data/items.json`, built by `python tools/gen_items.py data`.
- **Skill plans:**
  - Each entry is a skill and level marked **Required** or **Recommended**. You can mark them per level, so `Drones IV` can be required and `Drones V` recommended.
  - Build a plan in the editor:
    - Add skills one at a time, using a skill-name picker.
    - Paste a list, one per line. Headings like `Required:` / `Recommended:` and markers like `Drones V (recommended)` are understood.
    - Or load an EVEMon `.emp` / `.xml` file, where priority 1 = required and anything else = recommended.
    - Change any entry's level and priority, reorder entries, or remove them. Plans are saved in this browser.
  - Compare against any character:
    - Time to finish the required skills and time to finish everything, shown separately.
    - Every missing level in training order: required skills (and their prerequisites) first, then recommended ones.
    - Switch between **Required only** and **Required + recommended**.
  - Exports follow the switch you picked: **Copy missing skills** (one `Skill Name IV` per line), **Download .txt** or **Download .csv** (the .csv includes a priority column). **Copy plan** copies the whole plan with its Required/Recommended headings, so you can paste it into another browser.
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
