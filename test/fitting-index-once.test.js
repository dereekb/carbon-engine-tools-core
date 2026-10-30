import assert from "node:assert/strict";
import test from "node:test";

import { CjsToolFitting } from "../src/fitting/CjsToolFitting.js";

// A fit resolves every name through one index of the whole `types` table. A
// burst of parses on a cold build used to start one walk of the table each,
// and on a service that answers one request at a time those walks interleave
// page by page until none of them finishes. These tests hold the fitting to
// one walk per index, however many callers arrive while it runs.

const TABLES = {
    types: [
        { id: "587", payload: { name: { en: "Rifter" }, groupID: 25, published: true } },
        { id: "2873", payload: { name: { en: "125mm Gatling AutoCannon II" }, groupID: 55, published: true } },
        { id: "5973", payload: { name: { en: "5MN Cold-Gas Enduring Microwarpdrive" }, groupID: 46, published: true } },
    ],
    groups: [
        { id: "25", payload: { categoryID: 6 } },
        { id: "55", payload: { categoryID: 7 } },
        { id: "46", payload: { categoryID: 7 } },
    ],
    dogmaEffects: [
        { id: "12", payload: { name: "hiPower" } },
        { id: "13", payload: { name: "medPower" } },
    ],
    typeDogma: [
        { id: "2873", payload: { dogmaEffects: [ { effectID: 12 } ] } },
        { id: "5973", payload: { dogmaEffects: [ { effectID: 13 } ] } },
    ],
};

/** An exact-build source over `TABLES` that counts each walk it starts. */
function CountingSource({ failFirstWalkOf = null } = {})
{
    const walks = new Map();
    let failed = false;

    return {
        walks,
        source: {
            target: "eve",
            provider: "test",
            build: 1,
            Table: name => ({
                async List({ limit, offset })
                {
                    if (offset === 0) walks.set(name, (walks.get(name) ?? 0) + 1);

                    // Yield like a real page read, so concurrent callers overlap.
                    await new Promise(resolve => setImmediate(resolve));

                    if (name === failFirstWalkOf && !failed)
                    {
                        failed = true;
                        throw new Error(`${name} is not readable yet`);
                    }

                    return TABLES[name].slice(offset, offset + limit);
                },
                async Get(id)
                {
                    await new Promise(resolve => setImmediate(resolve));

                    return TABLES[name].find(record => record.id === String(id)) ?? null;
                },
            }),
        },
    };
}

test("a burst of name lookups on a cold build walks types once", async () =>
{
    const { source, walks } = CountingSource();
    const fitting = new CjsToolFitting(source);
    const names = [ "Rifter", "125mm Gatling AutoCannon II", "5MN Cold-Gas Enduring Microwarpdrive" ];

    const resolved = await Promise.all(Array.from({ length: 30 }, (_, index) => fitting.Resolve(names[index % names.length])));

    assert.deepEqual(resolved.slice(0, 3).map(entry => entry.typeID), [ 587, 2873, 5973 ]);
    assert.equal(walks.get("types"), 1);

    await fitting.Resolve("Rifter");
    assert.equal(walks.get("types"), 1, "a later lookup reads the held index");
});

test("a burst of classifications walks groups and dogmaEffects once", async () =>
{
    const { source, walks } = CountingSource();
    const fitting = new CjsToolFitting(source);

    const classified = await Promise.all([ 2873, 5973, 587, 2873, 5973 ].map(typeID => fitting.Classify(typeID)));

    assert.deepEqual(classified.map(entry => entry.slot), [ "high", "medium", null, "high", "medium" ]);
    assert.equal(walks.get("groups"), 1);
    assert.equal(walks.get("dogmaEffects"), 1);
});

test("a failed walk is forgotten, so the next lookup reads again", async () =>
{
    const { source, walks } = CountingSource({ failFirstWalkOf: "types" });
    const fitting = new CjsToolFitting(source);

    const first = await Promise.allSettled([ fitting.Resolve("Rifter"), fitting.Resolve("Rifter") ]);

    assert.deepEqual(first.map(entry => entry.status), [ "rejected", "rejected" ]);
    assert.equal(walks.get("types"), 1, "callers during the failed walk share it");

    assert.equal((await fitting.Resolve("Rifter")).typeID, 587);
    assert.equal(walks.get("types"), 2);
});
