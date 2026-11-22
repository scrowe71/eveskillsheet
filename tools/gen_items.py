"""Build data/items.json: every fittable item's skill requirements, for the Fits page.
Covers modules & rigs (7), charges (8), drones (18), implants & boosters (20), subsystems (32), fighters (87).
Run after a patch that adds items:  python tools/gen_items.py data
Output: {"Item Name": [typeId, categoryCode, [[skillId, level], ...]], ...}
categoryCode: m=module/rig, c=charge, d=drone, i=implant, b=booster, s=subsystem, f=fighter
"""
import json, sys, time, urllib.request, concurrent.futures as cf
ESI = "https://esi.evetech.net/latest"
CATS = {7: "m", 8: "c", 18: "d", 20: "i", 32: "s", 87: "f"}
REQ = [(182, 277), (183, 278), (184, 279), (1285, 1286), (1289, 1287), (1290, 1288)]
def get(path):
    for i in range(6):
        try:
            with urllib.request.urlopen(ESI + path, timeout=30) as r:
                return json.load(r)
        except Exception as e:
            err = e; time.sleep(1 + i * 2)
    raise err
out = sys.argv[1]
items = {}
for cat, code in CATS.items():
    groups = get(f"/universe/categories/{cat}/")["groups"]
    with cf.ThreadPoolExecutor(16) as ex:
        gs = [g for g in ex.map(lambda g: get(f"/universe/groups/{g}/"), groups) if g.get("published")]
    tids = [t for g in gs for t in g["types"]]
    booster_types = {t for g in gs if "booster" in g["name"].lower() for t in g["types"]}
    with cf.ThreadPoolExecutor(32) as ex:
        types = list(ex.map(lambda t: get(f"/universe/types/{t}/"), tids))
    for t in types:
        if not t.get("published"):
            continue
        d = {a["attribute_id"]: a["value"] for a in t.get("dogma_attributes", [])}
        reqs = [[int(d[s]), int(d.get(l, 1))] for s, l in REQ if s in d and d[s] > 0]
        items[t["name"]] = [t["type_id"], "b" if t["type_id"] in booster_types else code, reqs]
    print(cat, code, len(types), flush=True)
json.dump(items, open(f"{out}/items.json", "w"), separators=(",", ":"))
print(len(items), "items")
