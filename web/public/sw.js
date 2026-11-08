// Minimal service worker: makes the web app installable and shows push notifications.
// It deliberately doesn't cache API traffic; the app needs a live hub anyway.
const SHELL = "crosstalk-shell-v1";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(["./", "./index.html", "./icon.svg"])).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname.startsWith("/api/")) return;
  // Network first for the app shell so updates show up immediately; fall back to cache offline.
  if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request).catch(() => caches.match("./index.html")));
  }
});

// The hub sends payload-less pushes; fetch the text using our subscription endpoint as the key. Every notification
// waiting for this device comes, each with its own text and tag, so two sent close together both show (an approval
// isn't lost to a "finished" right after it). When an earlier push already took them, the newest shows again: its tag
// is the same, so it only replaces itself, and a push always shows something.
async function notesFor(e) {
  if (e.data) {
    try {
      return [e.data.json()];
    } catch {
      return [{ title: "Crosstalk", body: e.data.text() }];
    }
  }
  try {
    const sub = await self.registration.pushManager.getSubscription();
    if (sub) {
      const res = await fetch(new URL("api/push/notes", self.registration.scope), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      });
      if (res.ok) {
        const { notes, latest } = await res.json();
        if (Array.isArray(notes) && notes.length) return notes;
        if (latest) return [latest];
      }
      // An older hub: only its latest notification.
      const old = await fetch(new URL("api/push/latest?endpoint=" + encodeURIComponent(sub.endpoint), self.registration.scope));
      if (old.ok) return [await old.json()];
    }
  } catch {
    // fall through to a generic notification
  }
  return [{ title: "Crosstalk", body: "Something needs your attention." }];
}

self.addEventListener("push", (e) => {
  e.waitUntil(
    notesFor(e).then((notes) =>
      Promise.all(
        notes.map((data) =>
          self.registration.showNotification(data.title || "Crosstalk", {
            body: data.body || "",
            tag: data.tag,
            icon: "./icon-192.png",
            badge: "./icon-192.png",
            data: { url: new URL(data.url || "./", self.registration.scope).href },
          }),
        ),
      ),
    ),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = e.notification.data?.url || "./";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) {
          c.navigate(target).catch(() => {});
          return c.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
