import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMaintenanceStatus } from './maintenance.ts';

test('normalizeMaintenanceStatus defaults to inactive with the default message when given nothing', () => {
  assert.deepEqual(normalizeMaintenanceStatus(null), { active: false, message: "We're making some backend changes — back shortly." });
  assert.deepEqual(normalizeMaintenanceStatus(undefined), { active: false, message: "We're making some backend changes — back shortly." });
});

test('normalizeMaintenanceStatus preserves a real message and active:true', () => {
  const result = normalizeMaintenanceStatus({ active: true, message: 'Back in 15 minutes.' });
  assert.deepEqual(result, { active: true, message: 'Back in 15 minutes.' });
});

test('normalizeMaintenanceStatus falls back to the default message when given a blank one', () => {
  const result = normalizeMaintenanceStatus({ active: true, message: '   ' });
  assert.equal(result.message, "We're making some backend changes — back shortly.");
});

test('normalizeMaintenanceStatus truncates an excessively long message', () => {
  const result = normalizeMaintenanceStatus({ active: true, message: 'x'.repeat(1000) });
  assert.equal(result.message.length, 500);
});

test('normalizeMaintenanceStatus coerces a non-boolean active value', () => {
  assert.equal(normalizeMaintenanceStatus({ active: 'yes' }).active, true);
  assert.equal(normalizeMaintenanceStatus({ active: 0 }).active, false);
});
