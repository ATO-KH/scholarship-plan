// Retire the former persistent sandbox worker. The demo now runs in-tab.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => {
  indexedDB.deleteDatabase("ato-scholarship-pages-v1");
  event.waitUntil(self.registration.unregister());
});
