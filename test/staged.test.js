import test from 'node:test';
import assert from 'node:assert/strict';
import { createStagedPhotos } from '../public/js/staged.js';

function fakeApi({ failUpload = false } = {}) {
  const calls = { deleted: [], uploads: [] };
  let n = 0;
  const pending = [];
  return {
    calls,
    pending,
    uploadPhoto: (file) =>
      new Promise((resolve, reject) => {
        calls.uploads.push(file);
        const id = `id${++n}`;
        pending.push(() => (failUpload ? reject(new Error('net')) : resolve({ photoId: id })));
      }),
    deletePhoto: async (id) => {
      calls.deleted.push(id);
    },
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('a photo removed after its upload finished is deleted at once and leaves the list', async () => {
  const api = fakeApi();
  const s = createStagedPhotos({ api });
  const { entry, settled } = s.add('f1');
  await tick();
  api.pending[0]();
  assert.equal(await settled, 'ready');
  assert.deepEqual(
    s.ready().map((e) => e.id),
    ['id1'],
  );
  s.remove(entry);
  await tick();
  assert.deepEqual(api.calls.deleted, ['id1']);
  assert.deepEqual(s.ready(), []);
  assert.equal(s.count(), 0);
});

test('a photo removed during its upload is deleted when the response arrives and never becomes ready', async () => {
  const api = fakeApi();
  const s = createStagedPhotos({ api });
  const { entry, settled } = s.add('f1');
  await tick();
  s.remove(entry);
  assert.deepEqual(api.calls.deleted, [], 'no id yet');
  assert.equal(s.hasPending(), false, 'a removed photo no longer blocks sending');
  api.pending[0]();
  assert.equal(await settled, 'removed');
  await tick();
  assert.deepEqual(api.calls.deleted, ['id1']);
  assert.deepEqual(s.ready(), []);
  assert.equal(entry.id, null, 'the chip never gets an id');
});

test('removing and then failing the upload deletes nothing and does not throw', async () => {
  const api = fakeApi({ failUpload: true });
  const s = createStagedPhotos({ api });
  const { entry, settled } = s.add('f1');
  await tick();
  s.remove(entry);
  api.pending[0]();
  assert.equal(await settled, 'removed');
  assert.deepEqual(api.calls.deleted, []);
  const second = s.add('f2');
  await tick();
  api.pending[1]();
  assert.equal(await second.settled, 'failed');
  assert.equal(s.count(), 0);
});

test('a failed delete is swallowed', async () => {
  const api = fakeApi();
  api.deletePhoto = async () => {
    throw new Error('offline');
  };
  const s = createStagedPhotos({ api });
  const { entry, settled } = s.add('f1');
  await tick();
  api.pending[0]();
  await settled;
  assert.doesNotThrow(() => s.remove(entry));
  await tick();
});

test('sending hands over the ready ids and forgets them so they are never discarded afterwards', async () => {
  const api = fakeApi();
  const s = createStagedPhotos({ api });
  const a = s.add('a');
  const b = s.add('b');
  await tick();
  api.pending[0]();
  await a.settled;
  assert.equal(s.hasPending(), true);
  api.pending[1]();
  await b.settled;
  assert.deepEqual(s.takeForSend(), ['id1', 'id2']);
  assert.equal(s.count(), 0);
  const sent = [];
  s.discardAll((id) => sent.push(id));
  assert.deepEqual(sent, []);
  assert.deepEqual(api.calls.deleted, []);
});

test('discarding on page exit deletes staged ids and the one still uploading deletes itself on arrival', async () => {
  const api = fakeApi();
  const s = createStagedPhotos({ api });
  const a = s.add('a');
  const b = s.add('b');
  await tick();
  api.pending[0]();
  await a.settled;
  const viaKeepalive = [];
  s.discardAll((id) => viaKeepalive.push(id));
  assert.deepEqual(viaKeepalive, ['id1']);
  assert.equal(s.count(), 0);
  api.pending[1]();
  assert.equal(await b.settled, 'removed');
  await tick();
  assert.deepEqual(api.calls.deleted, ['id2']);
});

test('a photo still uploading when a message is taken for sending is deleted once it lands', async () => {
  const api = fakeApi();
  const s = createStagedPhotos({ api });
  const sent = s.add('sent');
  const inFlight = s.add('late');
  await tick();
  api.pending[0]();
  assert.equal(await sent.settled, 'ready');
  const ids = s.takeForSend();
  assert.deepEqual(ids, ['id1'], 'only the finished photo goes with the message');
  api.pending[1]();
  assert.equal(await inFlight.settled, 'removed');
  await tick();
  assert.deepEqual(api.calls.deleted, ['id2'], 'the late upload is deleted; the sent one is not');
  assert.equal(s.count(), 0);
});
