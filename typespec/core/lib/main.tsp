import "../dist/src/index.js";

using TypeSpec.Reflection;

namespace PhaseLock;

/**
 * A Slice is one family of event streams and the state its reducer folds from them.  `Family`
 * names the streams: `"book"` is a single stream, and `"patron:{patron}"` or
 * `"chat:{org},{channel}"` is one stream per value of each parameter.  `Events` is the named union
 * of the event models the slice folds, and `Spec` lays out its state as key templates:
 *
 * ```typespec
 * interface PatronSlice extends Slice<"patron:{patron}", PatronEvents, {
 *   "patron": Patron;
 *   "patron_hold:{hold}": PatronHold;
 * }> {}
 * ```
 *
 * Key templates are local to one stream: the machinery owns the `{stream}!` prefix, so a
 * reducer names `patron_hold:{hold}` and never the patron it belongs to.  A template is a name,
 * then optionally ':' and its parameters separated by ','; the name identifies the item, and must
 * be unique among the slices composed together.
 */
interface Slice<Family extends string, Events, Spec extends {}> {}

/**
 * An Engine is one audience's view of the database: the slices it syncs and folds, and the
 * commands it may send.
 *
 * ```typespec
 * interface UserEngine extends Engine<[BookSlice, PatronSlice], UserCommands> {}
 * ```
 *
 * `Commands` is a named union of `@command` models, or a single one.
 */
interface Engine<Slices extends unknown[], Commands> {}

/**
 * A Database holds every slice its engines sync and decides every command they send, plus the
 * slices and commands it keeps for itself: slices no client syncs (credentials, uniqueness
 * indexes), and commands no engine sends.
 *
 * ```typespec
 * interface LibraryDB extends Database<[UserEngine, AdminEngine], [LoginSlice], DatabaseCommands> {}
 * ```
 */
interface Database<Engines extends unknown[], Slices extends unknown[] = [], Commands = never> {}

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

/**
 * Marks a model as a command and declares what its precommit handler returns, taken literally:
 * `@command(HoldOpened | HoldFailed)` returns exactly one of the two, a tuple returns each of its
 * members, and an array any number.  Each event is labelled with a stream of a slice that folds it.
 * A passthrough names its own type, `@command(AddBook)` on `AddBook`; `Death` ends the stream it
 * is labelled with.
 */
extern dec command(target: Model, output: unknown);

/**
 * Marks a command that only makes sense online: its UI waits for the database's answer instead of
 * a forecast, so it is sent once with `sendOnlineCommand` and never queued in the outbox.  A
 * command carrying a field the database prepares for precommit, such as a `NewPassword`, must be
 * `@online`.
 */
extern dec online(target: Model);

/** The end of a stream, in a `@command` output. */
model Death {}

// Fields the database prepares for precommit.  Each is a top-level field of an `@online`
// command, which the database replaces before precommit runs: a NewPassword with its
// PasswordHash, a CaptchaToken with its CaptchaResult, and so on.  No client can send a
// replacement, so no command carries one.

/** A password to store: precommit sees its salted hash. */
scalar NewPassword extends string;

/**
 * A password's salted hash, which the database puts in place of a NewPassword when it prepares a
 * command for precommit, and which bootstrap's `hashPassword` makes.
 */
scalar PasswordHash extends string;

/** A captcha widget's token, which the database verifies with the provider. */
scalar CaptchaToken extends string;

/**
 * A verified captcha token, which the database puts in place of a CaptchaToken when it prepares a
 * command for precommit.
 */
model CaptchaResult {
  hostname: string;
}

/** A proof of a credential the account has registered, for commands that re-authenticate. */
union CommandAuth {
  password: {
    kind: "password";
    password: string;
  },
  totp: {
    kind: "totp";
    code: string;
  },
  emailCode: {
    kind: "email-code";
    token: string;
    code: string;
  },
  webauthn: {
    kind: "webauthn";
    challenge: string;
    assertion: string;
  },
  yubikeyOtp: {
    kind: "yubikey-otp";
    otp: string;
  },
}

/**
 * The kind of credential a CommandAuth proved, which the database puts in its place when it
 * prepares a command for precommit.
 */
model CommandAuthResult {
  kind: "password" | "totp" | "email-code" | "webauthn" | "yubikey-otp";
}

/** An identity proven outside the database (an OAuth2 login, an email link), signed by it. */
scalar IdentityProof extends string;

/**
 * A verified identity proof, which the database puts in place of an IdentityProof when it
 * prepares a command for precommit.
 */
model IdentityResult {
  provider: string;
  subject: string;
  email?: string;
}
