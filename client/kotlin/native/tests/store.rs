//! The LMDB store against the skeleton's contracts: the scan conformance fixture every store
//! walks identically, and the store's conversions and applies, driven through the natives as
//! the host's Store calls them.

use phaselock_jni::host::{Host, Limits};
use serde_json::{Value, json};

const BUNDLE: &str =
    concat!(env!("CARGO_MANIFEST_DIR"), "/../../../examples/library/model/native.dev.bundle.js");
const FIXTURE: &str =
    concat!(env!("CARGO_MANIFEST_DIR"), "/../../../typespec/tests/fixtures/scan-conformance.json");

/// a host with the library's bundle loaded, and an LMDB store under id 1 in a fresh directory
fn host() -> (Host, tempfile::TempDir) {
    let bundle = std::fs::read(BUNDLE).unwrap_or_else(|e| panic!("{BUNDLE}: {e}"));
    let h = Host::open(&bundle, "native.dev.bundle.js", Limits::default()).unwrap();
    let dir = tempfile::tempdir().unwrap();
    h.open_store(1, &dir.path().display().to_string()).unwrap();
    (h, dir)
}

fn eval(h: &Host, js: &str) -> Value {
    let out = h.eval_json(js).unwrap_or_else(|e| panic!("{e}"));
    serde_json::from_str(&out).unwrap()
}

#[test]
fn every_conformance_case_walks_as_the_fixture_says() {
    let fixture: Value = serde_json::from_str(&std::fs::read_to_string(FIXTURE).unwrap()).unwrap();
    let (h, _dir) = host();

    // every key, then every case in both directions and at several batch sizes; any walk that
    // differs from the fixture comes back
    let js = format!(
        r#"(() => {{
          const fx = {fixture};
          const reg = __pl.registry({{ nodes: [["str"]], ids: {{ s: 0 }}, mutations: null }});
          let t = __pl.begin(1, reg, true);
          for (const k of fx.keys) __pl.set(t, k, 's', 1, k);
          __pl.commit(t);
          const wrong = [];
          for (const c of fx.cases) {{
            for (const reverse of [false, true]) {{
              for (const limit of [1, 2, 7, 1000]) {{
                const t = __pl.begin(1, reg, false);
                const got = [];
                let after;
                for (;;) {{
                  const r = __pl.scan(t, {{ pattern: c.pattern, limit, after, reverse, values: false }});
                  for (const [k] of r.entries) got.push(k);
                  if (r.next === null) break;
                  after = r.next;
                }}
                __pl.abort(t);
                const want = reverse ? [...c.expect].reverse() : c.expect;
                if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push({{ name: c.name, reverse, limit, got }});
              }}
            }}
          }}
          return wrong;
        }})()"#
    );
    let wrong = eval(&h, &js);
    assert_eq!(wrong, json!([]), "walks that differ from the fixture");
}

#[test]
fn values_convert_under_their_type_and_reserved_identities_round_trip() {
    let (h, _dir) = host();

    // the library's own registry, which an engine builds through its transport
    let out = eval(
        &h,
        r#"(() => {
          let reg;
          const transport = { buildRegistry: (s) => { reg = __pl.registry(s); return { id: reg, mutations: s.mutations, convert: () => {}, ops: () => [] }; },
                              connect: () => ({ backfill: () => new Promise(() => {}), sendMutations: () => new Promise(() => {}) }), post: () => {} };
          const ac = new AbortController();
          globalThis.__engines.UserEngine.create(transport, { session: null, signal: ac.signal, onError: () => {} });
          ac.abort();
          const t = __pl.begin(1, reg, true);
          const patron = { id: 'p1', name: 'Ann', color: '#123456', researcher: false, extra: 1 };
          __pl.set(t, 'patron:r,p1!patron', 'Patron', 1, patron);
          __pl.set(t, '!view', '.json', 1, { token: 'tk', position: 4, selectors: ['book:r'] });
          __pl.set(t, '!mutation:00000000000000000001', '.mutation', 1,
                   { id: 'm1', series: 's1', n: 3, data: new Uint8Array([0x81, 0xa1, 0x61, 0x01]) });
          const bytes = __pl.get(t, 'patron:r,p1!patron', 'Patron', 3);
          const got = {
            patron: __pl.get(t, 'patron:r,p1!patron', 'Patron', 1),
            bytes: Array.from(bytes),
            view: __pl.get(t, '!view', '.json', 1),
            mutation: (() => { const m = __pl.get(t, '!mutation:00000000000000000001', '.mutation', 1); return { ...m, data: Array.from(m.data) }; })(),
            missing: __pl.get(t, 'patron:r,p2!patron', 'Patron', 1) === undefined,
          };
          __pl.commit(t);
          return got;
        })()"#,
    );
    assert_eq!(
        out["patron"],
        json!({ "id": "p1", "name": "Ann", "color": "#123456", "researcher": false })
    );
    assert_eq!(out["view"], json!({ "token": "tk", "position": 4, "selectors": ["book:r"] }));
    assert_eq!(
        out["mutation"],
        json!({ "id": "m1", "series": "s1", "n": 3, "data": [0x81, 0xa1, 0x61, 0x01] })
    );
    assert_eq!(out["missing"], json!(true));
    assert_eq!(out["bytes"][0], json!(0x84), "a struct of four fields, the unnamed one dropped");
}
