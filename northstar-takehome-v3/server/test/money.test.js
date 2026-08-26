import test from "node:test";
import assert from "node:assert/strict";
import { decimalStringToCents, centsToDisplay } from "../src/money.js";

// Integer-cents parsing sidesteps the float-drift the starter script was exposed
// to (NOTES.md defect #9): 0.1 + 0.2 !== 0.3 in native float, but 10 + 20 === 30 in
// integer cents.
test("decimal strings parse to exact integer cents", () => {
  assert.equal(decimalStringToCents("96.00"), 9600);
  assert.equal(decimalStringToCents("0.10"), 10);
  assert.equal(decimalStringToCents("0.20"), 20);
  assert.equal(decimalStringToCents("0.10") + decimalStringToCents("0.20"), decimalStringToCents("0.30"));
});

test("cents render back to a fixed 2-decimal display string", () => {
  assert.equal(centsToDisplay(9600), "96.00");
  assert.equal(centsToDisplay(30), "0.30");
  assert.equal(centsToDisplay(-500), "-5.00");
});
