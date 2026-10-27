'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-pet-default-'));
process.env.CODEX_HOME = path.join(fixture, 'codex');
const { listPets } = require('../src/pets');
const { DEFAULTS } = require('../src/config');
test.after(() => fs.rmSync(fixture, { recursive: true, force: true }));

test('a fresh installation has a valid bundled Nailong as its default pet', () => {
  const pet = listPets().find((p) => p.id === DEFAULTS.petId);
  assert.ok(pet);
  assert.equal(pet.id, 'nailong');
  assert.equal(pet.source, 'bundled');
  assert.equal(pet.displayName, '奶龙');
  assert.deepEqual([pet.width, pet.height, pet.rows], [1536, 2288, 11]);
});

test('a user pet overrides the bundled pet with the same ID', () => {
  const dir = path.join(fixture, 'custom', 'nailong');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pet.json'), JSON.stringify({ id: 'nailong', displayName: '我的奶龙' }));
  fs.copyFileSync(path.join(__dirname, '../assets/pets/nailong/spritesheet.webp'), path.join(dir, 'spritesheet.webp'));
  const pets = listPets([{ dir: path.dirname(dir), source: 'custom' }]);
  assert.equal(pets.filter((p) => p.id === 'nailong').length, 1);
  assert.equal(pets.find((p) => p.id === 'nailong').displayName, '我的奶龙');
});
