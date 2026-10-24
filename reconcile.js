// Payment reconciliation.
//
// Reads payments.jsonl and works out how much money we actually collected.
//
// Run:  node reconcile.js

const fs = require("fs");

// ---------- helpers ----------

// Some amounts in the export are formatted strings ("55,707.77", "4,804.15"),
// so strip everything except digits, the decimal point and a minus sign.
// Amounts are converted to kobo (integers) so the sum doesn't drift the way
// adding floats like 0.1 + 0.2 does.
function toKobo(amount) {
  if (typeof amount === "number") {
    return Number.isFinite(amount) ? Math.round(amount * 100) : NaN;
  }
  if (typeof amount !== "string") return NaN;
  const cleaned = amount.replace(/[^0-9.\-]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return NaN;
  return Math.round(Number(cleaned) * 100);
}

// The export isn't sorted by time, so "latest" has to come from ts rather
// than line order. If two attempts share a ts (or one can't be parsed),
// the one further down the file wins.
function isLater(a, b) {
  if (!Number.isNaN(a.ts) && !Number.isNaN(b.ts) && a.ts !== b.ts) return a.ts > b.ts;
  return a.order > b.order;
}

function bump(obj, key) {
  obj[key] = (obj[key] || 0) + 1;
}

// ---------- read + keep the latest attempt per txn_id ----------

const lines = fs.readFileSync("payments.jsonl", "utf8").split(/\r?\n/);

const latest = new Map();
const stats = {
  unreadable: 0,
  missingTxnId: 0,
  unreadableTs: [],
  statuses: {},
  currencies: {},
};

lines.forEach((line, i) => {
  if (line.trim() === "") return;

  // Skip lines that aren't valid JSON objects instead of crashing.
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    stats.unreadable += 1;
    return;
  }
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    stats.unreadable += 1;
    return;
  }

  // Events without a txn_id can't be matched to a payment, so they're ignored.
  if (event.txn_id === undefined || event.txn_id === null || event.txn_id === "") {
    stats.missingTxnId += 1;
    return;
  }

  const ts = Date.parse(event.ts);
  if (Number.isNaN(ts)) stats.unreadableTs.push(i + 1);

  bump(stats.statuses, String(event.status));
  bump(stats.currencies, String(event.currency));

  const current = {
    txnId: event.txn_id,
    ts,
    status: event.status,
    kobo: toKobo(event.amount),
    rawAmount: event.amount,
    line: i + 1,
    order: i,
  };

  const previous = latest.get(event.txn_id);
  if (!previous || isLater(current, previous)) latest.set(event.txn_id, current);
});

// ---------- total up collected payments ----------

let totalKobo = 0;
let count = 0;
const badAmounts = [];

for (const event of latest.values()) {
  if (event.status !== "success") continue;
  count += 1;
  if (Number.isNaN(event.kobo)) {
    badAmounts.push(`line ${event.line}: ${JSON.stringify(event.rawAmount)}`);
  } else {
    totalKobo += event.kobo;
  }
}

// Summing was done in kobo; convert back to naira for the result.
const totalNaira = totalKobo / 100;

// ---------- diagnostics ----------

console.log("--- Diagnostics ---");
console.log(`Unreadable lines skipped:      ${stats.unreadable}`);
console.log(`Events without txn_id skipped: ${stats.missingTxnId}`);
console.log(`Unique txn_ids:                ${latest.size}`);
console.log(`Status values seen:            ${JSON.stringify(stats.statuses)}`);
console.log(`Currency values seen:          ${JSON.stringify(stats.currencies)}`);
if (stats.unreadableTs.length) {
  console.log(`WARNING: unreadable ts on lines ${stats.unreadableTs.join(", ")} (fell back to file order)`);
}
if (badAmounts.length) {
  console.log(`WARNING: unreadable amounts on successful payments:\n  ${badAmounts.join("\n  ")}`);
}
console.log(`Total collected:               ₦${totalNaira.toFixed(2)}`);
console.log("-------------------\n");

// ---------- self-check ----------

const expected = parseInt(fs.readFileSync("expected.txt", "utf8").trim(), 10);

if (count !== expected) {
  console.log(`Check failed: counted ${count} successful payments, expected ${expected}.`);
  console.log("Something in the data isn't being handled the way the README describes.");
} else if (badAmounts.length) {
  console.log(`Count matches (${count}), but some amounts couldn't be read, so the total is incomplete.`);
} else {
  console.log(`Check passed: ${count} successful payments.`);
  console.log(`Your code: KOYA-${Math.round(totalNaira)}`);
}
