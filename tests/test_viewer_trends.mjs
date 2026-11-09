import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../nwp_ingest/viewer/trend.js", import.meta.url), "utf8");
const {availableValidTimes, framesAt, validTime} = await import("data:text/javascript," + encodeURIComponent(source));

const runs = [
  {cycle: "20261109T00Z", compiled_leads: [0, 6]},
  {cycle: "20261108T18Z", compiled_leads: [6]},
  {cycle: "20261108T12Z", compiled_leads: [18]},
  {cycle: "20261108T06Z", compiled_leads: []},
];

test("run frames use exact UTC valid times across midnight and skip unavailable leads", () => {
  const valid = validTime("20261109T00Z", 0);
  assert.equal(valid, Date.parse("2026-11-09T00:00:00Z"));
  assert.deepEqual(framesAt(runs, valid), [
    {cycle: "20261108T18Z", lead: 6},
    {cycle: "20261109T00Z", lead: 0},
  ]);
  assert.deepEqual(framesAt(runs, valid + 1800000), []);
  assert.deepEqual(framesAt(runs, null), []);
});

test("the time selector counts matching runs at each compiled valid time", () => {
  assert.deepEqual(availableValidTimes(runs), [
    [Date.parse("2026-11-09T00:00:00Z"), 2],
    [Date.parse("2026-11-09T06:00:00Z"), 2],
  ]);
});
