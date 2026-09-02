import "../dist/src/index.js";

namespace PhaseLock;

/**
 * A Store defines the layout of key-value storage.  Keys are defined as template strings and values
 * have declared types.  For example:
 *
 * ```typespec
 * interface BookStore extends Store<{
 *   "edition.{edition_isbn}": Edition;
 *   "editions": Setx;
 * }> {}
 * ```
 *
 * `Spec` is a model whose property names are store key templates.  Each `{param}` in a
 * template becomes a typed accessor parameter in the generated store contexts, and the part
 * of the template before the first '.' names the item.
 *
 * `Deps` is a tuple of other Store interfaces whose items are all included in this store.  The
 * generated contexts reuse the dependency stores' accessors, so a reducer written against a
 * dependency also works against any store that includes it:
 *
 * ```typespec
 * interface LibraryStore extends Store<{
 *   "decider_events": DeciderEvents[];
 * }, [BookStore, PatronStore, StatusStore]> {}
 * ```
 */
interface Store<Spec extends {} = {}, Deps extends unknown[] = []> {}

/**
 * A concrete Engine definition, binding the three pieces a system component needs: the
 * events it consumes, the commands it may send, and the store its reducers read and write.
 * Code generation produces an Engine class (with typed reducer/query contexts, decoders, and
 * test helpers) for each declaration:
 *
 * ```typespec
 * interface RelayEngine extends Engine<LibraryEvents, RelayCommands, RelayStore> {}
 * ```
 *
 * `Events` and `Commands` are named unions; `S` is a Store interface.
 */
interface Engine<Events, Commands, S> {}

/**
 * A Queries interface declares a typed query contract: each operation names a query, with its
 * argument types and result type:
 *
 * ```typespec
 * interface AdminQueries extends Queries {
 *   allPatrons(): AdminPatronInfo[];
 *   patronsNamed(name: string, limit?: int32): AdminPatronInfo[];
 * }
 * ```
 *
 * Argument and result types are ordinary data types.  In the case of server-side queries, they will
 * cross the wire, so code generation produces structural checkers and decoders for them alongside
 * the typed query interfaces.
 */
interface Queries {}
