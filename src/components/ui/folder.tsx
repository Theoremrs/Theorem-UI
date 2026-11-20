// SOURCING: translated from the 21st.dev Folder component by Ravi Katiyar (https://21st.dev/@ravikatiyar162/components/folder, registry item ravikatiyar162/folder, source sha256 e2cf6ca497775020; ledger row in docs/plans/evidence/ledger.md). Kept: its five layers (the back with its tab and notch, three sheets, the front with its own tab and notch), each turning back on rotateX from its bottom edge under a 1500px perspective by the source's angles (-20, -30, -38, -46 degrees) over 300ms, and the front's inset glow. Changed: scaled from 240x160 to a 26x19 sidebar tile (half the first tile's size after the owner's review on 2026-11-16, then a fifth smaller in the next), the tabs sized in the source's proportions of the folder (a third, and 61%); amber and zinc replaced by the palette's folder colour (--color-folder, the same colour every folder mark in the app takes) softened toward its raised surface, so a tile follows the theme in every palette and carries the same weight as a document tile; the hover also answers keyboard focus on the tile's link; reduced motion keeps the tile still. DocumentTile is this app's companion for a pinned session: the same sheets, fanned the same way, without the folder.
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * The tile's colours. The folder and the document carry the same weight on
 * the panel (owner's review, 2026-11-16): the folder's colour is softened
 * toward the panel, and the document's page is paper that stands off the
 * panel in either theme, its sheets stepping toward the ink behind it.
 */
const FOLDER_COLOURS =
  '[--folder-back:color-mix(in_oklab,var(--color-folder)_52%,var(--color-raised))] [--folder-front:color-mix(in_oklab,var(--color-folder)_68%,var(--color-raised))] [--folder-light:color-mix(in_oklab,var(--color-folder)_62%,white)] [--sheet-1:var(--color-raised)] [--sheet-2:color-mix(in_oklab,var(--color-raised)_88%,var(--color-ink))] [--sheet-3:color-mix(in_oklab,var(--color-raised)_76%,var(--color-ink))]'
const DOCUMENT_COLOURS =
  '[--sheet-1:var(--color-raised)] [--sheet-2:color-mix(in_oklab,var(--color-raised)_80%,var(--color-ink))] [--sheet-3:color-mix(in_oklab,var(--color-raised)_66%,var(--color-ink))] [--page-edge:color-mix(in_oklab,var(--color-ink)_22%,transparent)] dark:[--sheet-1:color-mix(in_oklab,var(--color-ink)_74%,var(--color-raised))] dark:[--sheet-2:color-mix(in_oklab,var(--color-ink)_50%,var(--color-raised))] dark:[--sheet-3:color-mix(in_oklab,var(--color-ink)_34%,var(--color-raised))] dark:[--page-edge:transparent]'

const LAYER =
  'absolute inset-[2px] rounded-sm transition-transform duration-300 ease-out origin-bottom'

/**
 * A folder that opens a little under the pointer or keyboard focus on the
 * link around it (a `group`). Drawn only; the link carries the name.
 */
export function FolderTile({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      data-folder-tile=""
      className={cn(
        FOLDER_COLOURS,
        'relative mx-auto h-[19px] w-[26px] origin-bottom [perspective:1500px]',
        className,
      )}
    >
      {/* The back, its tab on the left and the notch where the tab meets it. */}
      <div className="relative size-full origin-top rounded-md rounded-tl-none bg-(--folder-back) transition-shadow duration-300 ease-out group-hover:shadow-[0_3px_6px_rgba(0,0,0,.2)] group-focus-visible:shadow-[0_3px_6px_rgba(0,0,0,.2)] after:absolute after:bottom-[99%] after:left-0 after:h-1 after:w-1/3 after:rounded-t-sm after:bg-(--folder-back) after:content-[''] before:absolute before:-top-1 before:left-[calc(100%/3-1px)] before:size-1 before:bg-(--folder-back) before:content-[''] before:[clip-path:polygon(0_35%,0%_100%,50%_100%)]" />
      <div
        className={cn(
          LAYER,
          'bg-(--sheet-3) motion-safe:group-hover:[transform:rotateX(-20deg)] motion-safe:group-focus-visible:[transform:rotateX(-20deg)]',
        )}
      />
      <div
        className={cn(
          LAYER,
          'bg-(--sheet-2) motion-safe:group-hover:[transform:rotateX(-30deg)] motion-safe:group-focus-visible:[transform:rotateX(-30deg)]',
        )}
      />
      <div
        className={cn(
          LAYER,
          'bg-(--sheet-1) motion-safe:group-hover:[transform:rotateX(-38deg)] motion-safe:group-focus-visible:[transform:rotateX(-38deg)]',
        )}
      />
      {/* The front, its tab on the right and the notch where the tab meets it. */}
      <div className="absolute bottom-0 h-[97.5%] w-full origin-bottom rounded-md rounded-tr-none bg-linear-to-t from-(--folder-front) to-(--folder-light) transition-[transform,box-shadow] duration-300 ease-out group-hover:shadow-[inset_0_3px_6px_var(--folder-light),inset_0_-3px_6px_var(--folder-back)] group-focus-visible:shadow-[inset_0_3px_6px_var(--folder-light),inset_0_-3px_6px_var(--folder-back)] motion-safe:group-hover:[transform:rotateX(-46deg)_translateY(1px)] motion-safe:group-focus-visible:[transform:rotateX(-46deg)_translateY(1px)] after:absolute after:right-0 after:bottom-[99%] after:h-1 after:w-[61%] after:rounded-t-sm after:bg-(--folder-light) after:content-[''] before:absolute before:right-[calc(61%-1px)] before:-top-[3px] before:size-1 before:bg-(--folder-light) before:content-[''] before:[clip-path:polygon(100%_14%,50%_100%,100%_100%)]" />
    </div>
  )
}

/**
 * A pinned session's tile: two sheets behind a page that wears the session's
 * mark, fanning out as the folder's sheets do.
 */
export function DocumentTile({
  children,
  className,
}: {
  children?: ReactNode
  className?: string
}) {
  return (
    <div
      aria-hidden="true"
      data-document-tile=""
      className={cn(
        DOCUMENT_COLOURS,
        'relative mx-auto h-[21px] w-[17px] [perspective:1500px]',
        className,
      )}
    >
      <div className="absolute inset-0 origin-bottom rounded-sm bg-(--sheet-3) transition-transform duration-300 ease-out motion-safe:group-hover:[transform:rotate(-12deg)] motion-safe:group-focus-visible:[transform:rotate(-12deg)]" />
      <div className="absolute inset-0 origin-bottom rounded-sm bg-(--sheet-2) transition-transform duration-300 ease-out motion-safe:group-hover:[transform:rotate(-6deg)] motion-safe:group-focus-visible:[transform:rotate(-6deg)]" />
      {/* The page, its corner folded down. The shadow is a drop-shadow on the
          page's holder so the cut corner casts it too. */}
      <div className="absolute inset-0 origin-bottom drop-shadow-[0_0.5px_0.5px_rgba(0,0,0,.22)] transition-[transform,filter] duration-300 ease-out group-hover:drop-shadow-[0_3px_3px_rgba(0,0,0,.22)] group-focus-visible:drop-shadow-[0_3px_3px_rgba(0,0,0,.22)] motion-safe:group-hover:[transform:rotate(4deg)_translateY(-1px)] motion-safe:group-focus-visible:[transform:rotate(4deg)_translateY(-1px)]">
        <div className="flex size-full items-center justify-center rounded-sm bg-(--sheet-1) shadow-[inset_0_0_0_1px_var(--page-edge)] [clip-path:polygon(0_0,calc(100%-6px)_0,100%_6px,100%_100%,0_100%)]">
          {children}
        </div>
        <div className="absolute top-0 right-0 size-1.5 rounded-bl-[1px] bg-(--sheet-3) [clip-path:polygon(0_0,0_100%,100%_100%)]" />
      </div>
    </div>
  )
}
