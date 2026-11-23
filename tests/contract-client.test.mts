// Every `client`, `choose`, `source`, `drop_words` and `refusal_json` case of contract/cases.json against client/box.mjs: plan() for the box calls,
// imagePlan() for `box image push`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const { plan, imagePlan, choose, source, removedWords, refusalLine } = await import(path.join(REPO, "client/box.mjs"));
const all = JSON.parse(readFileSync(path.join(REPO, "contract/cases.json"), "utf8"));

for (const c of all.client) {
  test(c.name, () => {
    if (c.image_args) {
      const p = imagePlan(c.image_args);
      if (c.exit) { assert.equal(p.exit, c.exit); assert.equal(p.has, undefined); return; }
      assert.deepEqual([p.host, p.has, p.load], [c.image_host, c.image_has, c.image_load]);
      return;
    }
    const p = plan(c.toplevel, c.flags ?? [], c.argv);
    if (c.remote === null) {
      assert.equal(p.exit, c.exit);
      assert.equal(p.remote, undefined);
    } else {
      assert.equal(p.box, c.box);
      assert.equal(p.remote, c.remote);
    }
  });
}

// The choice is a pure function of what the hosts reported (the `pod status` line as the server prints it) and the request.
for (const c of all.choose) {
  test(`choose: ${c.name}`, () => {
    const r = choose(c.hosts, c.request);
    if (c.refusal) {
      assert.deepEqual(r.refusal, c.refusal);
      assert.equal(r.host, undefined);
    } else {
      assert.equal(r.host, c.chosen);
      assert.equal(r.reason, c.reason);
    }
  });
}

for (const c of all.source) {
  test(`source: ${c.name}`, () => {
    const r = source(c.flag, c.env, c.placed, c.registered);
    assert.equal(r.how, c.how);
    if (c.how !== "choose") { assert.equal(r.host, c.host); assert.equal(r.record, c.record); }
  });
}

// What the client says of a removed box's real need, a pure function of the server's `pod drop` answer.
for (const c of all.drop_words) test(`drop words: ${c.name}`, () => assert.equal(removedWords(c.answer), c.words));

// The machine readable refusal (BOXD_REFUSAL_JSON=1): a pure function of the hosts the client holds facts about, from the choice a request got (choose) or as given.
for (const c of all.refusal_json) {
  test(`refusal json: ${c.name}`, () => {
    const r = c.given ? c.given : choose(c.hosts, c.request);
    assert.equal(r.refusal === undefined && !c.given, false, "the case must be a refusal");
    assert.equal(refusalLine(r.hosts, c.text, r.waitable ?? r.wait), c.line);
  });
}
