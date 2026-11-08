// Photos the person has attached but not sent yet. The server keeps each one until it is sent or deleted, so
// this tracks every upload (including ones still in flight) and makes sure a photo that is removed, replaced
// or abandoned is deleted on the server as soon as its id is known. `api` needs uploadPhoto(file) and
// deletePhoto(id); deletion failures are ignored (the server also sweeps unsent photos after about an hour).
export function createStagedPhotos({ api }) {
  let items = [];
  const quietDelete = (id) => Promise.resolve(api.deletePhoto(id)).catch(() => {});

  return {
    // Starts the upload. `extra` is copied onto the entry (e.g. a preview url). `settled` resolves to
    // 'ready', 'removed' (discarded while uploading; the staged file is deleted) or 'failed'; it never rejects.
    add(file, extra = {}) {
      const entry = { id: null, removed: false, ...extra };
      items.push(entry);
      const settled = Promise.resolve()
        .then(() => api.uploadPhoto(file))
        .then(
          (r) => {
            if (entry.removed) {
              quietDelete(r?.photoId);
              return 'removed';
            }
            entry.id = r.photoId;
            return 'ready';
          },
          (error) => {
            items = items.filter((i) => i !== entry);
            entry.error = error;
            return entry.removed ? 'removed' : 'failed';
          },
        );
      return { entry, settled };
    },
    // The person took the photo off the message. Deleted now if the id is known, else when the upload ends.
    remove(entry) {
      items = items.filter((i) => i !== entry);
      if (entry.removed) return;
      entry.removed = true;
      if (entry.id) quietDelete(entry.id);
    },
    count: () => items.length,
    hasPending: () => items.some((i) => !i.id),
    ready: () => items.filter((i) => i.id),
    entries: () => [...items],
    // Hand the ready photos to a message and forget everything: a sent photo is never deleted from here.
    takeForSend() {
      const ids = items.filter((i) => i.id).map((i) => i.id);
      items = [];
      return ids;
    },
    // The page is going away: delete what is staged (via `remove`, e.g. a keepalive request) and make any
    // upload still in flight delete itself on arrival. Best effort.
    discardAll(remove = quietDelete) {
      for (const entry of items) {
        entry.removed = true;
        if (entry.id) Promise.resolve(remove(entry.id)).catch(() => {});
      }
      items = [];
    },
  };
}
