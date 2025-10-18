import { EditorState, Transaction, Plugin, PluginKey } from "prosemirror-state"
import { Decoration, DecorationSet, EditorView } from "prosemirror-view"
import { exampleSetup } from "prosemirror-example-setup"
import {
  syncPlugin,
  basicSchemaAdapter,
  pmDocFromSpans,
  pmRangeToAmRange,
} from "@automerge/prosemirror"
import { DocHandle, Repo, isValidAutomergeUrl } from "@automerge/automerge-repo"
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb"
import { BrowserWebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket"
import { next as am } from "@automerge/automerge"
import "prosemirror-example-setup/style/style.css"
import "prosemirror-menu/style/menu.css"
import "prosemirror-view/style/prosemirror.css"

type AutomergePath = Array<string | number>
type SharedDoc = { text: string; actorIds?: string[] }

type ColorPluginOptions<T> = {
  adapter: typeof basicSchemaAdapter
  handle: DocHandle<T>
  path: AutomergePath
}

const userColorPluginKey = new PluginKey<DecorationSet>("user-color-highlights")

const createUserColorPlugin = <T>({
  adapter,
  handle,
  path,
}: ColorPluginOptions<T>) =>
  new Plugin<DecorationSet>({
    key: userColorPluginKey,
    state: {
      init: (_, state) =>
        buildActorDecorations({
          adapter,
          handle,
          path,
          state,
        }),
      apply(tr, prev, _oldState, newState) {
        if (!tr.docChanged) {
          return prev
        }
        return buildActorDecorations({
          adapter,
          handle,
          path,
          state: newState,
        })
      },
    },
    props: {
      decorations(state) {
        return this.getState(state) ?? DecorationSet.empty
      },
    },
  })

const buildActorDecorations = <T>({
  adapter,
  handle,
  path,
  state,
}: {
  adapter: typeof basicSchemaAdapter
  handle: DocHandle<T>
  path: AutomergePath
  state: EditorState
}): DecorationSet => {
  const doc = handle.doc() as am.Doc<T> | undefined

  if (!doc) {
    return DecorationSet.empty
  }

  const spans = am.spans(doc, path)
  const decorations: Decoration[] = []
  const actorSource =
    ((doc as unknown as SharedDoc).actorIds as string[] | undefined) ?? []

  state.doc.descendants((node, pos) => {
    if (!node.isText || node.text == null || node.text.length === 0) {
      return
    }

    const range = pmRangeToAmRange(adapter, spans, {
      from: pos,
      to: pos + node.nodeSize,
    })

    if (!range) {
      return
    }

    const maxLength = Math.min(
      node.text.length,
      Math.max(range.end - range.start, 0),
    )

    if (maxLength === 0) {
      return
    }

    let runActor: string | null = null
    let runStartOffset = 0

    for (let offset = 0; offset < maxLength; offset++) {
      const amIndex = range.start + offset
      if (amIndex < 0 || amIndex >= actorSource.length) {
        continue
      }
      const actorId = actorSource[amIndex] ?? "unknown"

      if (runActor == null) {
        runActor = actorId
        runStartOffset = offset
        continue
      }

      if (actorId !== runActor) {
        const from = pos + runStartOffset
        const to = pos + offset
        if (from < to) {
          decorations.push(makeActorDecoration(from, to, runActor))
        }
        runActor = actorId
        runStartOffset = offset
      }
    }

    if (runActor != null) {
      const from = pos + runStartOffset
      const to = pos + maxLength
      if (from < to) {
        decorations.push(makeActorDecoration(from, to, runActor))
      }
    }
  })

  return decorations.length > 0
    ? DecorationSet.create(state.doc, decorations)
    : DecorationSet.empty
}

const makeActorDecoration = (from: number, to: number, actorId: string) => {
  const { background, border } = colorsForActor(actorId)
  const style = [
    `background-color: ${background}`,
    `border-bottom: 2px solid ${border}`,
    "border-radius: 2px",
    "box-decoration-break: clone",
    "padding-bottom: 1px",
  ].join("; ")

  return Decoration.inline(from, to, {
    class: "actor-highlight",
    "data-actor": actorId,
    style,
  })
}

const colorsForActor = (actorId: string) => {
  const hue = hashString(actorId) % 360
  return {
    background: `hsla(${hue}, 85%, 88%, 0.9)`,
    border: `hsla(${hue}, 70%, 45%, 0.85)`,
  }
}

const hashString = (value: string) => {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = (hash << 5) - hash + value.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash)
}

const ensureStyleSheet = () => {
  if (document.getElementById("actor-highlight-styles")) {
    return
  }
  const style = document.createElement("style")
  style.id = "actor-highlight-styles"
  style.textContent = `
.actor-highlight {
  position: relative;
}
.actor-highlight[data-actor="unknown"] {
  background-color: rgba(128, 128, 128, 0.2) !important;
  border-bottom-color: rgba(128, 128, 128, 0.4) !important;
}`
  document.head.append(style)
}

ensureStyleSheet()

const initializeActorTracking = (
  handle: DocHandle<SharedDoc>,
  actorId: string,
) => {
  const syncHandle = handle as DocHandle<SharedDoc> & {
    change: (fn: (doc: SharedDoc) => void) => void
  }

  const originalChange = syncHandle.change.bind(syncHandle)

  const ensureActorList = (doc: SharedDoc) => {
    const text = doc.text ?? ""
    if (!Array.isArray(doc.actorIds)) {
      doc.actorIds = new Array(text.length).fill("unknown")
      return
    }
    if (doc.actorIds.length !== text.length) {
      if (doc.actorIds.length < text.length) {
        const toAdd = text.length - doc.actorIds.length
        doc.actorIds.push(...new Array(toAdd).fill("unknown"))
      } else if (doc.actorIds.length > text.length) {
        doc.actorIds.splice(text.length)
      }
    }
  }

  const applyActorDiff = (
    doc: SharedDoc,
    beforeText: string,
    afterText: string,
  ) => {
    const actorIds = doc.actorIds
    if (!Array.isArray(actorIds)) return
    if (beforeText === afterText) return

    let prefix = 0
    while (
      prefix < beforeText.length &&
      prefix < afterText.length &&
      beforeText[prefix] === afterText[prefix]
    ) {
      prefix++
    }

    let beforeSuffix = beforeText.length
    let afterSuffix = afterText.length
    while (
      beforeSuffix > prefix &&
      afterSuffix > prefix &&
      beforeText[beforeSuffix - 1] === afterText[afterSuffix - 1]
    ) {
      beforeSuffix--
      afterSuffix--
    }

    const deleteCount = beforeSuffix - prefix
    if (deleteCount > 0) {
      actorIds.splice(prefix, deleteCount)
    }

    const insertLength = afterSuffix - prefix
    if (insertLength > 0) {
      const actorsToInsert = new Array(insertLength).fill(actorId)
      actorIds.splice(prefix, 0, ...actorsToInsert)
    }

    if (actorIds.length !== afterText.length) {
      if (actorIds.length < afterText.length) {
        const toAdd = afterText.length - actorIds.length
        actorIds.push(...new Array(toAdd).fill("unknown"))
      } else {
        actorIds.splice(afterText.length)
      }
    }
  }

  syncHandle.change = (fn: (doc: SharedDoc) => void) => {
    originalChange(doc => {
      ensureActorList(doc)
      const beforeText = doc.text ?? ""
      fn(doc)
      const afterText = doc.text ?? ""
      ensureActorList(doc)
      applyActorDiff(doc, beforeText, afterText)
    })
  }

  const currentDoc = handle.doc() ?? { text: "" }
  if (
    !Array.isArray(currentDoc.actorIds) ||
    currentDoc.actorIds.length !== (currentDoc.text ?? "").length
  ) {
    originalChange(doc => {
      const text = doc.text ?? ""
      doc.actorIds = new Array(text.length).fill("unknown")
    })
  }
}

const repo = new Repo({
  storage: new IndexedDBStorageAdapter("automerge"),
  network: [new BrowserWebSocketClientAdapter("wss://sync.automerge.org")],
})

// The document we're going to edit
let handle: DocHandle<SharedDoc>

// Get the document ID from the URL fragment if it's there. Otherwise, create
// a new document and update the URL fragment to match.
const docUrl = window.location.hash.slice(1)
if (docUrl && isValidAutomergeUrl(docUrl)) {
  handle = await repo.find(docUrl)
} else {
  handle = repo.create({ text: "" })
  window.location.hash = handle.url
}
await handle.whenReady()

const adapter = basicSchemaAdapter

const localActorId = repo.peerId ?? `local-${Math.random().toString(36).slice(2)}`
initializeActorTracking(handle as DocHandle<SharedDoc>, localActorId)

const initialDoc = handle.doc() as am.Doc<SharedDoc>

const view = new EditorView(document.querySelector("#editor"), {
  state: EditorState.create({
    doc: pmDocFromSpans(adapter, am.spans(initialDoc, ["text"])),
    plugins: [
      ...exampleSetup({ schema: adapter.schema }),
      syncPlugin({ adapter, handle, path: ["text"] }),
      createUserColorPlugin({ adapter, handle, path: ["text"] }),
    ],
  }),
  dispatchTransaction: (tx: Transaction) => {
    view.updateState(view.state.apply(tx))
  },
})
