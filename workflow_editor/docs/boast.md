# Boast (workflow_editor p12)

`boast/index.html` is the page displayed in the Project Editor's Boast area.
It can freely introduce the project's capabilities and outputs using HTML,
CSS and JavaScript. Related files can live in the same directory.

The rest of this file is optional technical reference: how WFE finds and
serves the page and what a page can use in the browser. Code:
`server/boast.ts`, `server/staticServe.ts`, `src/boastPanel.ts`.

## Paths and publication sources

| Source | State route | Content |
| --- | --- | --- |
| Published (default) | `GET api/boast/<project>` | `api/boast/<project>/c/<commit>/<path>` |
| A workspace's working tree (preview) | `GET api/boast/<project>?source=worktree&workspace=<id>` | `api/boast/<project>/w/<workspace>/<path>` |

- **Published** is the project root's default branch as read through the
  project access caches ([access.md](access.md)). The state route resolves
  the commit once; the page and every relative asset are served from that
  commit, so one view never mixes revisions. Content under a commit is
  immutable (`Cache-Control: immutable`, `ETag` = blob id). `?refresh=1`
  fetches now; otherwise a fetch younger than 10 s is reused. A Gitea that
  cannot be read leaves `provenance.fetch.state: stale` with its error.
- **Preview** is the working tree of one workspace on this host, ignored
  files excluded (they are never published). It is revalidated on every use.
  A workspace can lag behind or run ahead of `main`; a run's own copy is not
  a workspace and is not previewed here.
- **State.** `state: present | absent` with `commit`, `entry` (the page's
  URL relative to the service) and `provenance`. An absent page is a state;
  an unknown project, a missing revision or an unreadable Gitea is an error
  (`detail.state`: `absent`, `inaccessible`, `uninitialized`,
  `fetch-failed`, as in project access).
- A folder URL without its trailing slash is redirected to the slash form;
  a folder serves its `index.html`.
- WFE builds nothing. A prebuilt static application works when its files
  are in the folder and it uses relative URLs (`./assets/…`, Vite
  `base: './'`). An absolute path (`/assets/…`) leaves the content root.

## Boundaries

- Only `boast/` is served. Traversal is refused (400). A Git symbolic link
  is followed while its target stays inside `boast/`; a working-tree path is
  checked through `realpath`. Leaving the folder is 403.
- A submodule mounted under `boast/` is read at the commit the root pins.

## Browser capabilities

Every content response carries
`Content-Security-Policy: sandbox allow-scripts allow-popups
allow-popups-to-escape-sandbox allow-downloads allow-forms allow-modals
allow-pointer-lock` (flags Safari also accepts) and the
editor's iframe has the same `sandbox` attribute (plus `allow="fullscreen;
autoplay; clipboard-write"`). The page therefore runs in an opaque origin,
embedded or opened alone in a tab:

- scripts, module scripts (`Access-Control-Allow-Origin: *`), `fetch()` of
  the page's own files, forms, popups, `target="_blank"` links and
  downloads work;
- the page cannot read the editor's DOM, cookies or storage, and its
  requests to the editor's write API carry `Origin: null` and are refused;
- `localStorage`/IndexedDB are unavailable to an opaque origin;
- media answer byte ranges (`206`), so video seeking works.

## Shared areas

`GET api/share-ref?ref=shared://<share>/<path>` resolves a reference on
this host: `{ref, state, detail, url, download, host, path, folder}`.
`url` is the display route `api/shares/<share>/<path>?inline=1`: a file in
its own media type with byte ranges, a folder as a browsable listing, both
sandboxed like the page. `download` is the attachment route (a folder's is
its JSON listing). `path` is where the serving host has it. Payloads stay on the share, outside Git. These URLs do not
depend on a run's presentation server.

## Messages to the editor (optional)

A page may post messages to `window.parent`; nothing is required. Each
message is an object with `wfeBoast: 1` and a `type`. The editor accepts them
only from its own Boast frame and answers with `window.postMessage` to that
frame (target `*`; the frame's origin is opaque).

| `type` | Fields | Answer |
| --- | --- | --- |
| `height` | `height` (CSS px) | none; the frame takes that height (bounded) |
| `copy` | `text` (≤ 64 KiB), optional `id` | `{wfeBoast: 1, type: 'copy-result', id, ok, method}`; `method` is `clipboard`, `execCommand` or `manual` (the editor showed the text selected for the person to copy) |
| `resolve-shared` | `ref` (`shared://…`), optional `id` | `{wfeBoast: 1, type: 'resolve-shared-result', id, …}` with the fields of `api/share-ref`, `url`/`download` made absolute |

```js
parent.postMessage({ wfeBoast: 1, type: 'copy', id: 'p1', text: 'C:\\builds\\game.exe' }, '*')
addEventListener('message', e => { if (e.data?.wfeBoast && e.data.id === 'p1') console.log(e.data) })
```

The editor keeps the frame mounted across its own refreshes and mode
changes. When published content changes it offers a reload instead of
reloading; Reload re-reads the state and reloads the frame.
