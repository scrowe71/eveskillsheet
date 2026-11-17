"""Rebuild data/skills.json and data/ships.json from public ESI.
Run after a game patch that adds skills or ships:  python tools/gen_data.py data
"""
import json, sys, urllib.request, concurrent.futures as cf, time
ESI = "https://esi.evetech.net/latest"
def get(path):
    for i in range(5):
        try:
            with urllib.request.urlopen(ESI + path, timeout=30) as r:
                return json.load(r)
        except Exception as e:
            err = e; time.sleep(1 + i)
    raise err
ATTR = {164: "cha", 165: "int", 166: "mem", 167: "per", 168: "wil"}
REQ = [(182, 277), (183, 278), (184, 279), (1285, 1286), (1289, 1287), (1290, 1288)]
def reqs(dogma):
    d = {a["attribute_id"]: a["value"] for a in dogma}
    out = []
    for s, l in REQ:
        if s in d and d[s] > 0:
            out.append([int(d[s]), int(d.get(l, 1))])
    return d, out

def category(cat):
    groups = get(f"/universe/categories/{cat}/")["groups"]
    with cf.ThreadPoolExecutor(16) as ex:
        gs = list(ex.map(lambda g: get(f"/universe/groups/{g}/"), groups))
    gs = [g for g in gs if g.get("published")]
    tids = [(g["group_id"], g["name"], t) for g in gs for t in g["types"]]
    with cf.ThreadPoolExecutor(24) as ex:
        types = list(ex.map(lambda x: (x[0], x[1], get(f"/universe/types/{x[2]}/")), tids))
    return [t for t in types if t[2].get("published")]

out = sys.argv[1]
skills = {}
for gid, gname, t in category(16):
    d, r = reqs(t.get("dogma_attributes", []))
    skills[t["type_id"]] = {
        "n": t["name"], "g": gname, "r": int(d.get(275, 1)),
        "p": ATTR.get(int(d.get(180, 0)), ""), "s": ATTR.get(int(d.get(181, 0)), ""),
        "q": r,
    }
ships = {}
for gid, gname, t in category(6):
    d, r = reqs(t.get("dogma_attributes", []))
    if not r: continue
    ships[t["type_id"]] = {"n": t["name"], "g": gname, "q": r}
json.dump(skills, open(f"{out}/skills.json", "w"), separators=(",", ":"))
json.dump(ships, open(f"{out}/ships.json", "w"), separators=(",", ":"))
print(len(skills), "skills", len(ships), "ships")
