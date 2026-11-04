// Sessions: who a request speaks for, as a token the database signed at login.

package io.phaselock.client

import java.util.Base64

/** The database refused a login, or refused a session: its token was revoked, its account is
    gone, or it expired.  A session the database refused is ended for good, and the app signs in
    again. */
class AuthError(val status: Int, message: String) : Exception(message)

/** A signed-in user: the token the database signed, the user it names, and its expiry in seconds
    since the epoch.  A transport refreshes a session in place as it uses one, calling onRefresh
    after, which is the app's cue to save the new token; and sets ended once the database refuses
    it.  HttpTransport.login and Session.restore make them. */
class Session(token: String) {
    @Volatile var token: String = token
        internal set
    val user: String
    @Volatile var exp: Long
        internal set
    @Volatile var ended: Boolean = false
        internal set
    var onRefresh: ((Session) -> Unit)? = null

    init {
        val c = claims(token)
        user = c.sub
        exp = c.exp
    }

    companion object {
        /** a session from a token the app saved, without asking the database; refreshing it is
            what checks that the database still honors it */
        fun restore(token: String): Session = Session(token)
    }
}

/** a token's claims, read without verifying it, which only the database does */
internal data class Claims(val sub: String, val iat: Long, val exp: Long)

internal fun claims(token: String): Claims {
    val payload = token.split('.').getOrNull(1) ?: throw IllegalArgumentException("not a session token")
    val json = String(Base64.getUrlDecoder().decode(payload.trimEnd('=')), Charsets.UTF_8)
    val c = JsonReader(json).value() as? Map<*, *> ?: throw IllegalArgumentException("not a session token")
    val sub = c["sub"] as? String
    val iat = (c["iat"] as? Double)?.toLong()
    val exp = (c["exp"] as? Double)?.toLong()
    if (sub == null || iat == null || exp == null) throw IllegalArgumentException("not a session token")
    return Claims(sub, iat, exp)
}

/** A JSON reader for a token's claims: objects as Map, arrays as List, numbers as Double. */
private class JsonReader(private val s: String) {
    private var at = 0

    private fun ws() {
        while (at < s.length && s[at].isWhitespace()) at++
    }

    private fun fail(): Nothing = throw IllegalArgumentException("not a session token")

    private fun expect(c: Char) {
        ws()
        if (at >= s.length || s[at] != c) fail()
        at++
    }

    fun value(): Any? {
        ws()
        if (at >= s.length) fail()
        return when (s[at]) {
            '{' -> {
                at++
                val m = LinkedHashMap<String, Any?>()
                ws()
                if (s.getOrNull(at) == '}') { at++; return m }
                while (true) {
                    ws()
                    val k = string()
                    expect(':')
                    m[k] = value()
                    ws()
                    when (s.getOrNull(at++)) {
                        ',' -> continue
                        '}' -> return m
                        else -> fail()
                    }
                }
            }
            '[' -> {
                at++
                val l = ArrayList<Any?>()
                ws()
                if (s.getOrNull(at) == ']') { at++; return l }
                while (true) {
                    l.add(value())
                    ws()
                    when (s.getOrNull(at++)) {
                        ',' -> continue
                        ']' -> return l
                        else -> fail()
                    }
                }
            }
            '"' -> string()
            't' -> word("true", true)
            'f' -> word("false", false)
            'n' -> word("null", null)
            else -> {
                val start = at
                while (at < s.length && (s[at].isDigit() || s[at] in "+-.eE")) at++
                s.substring(start, at).toDoubleOrNull() ?: fail()
            }
        }
    }

    private fun word(w: String, v: Any?): Any? {
        if (!s.startsWith(w, at)) fail()
        at += w.length
        return v
    }

    private fun string(): String {
        if (s.getOrNull(at) != '"') fail()
        at++
        val out = StringBuilder()
        while (true) {
            val c = s.getOrNull(at++) ?: fail()
            when (c) {
                '"' -> return out.toString()
                '\\' -> when (val e = s.getOrNull(at++) ?: fail()) {
                    'n' -> out.append('\n')
                    't' -> out.append('\t')
                    'r' -> out.append('\r')
                    'b' -> out.append('\b')
                    'f' -> out.append('\u000c')
                    'u' -> {
                        out.append(s.substring(at, at + 4).toIntOrNull(16)?.toChar() ?: fail())
                        at += 4
                    }
                    else -> out.append(e)
                }
                else -> out.append(c)
            }
        }
    }
}
