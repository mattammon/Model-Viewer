import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../nwp_ingest/viewer/map.js", import.meta.url), "utf8");
const {gridContours, windBarbParts} = await import("data:text/javascript," + encodeURIComponent(source));

test("height contours interpolate crossings in metres", () => {
  const result = gridContours({
    latitude: [40, 42], longitude: [5, 7],
    values: [[5490, 5610], [5490, 5610]],
  });
  assert.deepEqual([...result], [
    [5520, [[[5.5, 40], [5.5, 42]]]],
    [5580, [[[6.5, 40], [6.5, 42]]]],
  ]);
});

test("height contours handle saddle cells and leave missing cells blank", () => {
  const coordinates = {latitude: [0, 1], longitude: [0, 1]};
  const saddle = gridContours({...coordinates, values: [[5660, 5630], [5630, 5660]]});
  assert.equal(saddle.get(5640).length, 2);
  assert.deepEqual(saddle.get(5640)[0].map(([x, y]) => [Math.round(x * 3), Math.round(y * 3)]), [[2, 0], [3, 1]]);
  assert.equal(gridContours({...coordinates, values: [[5660, null], [5630, 5660]]}).size, 0);
});

test("wind barbs round to five knots and use pennants, full and half feathers", () => {
  assert.deepEqual(windBarbParts(1), {pennants: 0, full: 0, half: false});
  assert.deepEqual(windBarbParts(3), {pennants: 0, full: 0, half: true});
  assert.deepEqual(windBarbParts(7.7), {pennants: 0, full: 1, half: true});
  assert.deepEqual(windBarbParts(33.5), {pennants: 1, full: 1, half: true});
});

test("temperature contours use Celsius even when the grid is in Kelvin", () => {
  const result = gridContours({
    latitude: [48, 49], longitude: [5, 6],
    values: [[272.15, 281.15], [272.15, 281.15]],
  }, 5, kelvin => kelvin - 273.15);
  assert.deepEqual([...result.keys()], [0, 5]);
});
