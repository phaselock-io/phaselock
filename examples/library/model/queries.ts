/* The queries the model declares, over what each Engine syncs.  An Engine syncs one room, so a
   query finds the room in the keys it scans. */

import type {
  AdminBookInfo,
  AdminEditionInfo,
  AdminEngineQueryTxn,
  AdminQueryDefs,
  Book,
  PatronHold,
  UserBookInfo,
  UserEngineQueryTxn,
  UserQueryDefs,
} from './model.gen';

// the books of an edition, in the order they were added
function booksOf(qx: UserEngineQueryTxn, room: string, isbn: string): Book[] {
  const books: Book[] = [];
  for (const { book } of qx.scan.edition_book({ room, isbn }, { keys: true })) {
    const b = qx.get.book(room, book);
    if (b !== undefined) books.push(b);
  }
  return books.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

/** a patron's queries; a patron's Engine syncs the catalogue and that patron alone */
export const userQueries: UserQueryDefs<UserEngineQueryTxn> = {
  // every edition, with how many copies the patron can hold and their own hold on it, if any
  allBooks(qx) {
    // the patron's holds, by what they target
    const byEdition = new Map<string, PatronHold>();
    const byBook = new Map<string, PatronHold>();
    for (const [, hold] of qx.scan.patron_hold()) {
      if ('edition' in hold.target) {
        byEdition.set(hold.target.edition, hold);
      } else {
        byBook.set(hold.target.book, hold);
      }
    }

    // each edition
    const out: UserBookInfo[] = [];
    for (const [{ room, isbn }, edition] of qx.scan.edition()) {
      let availableNormal = 0;
      const availableRestricted: string[] = [];
      let hold = byEdition.get(isbn) ?? null;
      for (const book of booksOf(qx, room, isbn)) {
        hold = byBook.get(book.id) ?? hold;
        if (book.status !== undefined) continue;
        if (book.restricted) {
          availableRestricted.push(book.id);
        } else {
          availableNormal++;
        }
      }

      // edition-level holds claim free unrestricted copies
      availableNormal -= [...qx.scan.edition_hold({ room, isbn }, { keys: true })].length;
      out.push({ isbn, title: edition.title, availableNormal, availableRestricted, hold });
    }
    return out.sort((a, b) => a.title.localeCompare(b.title));
  },

  // the patron's profile, which is empty until the patron is synced
  myPatron(qx) {
    for (const [{ room, patron }, p] of qx.scan.patron()) {
      return {
        name: p.name,
        color: p.color,
        researcher: p.researcher,
        holds: [...qx.scan.patron_hold({ room, patron })].map(([, hold]) => hold),
        checkouts: [...qx.scan.patron_checkout({ room, patron })].map(([, c]) => {
          const book = qx.get.book(room, c.book);
          const title = (book && qx.get.edition(room, book.isbn)?.title) ?? '';
          return { id: c.id, book: c.book, title, expires: c.expires, overdue: c.overdue };
        }),
      };
    }
    return { name: '', color: '', researcher: false, holds: [], checkouts: [] };
  },
};

/** the librarians' queries; their Engine syncs every patron */
export const adminQueries: AdminQueryDefs<AdminEngineQueryTxn> = {
  allPatronIds(qx) {
    return [...qx.scan.patron(undefined, { keys: true })].map(({ patron }) => patron);
  },

  allPatrons(qx) {
    return [...qx.scan.patron()].map(([, patron]) => patron);
  },

  // every edition and the state of each of its books, by title
  allEditions(qx) {
    // each edition
    const out: AdminEditionInfo[] = [];
    for (const [{ room, isbn }, edition] of qx.scan.edition()) {
      // edition-level holds are shown on the edition's first free unrestricted copies, oldest first
      const editionHolds = [...qx.scan.edition_hold({ room, isbn }, { keys: true })]
        .flatMap(({ hold }) => qx.get.hold(room, hold) ?? [])
        .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

      // each book
      const books: AdminBookInfo[] = [];
      for (const book of booksOf(qx, room, isbn)) {
        const info: AdminBookInfo = { id: book.id, restricted: book.restricted, state: 'open' };
        if (book.status !== undefined && 'hold' in book.status) {
          info.state = 'held';
          info.holdId = book.status.hold;
          info.patronId = qx.get.hold_owner(room, info.holdId);
          if (qx.get.hold(room, info.holdId)?.pending) info.pending = true;
        } else if (book.status !== undefined) {
          info.state = 'out';
          info.checkoutId = book.status.checkout;
          info.patronId = qx.get.checkout_owner(room, info.checkoutId);
          if (qx.get.checkout(room, info.checkoutId)?.pending) info.pending = true;
        } else if (!book.restricted && editionHolds.length > 0) {
          const hold = editionHolds.shift()!;
          info.state = 'held';
          info.holdId = hold.id;
          info.patronId = qx.get.hold_owner(room, hold.id);
          if (hold.pending) info.pending = true;
        } else if (book.restricted) {
          info.state = 'restricted';
        }
        books.push(info);
      }
      out.push({ isbn, title: edition.title, books });
    }
    return out.sort((a, b) => a.title.localeCompare(b.title));
  },
};
