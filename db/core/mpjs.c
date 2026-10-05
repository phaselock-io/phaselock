/* msgpack <-> plain JS values.  Values are the JSON projection: maps with
   string keys, arrays, strings, integers, floats, booleans, nil.  bin
   decodes to an ArrayBuffer and never encodes. */

#include <math.h>

#include "internal.h"

JSValue mpjs_decode_node(JSContext *ctx, mpack_node_t node) {
    switch (mpack_node_type(node)) {
    case mpack_type_nil:
        return JS_NULL;
    case mpack_type_bool:
        return JS_NewBool(ctx, mpack_node_bool(node));
    case mpack_type_int:
        return JS_NewInt64(ctx, mpack_node_i64(node));
    case mpack_type_uint: {
        uint64_t u = mpack_node_u64(node);
        if (u > (uint64_t)INT64_MAX) return JS_NewFloat64(ctx, (double)u);
        return JS_NewInt64(ctx, (int64_t)u);
    }
    case mpack_type_float:
        return JS_NewFloat64(ctx, mpack_node_float(node));
    case mpack_type_double:
        return JS_NewFloat64(ctx, mpack_node_double(node));
    case mpack_type_str:
        return JS_NewStringLen(ctx, mpack_node_str(node), mpack_node_strlen(node));
    case mpack_type_bin:
        return JS_NewArrayBufferCopy(ctx, (const uint8_t *)mpack_node_bin_data(node),
                                     mpack_node_bin_size(node));
    case mpack_type_array: {
        size_t n = mpack_node_array_length(node);
        JSValue arr = JS_NewArray(ctx);
        if (JS_IsException(arr)) return arr;
        for (size_t i = 0; i < n; i++) {
            JSValue v = mpjs_decode_node(ctx, mpack_node_array_at(node, i));
            if (JS_IsException(v)) {
                JS_FreeValue(ctx, arr);
                return v;
            }
            JS_DefinePropertyValueUint32(ctx, arr, (uint32_t)i, v, JS_PROP_C_W_E);
        }
        return arr;
    }
    case mpack_type_map: {
        size_t n = mpack_node_map_count(node);
        JSValue obj = JS_NewObject(ctx);
        if (JS_IsException(obj)) return obj;
        for (size_t i = 0; i < n; i++) {
            mpack_node_t k = mpack_node_map_key_at(node, i);
            if (mpack_node_type(k) != mpack_type_str) {
                JS_FreeValue(ctx, obj);
                return JS_ThrowTypeError(ctx, "msgpack map key is not a string");
            }
            JSValue v = mpjs_decode_node(ctx, mpack_node_map_value_at(node, i));
            if (JS_IsException(v)) {
                JS_FreeValue(ctx, obj);
                return v;
            }
            char key[512];
            size_t klen = mpack_node_strlen(k);
            if (klen >= sizeof key) {
                JS_FreeValue(ctx, v);
                JS_FreeValue(ctx, obj);
                return JS_ThrowTypeError(ctx, "msgpack map key too long");
            }
            memcpy(key, mpack_node_str(k), klen);
            key[klen] = 0;
            JS_DefinePropertyValueStr(ctx, obj, key, v, JS_PROP_C_W_E);
        }
        return obj;
    }
    default:
        return JS_ThrowTypeError(ctx, "unsupported msgpack type");
    }
}

JSValue mpjs_decode(JSContext *ctx, const uint8_t *data, size_t len) {
    mpack_tree_t tree;
    mpack_tree_init_data(&tree, (const char *)data, len);
    mpack_tree_parse(&tree);
    if (mpack_tree_error(&tree) != mpack_ok) {
        mpack_tree_destroy(&tree);
        return JS_ThrowTypeError(ctx, "invalid msgpack");
    }
    JSValue v = mpjs_decode_node(ctx, mpack_tree_root(&tree));
    mpack_tree_destroy(&tree);
    return v;
}

static int encode_value(JSContext *ctx, mpack_writer_t *w, JSValueConst v, int depth);

static int encode_array(JSContext *ctx, mpack_writer_t *w, JSValueConst v, int depth) {
    JSValue lenv = JS_GetPropertyStr(ctx, v, "length");
    int64_t n = 0;
    if (JS_ToInt64(ctx, &n, lenv)) {
        JS_FreeValue(ctx, lenv);
        return -1;
    }
    JS_FreeValue(ctx, lenv);
    mpack_start_array(w, (uint32_t)n);
    for (int64_t i = 0; i < n; i++) {
        JSValue item = JS_GetPropertyUint32(ctx, v, (uint32_t)i);
        if (JS_IsException(item)) return -1;
        if (JS_IsUndefined(item)) {
            mpack_write_nil(w);
        } else if (encode_value(ctx, w, item, depth + 1)) {
            JS_FreeValue(ctx, item);
            return -1;
        }
        JS_FreeValue(ctx, item);
    }
    mpack_finish_array(w);
    return 0;
}

static int encode_object(JSContext *ctx, mpack_writer_t *w, JSValueConst v, int depth) {
    JSPropertyEnum *tab = NULL;
    uint32_t n = 0;
    if (JS_GetOwnPropertyNames(ctx, &tab, &n, v, JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY))
        return -1;
    /* undefined values are skipped, so count first */
    JSValue *vals = xmalloc(sizeof(JSValue) * (n ? n : 1));
    uint32_t count = 0;
    int ret = 0;
    for (uint32_t i = 0; i < n; i++) {
        vals[i] = JS_GetProperty(ctx, v, tab[i].atom);
        if (JS_IsException(vals[i])) {
            for (uint32_t j = 0; j < i; j++) JS_FreeValue(ctx, vals[j]);
            JS_FreePropertyEnum(ctx, tab, n);
            free(vals);
            return -1;
        }
        if (!JS_IsUndefined(vals[i])) count++;
    }
    mpack_start_map(w, count);
    for (uint32_t i = 0; i < n && ret == 0; i++) {
        if (JS_IsUndefined(vals[i])) continue;
        const char *key = JS_AtomToCString(ctx, tab[i].atom);
        if (!key) {
            ret = -1;
            break;
        }
        mpack_write_cstr(w, key);
        JS_FreeCString(ctx, key);
        ret = encode_value(ctx, w, vals[i], depth + 1);
    }
    mpack_finish_map(w);
    for (uint32_t i = 0; i < n; i++) JS_FreeValue(ctx, vals[i]);
    JS_FreePropertyEnum(ctx, tab, n);
    free(vals);
    return ret;
}

static int encode_value(JSContext *ctx, mpack_writer_t *w, JSValueConst v, int depth) {
    if (depth > 64) {
        JS_ThrowTypeError(ctx, "value nested too deeply");
        return -1;
    }
    switch (JS_VALUE_GET_TAG(v)) {
    case JS_TAG_NULL:
    case JS_TAG_UNDEFINED:
        mpack_write_nil(w);
        return 0;
    case JS_TAG_BOOL:
        mpack_write_bool(w, JS_VALUE_GET_BOOL(v));
        return 0;
    case JS_TAG_INT:
        mpack_write_i64(w, JS_VALUE_GET_INT(v));
        return 0;
    case JS_TAG_FLOAT64: {
        double d = JS_VALUE_GET_FLOAT64(v);
        if (isfinite(d) && d == floor(d) && fabs(d) < 9007199254740992.0)
            mpack_write_i64(w, (int64_t)d);
        else
            mpack_write_double(w, d);
        return 0;
    }
    case JS_TAG_STRING: {
        size_t len;
        const char *s = JS_ToCStringLen(ctx, &len, v);
        if (!s) return -1;
        mpack_write_str(w, s, (uint32_t)len);
        JS_FreeCString(ctx, s);
        return 0;
    }
    case JS_TAG_OBJECT: {
        int isarr = JS_IsArray(ctx, v);
        if (isarr < 0) return -1;
        if (isarr) return encode_array(ctx, w, v, depth);
        size_t blen;
        uint8_t *bytes = JS_GetArrayBuffer(ctx, &blen, v);
        if (bytes) {
            mpack_write_bin(w, (const char *)bytes, (uint32_t)blen);
            return 0;
        }
        JS_FreeValue(ctx, JS_GetException(ctx)); /* not an ArrayBuffer */
        return encode_object(ctx, w, v, depth);
    }
    default:
        JS_ThrowTypeError(ctx, "value not encodable");
        return -1;
    }
}

int mpjs_encode(JSContext *ctx, JSValueConst v, buf *out) {
    char *data = NULL;
    size_t size = 0;
    mpack_writer_t w;
    mpack_writer_init_growable(&w, &data, &size);
    int ret = encode_value(ctx, &w, v, 0);
    if (mpack_writer_destroy(&w) != mpack_ok) {
        if (ret == 0) JS_ThrowTypeError(ctx, "msgpack encode failed");
        ret = -1;
    }
    if (ret == 0) buf_append(out, data, size);
    free(data);
    return ret;
}
