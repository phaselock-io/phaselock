using TypeSpec.Reflection;

namespace PhaseLock;

/**
 * A Slice is one family of slices: each slice is the keys under one prefix, and a client holds a
 * slice completely or not at all.  `Family` names the slices: `"book"` is a single slice, and
 * `"patron:{patron}"` or `"chat:{org},{channel}"` is one slice per value of each parameter.  `Spec`
 * lays out each slice's keys as key templates:
 *
 * ```typespec
 * interface PatronSlice extends Slice<"patron:{patron}", {
 *   "patron": Patron;
 *   "patron_hold:{hold}": PatronHold;
 * }> {}
 * ```
 *
 * Key templates are local to one slice: a key is `{slice}!{local key}`, as in
 * `patron:bob!patron_hold:h1`.  A template is a name, then optionally ':' and its parameters
 * separated by ','; the name identifies the item, and must be unique among the slices composed
 * together.
 */
interface Slice<Family extends string, Spec extends {}> {}

/**
 * An Engine is one audience's view of the database: the slices it syncs, and the mutations it may
 * send.
 *
 * ```typespec
 * interface UserEngine extends Engine<[BookSlice, PatronSlice], UserMutations> {}
 * ```
 *
 * `Mutations` is a named union of models, or a single named model; each model it lists is a
 * mutation.
 */
interface Engine<Slices extends unknown[], Mutations> {}

/**
 * A Database holds every slice its engines sync and decides every mutation they send, plus the
 * slices and mutations it keeps for itself: slices no client syncs (credentials, uniqueness
 * indexes), and mutations no engine sends.
 *
 * ```typespec
 * interface LibraryDB extends Database<[UserEngine, AdminEngine], [LoginSlice], DbMutations> {}
 * ```
 */
interface Database<Engines extends unknown[], Slices extends unknown[] = [], Mutations = never> {}

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
 * Marks a mutation that only makes sense online: its UI waits for the database's answer instead of
 * a prediction, so it is sent once with `sendOnlineMutation` and never queued in the outbox.  A
 * mutation carrying a field the database prepares for its decider, such as a `NewPassword`, must
 * be `@online`.
 */
extern dec online(target: Model);

// Fields the database prepares for the decider.  Each is a top-level field of an `@online`
// mutation, which the database replaces before the decider runs: a NewPassword with its
// PasswordHash, a CaptchaToken with its CaptchaResult, and so on.  No client can send a
// replacement, so no mutation carries one.

/** A password to store: the decider sees its salted hash. */
scalar NewPassword extends string;

/**
 * A password's salted hash, which the database puts in place of a NewPassword when it prepares a
 * mutation for its decider, and which bootstrap's `hashPassword` makes.
 */
scalar PasswordHash extends string;

/** A captcha widget's token, which the database verifies with the provider. */
scalar CaptchaToken extends string;

/**
 * A verified captcha token, which the database puts in place of a CaptchaToken when it prepares a
 * mutation for its decider.
 */
model CaptchaResult {
  hostname: string;
}

/** A proof of a credential the account has registered, for mutations that re-authenticate. */
union MutationAuth {
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
 * The kind of credential a MutationAuth proved, which the database puts in its place when it
 * prepares a mutation for its decider.
 */
model MutationAuthResult {
  kind: "password" | "totp" | "email-code" | "webauthn" | "yubikey-otp";
}

/** An identity proven outside the database (an OAuth2 login, an email link), signed by it. */
scalar IdentityProof extends string;

/**
 * A verified identity proof, which the database puts in place of an IdentityProof when it
 * prepares a mutation for its decider.
 */
model IdentityResult {
  provider: string;
  subject: string;
  email?: string;
}
